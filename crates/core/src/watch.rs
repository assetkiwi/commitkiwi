//! File watcher for one repo (M8): native events (FSEvents on macOS, inotify on Linux) instead of status polling.
//! Watches the worktree minus ignored/heavy folders plus the `.git` essentials, coalesces bursts, and reports
//! what changed. When it cannot watch (folder cap, inotify limit, old git) the caller falls back to polling.
use commitkiwi_protocol::Change;
use notify::{EventKind, RecursiveMode, Watcher as _};
use std::collections::HashSet;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

/// Folders never watched, by name (dependency/build caches: huge and churny).
const SKIP: [&str; 4] = ["node_modules", "vendor", ".cache", "target"];
/// More folders than this: poll instead (inotify needs one watch per folder).
pub const MAX_DIRS: usize = 8000;
/// Quiet time that ends a burst, and the longest a burst is held back.
const QUIET: Duration = Duration::from_millis(200);
const MAX_WAIT: Duration = Duration::from_secs(1);
/// More changed paths than this in one burst: skip the ignore check, just refresh.
const CHECK_MAX: usize = 2000;

pub type OnChange = Box<dyn Fn(Change) + Send + 'static>;

/// Watching stops when this is dropped.
pub struct Watcher {
    _inner: Arc<Mutex<notify::RecommendedWatcher>>,
}

struct Paths {
    repo: String,
    root: PathBuf,
    git_dirs: Vec<PathBuf>, // git dir, plus the common dir for a linked worktree
    ignored: HashSet<PathBuf>,
    watched: usize,
    cap: usize,
}

/// Start watching `repo`. Err = why not (the caller polls instead).
pub fn watch(repo: &str, on: OnChange) -> Result<Watcher, String> {
    watch_capped(repo, MAX_DIRS, on)
}

/// [`watch`] with a folder cap (tests use a small one).
pub fn watch_capped(repo: &str, cap: usize, on: OnChange) -> Result<Watcher, String> {
    let out = crate::git(repo, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"])?;
    let mut lines = out.lines().map(|l| std::fs::canonicalize(l).map_err(|e| format!("{l}: {e}")));
    let (Some(root), Some(git_dir), Some(common)) = (lines.next(), lines.next(), lines.next()) else {
        return Err("git rev-parse gave no paths (git older than 2.31?)".into());
    };
    let (root, git_dir, common) = (root?, git_dir?, common?);
    let mut git_dirs = vec![git_dir];
    if common != git_dirs[0] {
        git_dirs.push(common);
    }
    let mut p = Paths { repo: repo.to_string(), root: root.clone(), git_dirs, ignored: ignored_dirs(&root), watched: 0, cap };

    let (tx, rx) = channel();
    let inner = Arc::new(Mutex::new(notify::recommended_watcher(tx).map_err(reason)?));
    {
        let mut w = inner.lock().unwrap_or_else(|e| e.into_inner());
        let dirs = p.walk(&root)?;
        if cfg!(target_os = "linux") {
            // inotify: one watch per folder, so ignored folders cost nothing
            for d in &dirs {
                add(&mut w, d, RecursiveMode::NonRecursive)?;
            }
            for g in p.git_dirs.clone() {
                add(&mut w, &g, RecursiveMode::NonRecursive)?;
                for d in walk_all(&g.join("refs"), cap)? {
                    add(&mut w, &d, RecursiveMode::NonRecursive)?;
                }
            }
        } else {
            // FSEvents: one stream per tree; events from skipped folders are dropped below
            add(&mut w, &root, RecursiveMode::Recursive)?;
            for g in p.git_dirs.clone().iter().filter(|g| !g.starts_with(&root)) {
                add(&mut w, g, RecursiveMode::Recursive)?;
            }
        }
    }
    let weak = Arc::downgrade(&inner);
    std::thread::spawn(move || run(rx, weak, &mut p, on));
    Ok(Watcher { _inner: inner })
}

fn reason(e: notify::Error) -> String {
    match e.kind {
        notify::ErrorKind::MaxFilesWatch => "inotify watch limit reached (fs.inotify.max_user_watches)".into(),
        _ => format!("file watcher: {e}"),
    }
}

fn add(w: &mut notify::RecommendedWatcher, d: &Path, mode: RecursiveMode) -> Result<(), String> {
    match w.watch(d, mode) {
        Ok(()) => Ok(()),
        // a folder that vanished during the walk is not an error
        Err(e) if matches!(&e.kind, notify::ErrorKind::PathNotFound) => Ok(()),
        Err(e) if matches!(&e.kind, notify::ErrorKind::Io(io) if io.kind() == std::io::ErrorKind::NotFound) => Ok(()),
        Err(e) => Err(reason(e)),
    }
}

/// Folders git ignores (collapsed: `--directory` does not descend into them), absolute.
fn ignored_dirs(root: &Path) -> HashSet<PathBuf> {
    let out = crate::git(&root.to_string_lossy(), &["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]).unwrap_or_default();
    out.split('\0').filter_map(|e| e.strip_suffix('/')).map(|d| root.join(d)).collect()
}

/// Every folder below `top` (not following symlinks), capped.
fn walk_all(top: &Path, cap: usize) -> Result<Vec<PathBuf>, String> {
    let mut out = vec![];
    let mut todo = vec![top.to_path_buf()];
    while let Some(d) = todo.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        out.push(d);
        if out.len() > cap {
            return Err(format!("more than {cap} folders"));
        }
        todo.extend(rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()));
    }
    Ok(out)
}

impl Paths {
    fn skipped(&self, d: &Path) -> bool {
        d.file_name().is_some_and(|n| n == ".git" || SKIP.iter().any(|s| n == *s)) || self.ignored.contains(d)
    }

    /// Worktree folders to watch below (and including) `top`; counts them against the cap.
    fn walk(&mut self, top: &Path) -> Result<Vec<PathBuf>, String> {
        let mut out = vec![];
        let mut todo = vec![top.to_path_buf()];
        while let Some(d) = todo.pop() {
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            out.push(d);
            self.watched += 1;
            if self.watched > self.cap {
                return Err(format!("more than {} folders", self.cap));
            }
            for e in rd.flatten() {
                if e.file_type().is_ok_and(|t| t.is_dir()) && !self.skipped(&e.path()) {
                    todo.push(e.path());
                }
            }
        }
        Ok(out)
    }

    /// What a changed path means: Some(true) = refs (and status), Some(false) = worktree (check ignores), None = noise.
    fn classify(&self, p: &Path) -> Option<bool> {
        for g in &self.git_dirs {
            if let Ok(rel) = p.strip_prefix(g) {
                let first = rel.components().next()?.as_os_str().to_str()?;
                if p.extension().is_some_and(|e| e == "lock") {
                    return None; // the rename to the real name follows
                }
                return match first {
                    "HEAD" | "packed-refs" | "refs" | "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "REBASE_HEAD"
                    | "rebase-merge" | "rebase-apply" | "sequencer" => Some(true),
                    "index" => Some(false),
                    _ => None, // objects, logs, lfs, FETCH_HEAD, config, ...
                };
            }
        }
        let rel = p.strip_prefix(&self.root).ok()?;
        let mut dir = self.root.clone();
        for c in rel.components() {
            dir.push(c);
            if self.skipped(&dir) {
                return None;
            }
        }
        Some(false)
    }
}

/// Of `paths` (inside the worktree), the ones git does not ignore (one `git check-ignore` for the whole burst).
fn not_ignored(root: &Path, paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let rel: Vec<&Path> = paths.iter().filter_map(|p| p.strip_prefix(root).ok()).filter(|r| !r.as_os_str().is_empty()).collect();
    if rel.is_empty() {
        return paths; // only the root itself changed
    }
    let child = crate::git_cmd(&root.to_string_lossy(), true)
        .args(["check-ignore", "-z", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return paths };
    if let Some(mut w) = child.stdin.take() {
        let mut buf = Vec::new();
        for r in &rel {
            buf.extend_from_slice(r.as_os_str().as_bytes());
            buf.push(0);
        }
        let _ = w.write_all(&buf);
    }
    let Ok(out) = child.wait_with_output() else { return paths };
    if !matches!(out.status.code(), Some(0 | 1)) {
        return paths; // could not tell: refresh rather than miss a change
    }
    let ignored: HashSet<&[u8]> = out.stdout.split(|&b| b == 0).filter(|s| !s.is_empty()).collect();
    paths.into_iter().filter(|p| p.strip_prefix(root).map_or(true, |r| !ignored.contains(r.as_os_str().as_bytes()))).collect()
}

fn run(rx: Receiver<notify::Result<notify::Event>>, w: Weak<Mutex<notify::RecommendedWatcher>>, p: &mut Paths, on: OnChange) {
    // Blocks while nothing happens: an idle repo costs no wakeups.
    while let Ok(first) = rx.recv() {
        let start = Instant::now();
        let mut batch = vec![first];
        // until QUIET passes without an event, or MAX_WAIT since the first one
        while let Some(left) = MAX_WAIT.checked_sub(start.elapsed()) {
            match rx.recv_timeout(left.min(QUIET)) {
                Ok(e) => batch.push(e),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let (mut refs, mut work, mut fallback) = (false, false, None);
        let mut paths = Vec::new();
        for e in batch {
            match e {
                Err(e) => fallback = Some(reason(e)),
                Ok(e) if e.need_rescan() || matches!(e.kind, EventKind::Other) && e.paths.is_empty() => (refs, work) = (true, true),
                Ok(e) if matches!(e.kind, EventKind::Access(_)) => {}
                Ok(e) => {
                    for path in e.paths {
                        match p.classify(&path) {
                            Some(true) => refs = true,
                            Some(false) if path.starts_with(&p.root) && !p.git_dirs.iter().any(|g| path.starts_with(g)) => paths.push(path),
                            Some(false) => work = true, // the index
                            None => {}
                        }
                    }
                }
            }
        }
        paths.sort();
        paths.dedup();
        if !paths.is_empty() {
            let live = if paths.len() > CHECK_MAX { paths } else {
                let keep = not_ignored(&p.root, paths.clone());
                // remember ignored folders so their churn is dropped without asking git again
                for d in paths.into_iter().filter(|d| !keep.contains(d) && d.is_dir()) {
                    p.ignored.insert(d);
                }
                keep
            };
            work |= !live.is_empty();
            if cfg!(target_os = "linux") && fallback.is_none() {
                // new folders: watch them (and whatever was created inside before the watch landed)
                if let Some(w) = w.upgrade() {
                    let mut w = w.lock().unwrap_or_else(|e| e.into_inner());
                    let new: Vec<&PathBuf> = live.iter().filter(|d| d.is_dir() && !p.skipped(d)).collect();
                    for d in new {
                        let added = p.walk(d).and_then(|ds| ds.iter().try_for_each(|x| add(&mut w, x, RecursiveMode::NonRecursive)));
                        if let Err(e) = added {
                            fallback = Some(e);
                            break;
                        }
                    }
                }
            }
        }
        if cfg!(target_os = "linux") && refs && fallback.is_none() {
            // a new refs/heads/<folder>/: watch it
            if let Some(w) = w.upgrade() {
                let mut w = w.lock().unwrap_or_else(|e| e.into_inner());
                for g in &p.git_dirs {
                    if let Ok(ds) = walk_all(&g.join("refs"), p.cap) {
                        ds.iter().for_each(|d| { let _ = w.watch(d, RecursiveMode::NonRecursive); });
                    }
                }
            }
        }
        if w.strong_count() == 0 {
            return; // unwatched meanwhile
        }
        if let Some(reason) = fallback {
            on(Change { repo: p.repo.clone(), refs: true, work: true, polling: Some(reason) });
            return;
        }
        if refs || work {
            on(Change { repo: p.repo.clone(), refs, work: work || refs, polling: None });
        }
    }
}

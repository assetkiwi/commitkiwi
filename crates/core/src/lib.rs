//! Git operations. One entry point, [`handle`], used in-process by the app and by the remote agent,
//! so local and remote repos behave identically.
//!
//! Reads shell out to the `git` CLI (exact git behaviour, user config and hooks respected).
//! shortcut: log goes through `git log`, not gix; switch the hot path to gix if the perf budget
//! (100k commits < 300 ms to first page) is missed.
use commitkiwi_protocol::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex};

mod cleanup;
mod forge;
mod rebase;
pub mod watch;

const MAX_PAGE: u32 = 2000;
const MAX_STATS: usize = 200;
const PATCH_LIMIT: usize = 4 << 20;
const BLOB_LIMIT: usize = 1 << 20;
const IMAGE_LIMIT: usize = 8 << 20;
const MAX_CONTEXT: u32 = 100;
const FIELD: char = '\x1f';
const RECORD: char = '\x1e';
/// Every ref and HEAD, except the stash (its hidden WIP/index commits), notes and the refs the user hid: what the commit list shows.
fn revs(hidden: &[String]) -> Result<Vec<String>, String> {
    let mut v = vec!["--exclude=refs/stash".to_string(), "--exclude=refs/notes/*".to_string()];
    for r in hidden {
        // ref names can't contain glob characters, so a valid one only ever excludes itself
        if !r.starts_with("refs/") || r.contains(['\0', '\n', '*', '?', '[', '\\']) {
            return Err(format!("bad ref name: {r:?}"));
        }
        v.push(format!("--exclude={r}"));
    }
    // not `--all`: that also keeps every other worktree's HEAD, so a branch checked out there could never be hidden
    v.extend(["--glob=refs/*".into(), "--ignore-missing".into(), "HEAD".into()]);
    Ok(v)
}

/// `base` followed by the revs, as the `&[&str]` that `git` takes.
fn with_revs<'a>(base: &[&'a str], revs: &'a [String]) -> Vec<&'a str> {
    base.iter().copied().chain(revs.iter().map(String::as_str)).collect()
}

pub fn handle(req: Req) -> Resp {
    handle_with(req, None)
}

/// Where a job's git output goes as it arrives (the console's output pane).
pub type Sink = Arc<dyn Fn(&str) + Send + Sync>;

/// [`handle`], with `sink` receiving the output of a `Req::Job`.
pub fn handle_with(req: Req, sink: Option<Sink>) -> Resp {
    let r = match req {
        Req::Job { job, req } => run_job(job, *req, sink),
        Req::Cancel { job } => {
            cancel(job);
            Ok(Resp::Done)
        }
        req => {
            // one read request = one look at each repo's config (Status runs 3 git commands); the next request
            // reads it again, so a hook added meanwhile is still caught on the next call
            READ_CONFIG.with(|c| *c.borrow_mut() = Some(HashMap::new()));
            let r = run(req);
            READ_CONFIG.with(|c| *c.borrow_mut() = None);
            r
        }
    };
    r.unwrap_or_else(Resp::Err)
}

pub const CANCELLED: &str = "Cancelled";

/// A job's cancel state: `pgid` is the process group of its running git (hooks and ssh run inside it).
#[derive(Default)]
struct JobSlot {
    cancelled: bool,
    pgid: Option<i32>,
}

/// Jobs running in this process. shortcut: a Cancel for a job that already finished leaves a tiny tombstone here
/// (its id is never reused); fine for one session's console.
static JOBS: LazyLock<Mutex<HashMap<u64, JobSlot>>> = LazyLock::new(Default::default);

thread_local! {
    /// The job this thread is running (set by `run_job`): `git_out` registers its process under it and streams to the sink.
    static JOB: RefCell<Option<(u64, Option<Sink>)>> = const { RefCell::new(None) };
    /// While a non-job request runs on this thread: the read overrides per repo dir, so its git calls share one
    /// `git config` (see `git_cmd`). Writes and jobs never use it.
    static READ_CONFIG: RefCell<Option<HashMap<String, Vec<String>>>> = const { RefCell::new(None) };
}

fn jobs() -> std::sync::MutexGuard<'static, HashMap<u64, JobSlot>> {
    JOBS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Kill job `job`'s running git with its process group, or mark it so it never starts one.
pub fn cancel(job: u64) {
    let mut jobs = jobs();
    let slot = jobs.entry(job).or_default();
    slot.cancelled = true;
    if let Some(pg) = slot.pgid {
        // SIGTERM: git removes its lock files on the way out
        unsafe { libc::kill(-pg, libc::SIGTERM) };
    }
}

/// Requests that can move HEAD or refs: their job reply records what moved (for Undo).
fn moves_refs(req: &Req) -> Option<&str> {
    match req {
        Req::Commit { repo, .. } | Req::Stash { repo, .. } | Req::PopStash { repo } | Req::Pull { repo, .. } | Req::Fetch { repo, .. }
        | Req::Push { repo, .. } | Req::Checkout { repo, .. } | Req::AbortMerge { repo } | Req::AddWorktree { repo, .. }
        | Req::CreateBranch { repo, .. } | Req::RenameBranch { repo, .. } | Req::DeleteBranch { repo, .. } | Req::DeleteRemoteBranch { repo, .. }
        | Req::Merge { repo, .. } | Req::Rebase { repo, .. } | Req::CherryPick { repo, .. } | Req::Revert { repo, .. } | Req::Reset { repo, .. }
        | Req::CreateTag { repo, .. } | Req::DeleteTag { repo, .. } | Req::PushTag { repo, .. } | Req::DeleteRemoteTag { repo, .. }
        | Req::Sequence { repo, .. } | Req::Undo { repo, check: false, .. } | Req::RenameRemote { repo, .. } | Req::DeleteRemote { repo, .. }
        | Req::StashOp { repo, .. } | Req::Rewrite { repo, .. } | Req::GitCustom { repo, .. } | Req::DeleteBranches { repo, .. }
        | Req::DeleteRemoteBranches { repo, .. } | Req::InteractiveRebase { repo, .. } => Some(repo),
        _ => None,
    }
}

fn run_job(job: u64, req: Req, sink: Option<Sink>) -> Result<Resp, String> {
    if matches!(req, Req::Job { .. } | Req::Cancel { .. }) {
        return Err("a job cannot wrap another job".into());
    }
    if std::mem::take(&mut jobs().entry(job).or_default().cancelled) {
        jobs().remove(&job);
        return Err(CANCELLED.into());
    }
    let repo = moves_refs(&req).map(str::to_string);
    let before = repo.as_deref().map(snapshot);
    JOB.with(|j| *j.borrow_mut() = Some((job, sink)));
    let r = run(req);
    JOB.with(|j| *j.borrow_mut() = None);
    let cancelled = jobs().remove(&job).is_some_and(|s| s.cancelled);
    match (r, before, repo) {
        (Err(_), ..) if cancelled => Err(CANCELLED.into()),
        (Ok(Resp::Done), Some(Ok(before)), Some(repo)) => Ok(match snapshot(&repo) {
            Ok(after) => Resp::Moved(moved(before, after)),
            Err(_) => Resp::Done, // it ran; only the record is missing
        }),
        (r, ..) => r,
    }
}

type Snapshot = (Head, HashMap<String, String>);

fn snapshot(repo: &str) -> Result<Snapshot, String> {
    let refs = git(repo, &["for-each-ref", "--format=%(refname) %(objectname)"])?;
    let refs = refs.lines().filter_map(|l| l.split_once(' ')).map(|(n, o)| (n.to_string(), o.to_string())).collect();
    let line = |args: &[&str]| git(repo, args).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let head = Head { branch: line(&["symbolic-ref", "-q", "HEAD"]), oid: line(&["rev-parse", "-q", "--verify", "HEAD"]) };
    Ok((head, refs))
}

fn moved((head_before, mut old): Snapshot, (head_after, new): Snapshot) -> Moved {
    let mut refs: Vec<RefMove> = new
        .into_iter()
        .filter_map(|(name, after)| {
            let before = old.remove(&name);
            (before.as_ref() != Some(&after)).then_some(RefMove { name, before, after: Some(after) })
        })
        .collect();
    refs.extend(old.into_iter().map(|(name, before)| RefMove { name, before: Some(before), after: None }));
    refs.sort_by(|a, b| a.name.cmp(&b.name));
    Moved { head_before, head_after, refs }
}

fn done(r: Result<(), String>) -> Result<Resp, String> {
    r.map(|()| Resp::Done)
}

fn run(req: Req) -> Result<Resp, String> {
    Ok(match req {
        Req::Job { .. } | Req::Cancel { .. } => return Err("a job cannot wrap another job".into()),
        Req::Hello => Resp::Hello { proto: PROTO_VERSION },
        Req::Open { path } => Resp::Repo(open(&path)?),
        Req::Refs { repo } => Resp::Refs(refs(&repo)?),
        Req::Count { repo, hidden } => Resp::Count(count(&repo, &revs(&hidden)?)?),
        Req::Log { repo, skip, limit, hidden } => Resp::Log(log(&repo, skip, limit.min(MAX_PAGE), &revs(&hidden)?)?),
        Req::Stats { repo, oids } => Resp::Stats(stats(&repo, &oids)?),
        Req::Graph { repo, hidden } => Resp::Graph(graph(&repo, &revs(&hidden)?)?),
        Req::Locate { repo, oid, hidden } => Resp::Locate(locate(&repo, &oid, &revs(&hidden)?)?),
        Req::Show { repo, oid, from } => Resp::Show(show(&repo, &oid, from.as_deref())?),
        Req::Diff { repo, oid, path, old_path, context, ignore_ws, from } => {
            Resp::Diff(diff(&repo, &oid, &path, old_path.as_deref(), (context, ignore_ws), from.as_deref())?)
        }
        Req::LineLog { repo, oid, path, start, end, limit } => Resp::Log(line_log(&repo, &oid, &path, start, end, limit.min(MAX_PAGE))?),
        Req::Image { repo, rev, path } => Resp::Image(image(&repo, &rev, &path)?),
        Req::Tree { repo, oid, path } => Resp::Tree(tree(&repo, &oid, &path)?),
        Req::Blob { repo, oid, path } => {
            check_oid(&oid)?;
            Resp::Blob(blob(&repo, &oid, &path)?)
        }
        Req::ReadFile { repo, rev, path } => Resp::Blob(blob(&repo, &rev, &path)?),
        Req::Files { repo, oid } => Resp::Files(files(&repo, &oid)?),
        Req::FileLog { repo, oid, path, skip, limit } => Resp::Log(file_log(&repo, &oid, &path, skip, limit.min(MAX_PAGE))?),
        Req::Blame { repo, oid, path } => Resp::Blame(blame(&repo, &oid, &path)?),
        Req::Status { repo } => Resp::Status(status(&repo)?),
        Req::WorkDiff { repo, path, old_path, staged, untracked, conflicted, context, ignore_ws } => {
            Resp::Diff(work_diff(&repo, &path, old_path.as_deref(), (staged, untracked, conflicted), (context, ignore_ws))?)
        }
        Req::Stage { repo, paths } => done(git_paths(&repo, &["--literal-pathspecs", "add", "-A"], &paths))?,
        Req::Unstage { repo, paths } => done(unstage(&repo, &paths))?,
        Req::Discard { repo, paths } => done(discard(&repo, &paths))?,
        Req::Apply { repo, patch, mode } => done(apply(&repo, &patch, mode))?,
        Req::Commit { repo, message, amend, signoff, no_verify } => done(commit(&repo, &message, amend, signoff, no_verify))?,
        Req::Identity { repo } => Resp::Identity(identity(&repo)),
        Req::SetIdentity { repo, name, email } => done(set_identity(&repo, &name, &email))?,
        Req::AbortMerge { repo } => done(git_out(&repo, &["merge", "--abort"]).map(|_| ()))?,
        Req::Resolve { repo, path, theirs } => done(resolve(&repo, &path, theirs))?,
        Req::Ignore { repo, path } => done(ignore(&repo, &path))?,
        Req::Stash { repo, flags } => done(git_flags(&repo, &["stash", "push"], &flags, &["--include-untracked", "--keep-index", "--staged"], &[]))?,
        // --progress: git only reports transfer progress to a terminal unless asked; the console streams it
        Req::Pull { repo, flags } => done(git_flags(&repo, &["pull", "--progress"], &flags, &["--ff-only", "--rebase", "--autostash"], &[]))?,
        Req::Fetch { repo, flags, remote } => {
            let tail = match &remote {
                Some(r) => vec!["--", remote_name(&repo, r)?],
                None => vec![],
            };
            done(git_flags(&repo, &["fetch", "--progress"], &flags, &["--tags", "--prune"], &tail))?
        }
        Req::Push { repo, flags, remote, branch } => done(push(&repo, &flags, remote.as_deref(), branch.as_deref()))?,
        Req::PopStash { repo } => done(git_out(&repo, &["stash", "pop"]).map(|_| ()))?,
        Req::Checkout { repo, name } => done(checkout(&repo, &name))?,
        Req::AddWorktree { repo, path, branch } => done(add_worktree(&repo, &path, branch.as_deref()))?,
        Req::AddSubmodule { repo, url, path } => done(add_submodule(&repo, &url, path.as_deref()))?,
        Req::UpdateSubmodules { repo, init, path } => {
            let mut args = vec!["submodule", "update"];
            if init {
                args.push("--init");
            }
            args.push("--recursive");
            done(git_out(&repo, &with_submodule(&repo, args, path.as_deref())?).map(|_| ()))?
        }
        Req::SyncSubmodules { repo, path } => done(git_out(&repo, &with_submodule(&repo, vec!["submodule", "sync", "--recursive"], path.as_deref())?).map(|_| ()))?,
        Req::ScanRepos { root, depth } => Resp::Scan(scan_repos(&root, depth)?),
        Req::Search { repo, query, hidden, limit } => Resp::Search(search(&repo, &query, limit, &revs(&hidden)?)?),
        Req::CreateBranch { repo, name, from, checkout } => done(create_branch(&repo, &name, from.as_deref(), checkout))?,
        Req::RenameBranch { repo, branch, name } => {
            let (old, new) = (local_branch(&repo, &branch)?, ref_name(&repo, "refs/heads/", &name)?);
            done(git_out(&repo, &["branch", "-m", "--", old, new]).map(|_| ()))?
        }
        Req::DeleteBranch { repo, branch, force } => {
            let b = local_branch(&repo, &branch)?;
            done(git_out(&repo, &["branch", if force { "-D" } else { "-d" }, "--", b]).map(|_| ()))?
        }
        Req::DeleteRemoteBranch { repo, branch } => {
            let (remote, name) = remote_branch(&repo, &branch)?;
            done(git_out(&repo, &["push", "--progress", "--delete", "--", &remote, &format!("refs/heads/{name}")]).map(|_| ()))?
        }
        Req::Merge { repo, rev, flags } => {
            let rev = commit_rev(&repo, &rev)?;
            done(git_flags(&repo, &["merge", "--no-edit"], &flags, &["--no-ff", "--ff-only", "--squash", "--no-commit"], &["--", rev]))?
        }
        Req::Rebase { repo, onto } => done(git_out(&repo, &["rebase", "--", commit_rev(&repo, &onto)?]).map(|_| ()))?,
        // no `--` here: cherry-pick/revert read what follows it as paths; commit_rev already refuses option-like values
        Req::CherryPick { repo, rev } => done(git_out(&repo, &["cherry-pick", commit_rev(&repo, &rev)?]).map(|_| ()))?,
        Req::Revert { repo, rev } => done(git_out(&repo, &["revert", "--no-edit", commit_rev(&repo, &rev)?]).map(|_| ()))?,
        Req::Reset { repo, rev, mode } => {
            let mode = match mode {
                ResetMode::Soft => "--soft",
                ResetMode::Mixed => "--mixed",
                ResetMode::Keep => "--keep",
                ResetMode::Hard => "--hard",
            };
            done(git_out(&repo, &["reset", mode, commit_rev(&repo, &rev)?, "--"]).map(|_| ()))?
        }
        Req::CreateTag { repo, name, rev, message } => done(create_tag(&repo, &name, &rev, message.as_deref()))?,
        Req::DeleteTag { repo, name } => {
            let t = tag(&repo, &name)?;
            done(git_out(&repo, &["tag", "-d", "--", t]).map(|_| ()))?
        }
        Req::PushTag { repo, remote, name } => {
            let (r, t) = (remote_name(&repo, &remote)?, tag(&repo, &name)?);
            done(git_out(&repo, &["push", "--progress", "--", r, &format!("refs/tags/{t}")]).map(|_| ()))?
        }
        Req::DeleteRemoteTag { repo, remote, name } => {
            // the tag may exist only on the remote: check the name's form, not that it exists here
            let (r, t) = (remote_name(&repo, &remote)?, ref_name(&repo, "refs/tags/", &name)?);
            done(git_out(&repo, &["push", "--progress", "--delete", "--", r, &format!("refs/tags/{t}")]).map(|_| ()))?
        }
        Req::SetUpstream { repo, branch, upstream } => done(set_upstream(&repo, &branch, upstream.as_deref()))?,
        Req::Sequence { repo, action } => done(sequence(&repo, action))?,
        Req::CountRange { repo, base, tip } => {
            let range = format!("{}..{}", commit_rev(&repo, &base)?, commit_rev(&repo, &tip)?);
            Resp::Count(git(&repo, &["rev-list", "--count", &range, "--"])?.trim().parse().map_err(|e| format!("bad count: {e}"))?)
        }
        Req::Undo { repo, moved, redo, mode, check } => done(undo(&repo, &moved, redo, mode, check))?,
        Req::AddRemote { repo, name, url } => {
            let (n, u) = (remote_new_name(&repo, &name)?, remote_url(&url)?);
            done(git_out(&repo, &["remote", "add", "--", n, u]).map(|_| ()))?
        }
        Req::RenameRemote { repo, name, new_name } => {
            let (old, new) = (remote_name(&repo, &name)?, remote_new_name(&repo, &new_name)?);
            done(git_out(&repo, &["remote", "rename", "--", old, new]).map(|_| ()))?
        }
        Req::DeleteRemote { repo, name } => {
            let n = remote_name(&repo, &name)?;
            done(git_out(&repo, &["remote", "remove", "--", n]).map(|_| ()))?
        }
        Req::SetRemoteUrl { repo, name, url } => {
            let (n, u) = (remote_name(&repo, &name)?, remote_url(&url)?);
            done(git_out(&repo, &["remote", "set-url", "--", n, u]).map(|_| ()))?
        }
        Req::StashOp { repo, stash, oid, action } => {
            let s = stash_entry(&repo, &stash, &oid)?;
            let verb = match action {
                StashAction::Apply => "apply",
                StashAction::Pop => "pop",
                StashAction::Drop => "drop",
            };
            done(git_out(&repo, &["stash", verb, s]).map(|_| ()))?
        }
        Req::ClearStashes { repo } => done(git_out(&repo, &["stash", "clear"]).map(|_| ()))?,
        Req::RemoteUrl { repo, name } => Resp::Text(git(&repo, &["remote", "get-url", "--", remote_name(&repo, &name)?])?.trim().to_string()),
        Req::Conflict { repo, path } => Resp::Conflict(conflict(&repo, &path)?),
        Req::SaveMerge { repo, path, text, stage } => done(save_merge(&repo, &path, &text, stage))?,
        Req::Rewrite { repo, action, commits, message, published_ok } => done(rewrite(&repo, action, &commits, message.as_deref(), published_ok))?,
        Req::Init { path } => Resp::Text(init(&path)?),
        Req::Clone { url, parent, name } => Resp::Text(clone(&url, &parent, name.as_deref())?),
        Req::GitCustom { repo, argv } => done(git_custom(&repo, &argv))?,
        // a watcher outlives the request: the runner (app) or the agent owns it, see `watch`
        Req::Watch { .. } | Req::Unwatch { .. } => return Err("watching needs the app's runner or the agent".into()),
        Req::ForgeProbe { repo, remote, source, target, forge, host, cli_path } => Resp::Forge(forge::probe(
            &repo,
            &remote,
            (source.as_deref(), target.as_deref()),
            forge.zip(host.as_deref()),
            cli_path.as_deref(),
        )?),
        Req::ForgeCreate(r) => forge::create(&r)?,
        Req::CleanupCandidates { repo, stale_days, protected } => {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
            Resp::Cleanup(cleanup::candidates(&repo, stale_days, &protected, now)?)
        }
        Req::DeleteBranches { repo, merged, unmerged } => done(cleanup::delete_local(&repo, &merged, &unmerged))?,
        Req::DeleteRemoteBranches { repo, branches } => done(cleanup::delete_remote(&repo, &branches))?,
        Req::Overview { repo } => Resp::Overview(overview(&repo)?),
        Req::RebasePlan { repo, from } => Resp::RebasePlan(rebase::plan(&repo, from.as_deref())?),
        Req::InteractiveRebase { repo, base, head, steps, published_ok } => done(rebase::apply(&repo, base.as_deref(), &head, &steps, published_ok))?,
    })
}

/// An absolute folder path from the UI (`~/…` expanded): one line, not option-like.
fn abs_dir(what: &str, path: &str) -> Result<std::path::PathBuf, String> {
    let p = expand(path.trim());
    if !p.starts_with('/') || p.chars().any(char::is_control) {
        return Err(format!("{what} must be an absolute folder path: {path:?}"));
    }
    Ok(std::path::PathBuf::from(p))
}

/// `git init`: the folder is created when missing; a folder that already holds `.git` is refused.
fn init(path: &str) -> Result<String, String> {
    let dir = abs_dir("the folder", path)?;
    if std::fs::symlink_metadata(dir.join(".git")).is_ok() {
        return Err(format!("{} is already a git repository", dir.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let d = dir.to_str().ok_or("the folder name is not UTF-8")?;
    git_out(d, &["init"])?;
    Ok(d.to_string())
}

/// A clone source: not option-like, no control chars, not a command-running transport (`ext::`, `fd::`).
fn clone_url(url: &str) -> Result<&str, String> {
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    if u.is_empty() || u.starts_with('-') || u.chars().any(char::is_control) || lower.starts_with("ext::") || lower.starts_with("fd::") {
        return Err(format!("not a valid repository URL: {url:?}"));
    }
    Ok(u)
}

/// The folder name git would pick for `url` (`…/name.git/` -> `name`).
fn clone_name(url: &str) -> String {
    let u = url.trim_end_matches('/');
    let u = u.strip_suffix("/.git").unwrap_or(u);
    let last = u.rsplit(['/', ':']).next().unwrap_or("");
    last.strip_suffix(".git").unwrap_or(last).to_string()
}

fn clone(url: &str, parent: &str, name: Option<&str>) -> Result<String, String> {
    let url = clone_url(url)?;
    let parent = abs_dir("the destination", parent)?;
    if !parent.is_dir() {
        return Err(format!("{} is not a folder", parent.display()));
    }
    let name = match name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => n.to_string(),
        None => clone_name(url),
    };
    if name.is_empty() || name == "." || name == ".." || name.starts_with('-') || name.contains('/') || name.chars().any(char::is_control) {
        return Err(format!("not a valid folder name: {name:?}"));
    }
    let target = parent.join(&name);
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(format!("{} already exists", target.display()));
    }
    let p = parent.to_str().ok_or("the destination is not UTF-8")?;
    // belt and braces: git refuses ext:: and fd:: by default, a user's config could allow them
    git_out(p, &["-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never", "clone", "--progress", "--", url, &name])?;
    Ok(target.to_string_lossy().into_owned())
}

const CUSTOM_MAX_ARGS: usize = 256;
const CUSTOM_MAX_BYTES: usize = 1 << 20;

/// A user command `git <argv…>` (no shell). `argv[0]` must be a git command git itself lists (built-ins and
/// `git-*` programs on PATH; never an alias, which could be a shell command from a repo's config, nor a global
/// option such as `-c`/`-C`/`--exec-path`). Arguments are passed as they are; NUL and control chars other than
/// newline/tab are refused.
fn git_custom(repo: &str, argv: &[String]) -> Result<(), String> {
    let Some(cmd) = argv.first() else { return Err("the git command needs an argv".into()) };
    if argv.len() > CUSTOM_MAX_ARGS || argv.iter().map(String::len).sum::<usize>() > CUSTOM_MAX_BYTES {
        return Err("the git command is too long".into());
    }
    if let Some(a) = argv.iter().find(|a| a.chars().any(|c| c.is_control() && c != '\n' && c != '\t')) {
        return Err(format!("bad argument {a:?}"));
    }
    let word = !cmd.is_empty() && cmd.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !cmd.starts_with('-');
    if !word || !git(repo, &["--list-cmds=main,others"])?.lines().any(|l| l == cmd) {
        return Err(format!("not a git command: {cmd:?}"));
    }
    let args: Vec<&str> = argv.iter().map(String::as_str).collect();
    git_out(repo, &args).map(|_| ())
}

const SCAN_MAX_DEPTH: u32 = 8;
const SCAN_MAX_DIRS: usize = 50_000;
const SCAN_MAX_RESULTS: usize = 2_000;
const SCAN_TIME: std::time::Duration = std::time::Duration::from_secs(10);

/// Breadth-first walk for dirs holding `.git` (a dir, or a file for worktrees/submodules). Read-only;
/// never follows symlinks, never descends into a found repo, skips hidden dirs and dependency dirs.
fn scan_repos(root: &str, depth: u32) -> Result<Scan, String> {
    let root = std::fs::canonicalize(expand(root)).map_err(|e| format!("{root}: {e}"))?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let start = std::time::Instant::now();
    let (mut paths, mut truncated, mut seen) = (Vec::new(), false, 0usize);
    let depth = depth.min(SCAN_MAX_DEPTH);
    let mut level = vec![root];
    for d in 0..=depth {
        let mut next = Vec::new();
        for dir in level {
            if seen >= SCAN_MAX_DIRS || paths.len() >= SCAN_MAX_RESULTS || start.elapsed() > SCAN_TIME {
                truncated = true;
                break;
            }
            seen += 1;
            if std::fs::symlink_metadata(dir.join(".git")).is_ok() {
                paths.push(dir.to_string_lossy().into_owned());
                continue;
            }
            if d == depth {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else { continue }; // unreadable: skip, don't fail the scan
            for e in entries.flatten() {
                let name = e.file_name();
                let name = name.to_string_lossy();
                // DirEntry::file_type doesn't follow symlinks, so a link (or a loop of them) is never entered
                if e.file_type().is_ok_and(|t| t.is_dir()) && !name.starts_with('.') && !matches!(&*name, "node_modules" | "vendor") {
                    next.push(e.path());
                }
            }
        }
        if truncated {
            break;
        }
        level = next;
    }
    paths.sort();
    Ok(Scan { paths, truncated })
}

/// `git` does not expand `~` itself (we exec without a shell), so do it for `~` and `~/..`.
fn expand(path: &str) -> String {
    let home = || std::env::var("HOME").unwrap_or_default();
    match path {
        "~" => home(),
        _ => match path.strip_prefix("~/") {
            Some(rest) => format!("{}/{rest}", home()),
            None => path.to_string(),
        },
    }
}

/// A sectionless `-c` key: git refuses to start ("unable to parse command-line config"). Used for a filter driver
/// that `-c` cannot name exactly, so it never runs.
const REFUSE: &str = "refusing-unsafe-repo-filter-driver";

/// The `-c` overrides that stop a repo's config from running code: `core.fsmonitor` when it is not a boolean (a
/// hook path; `true` is git's builtin daemon), and on reads every filter driver except the stock git-lfs one.
/// `entries`: `git config --null --get-regexp` output, `key\nvalue\0` (or `key\0` when valueless).
fn config_overrides(entries: &str, read: bool) -> Vec<String> {
    let mut fsmonitor_hook = false;
    let mut filters: Vec<(&str, &str, &str)> = Vec::new(); // (driver, key, last value)
    for e in entries.split('\0').filter(|e| !e.is_empty()) {
        let (key, val) = e.split_once('\n').unwrap_or((e, "true"));
        if key == "core.fsmonitor" {
            // last one wins, like git; git's maybe-bool: the words below, or any integer
            let v = val.to_ascii_lowercase();
            fsmonitor_hook = !(matches!(&*v, "" | "true" | "false" | "yes" | "no" | "on" | "off") || v.parse::<i64>().is_ok());
        } else if let Some((name, k)) = key.strip_prefix("filter.").and_then(|r| r.rsplit_once('.')) {
            filters.retain(|f| (f.0, f.1) != (name, k));
            filters.push((name, k, val));
        }
    }
    let mut out = Vec::new();
    if fsmonitor_hook {
        out.push("core.fsmonitor=false".to_string());
    }
    if read {
        let lfs = |k: &str, v: &str| matches!((k, v), ("clean", "git-lfs clean -- %f") | ("smudge", "git-lfs smudge -- %f") | ("process", "git-lfs filter-process"));
        let mut names: Vec<&str> = filters.iter().filter(|f| !lfs(f.1, f.2)).map(|f| f.0).collect();
        names.sort_unstable();
        names.dedup();
        for name in names {
            if name.contains('=') {
                // `-c` splits at the first '=', so this driver cannot be overridden: refuse instead
                out.push(REFUSE.to_string());
                continue;
            }
            out.extend(["clean=", "smudge=", "process=", "required=false"].map(|k| format!("filter.{name}.{k}")));
        }
    }
    out
}

/// `read`: a read-only/polling call, so a repo's own config gets no chance to run code (hooks, filter drivers,
/// external diff, textconv; the call sites add `--no-ext-diff --no-textconv`). Writes keep the user's hooks and
/// filters. Config is re-read on every call (one cheap `git config`, runs nothing, follows includes), so a hook
/// added while the app is open is caught on the next call.
fn git_cmd(repo: &str, read: bool) -> Command {
    let dir = expand(repo);
    let cached = if read { READ_CONFIG.with(|c| c.borrow().as_ref().and_then(|m| m.get(&dir).cloned())) } else { None };
    let overrides = cached.unwrap_or_else(|| {
        let o = config_overrides_now(&dir, read);
        if read {
            READ_CONFIG.with(|c| if let Some(m) = c.borrow_mut().as_mut() { m.insert(dir.clone(), o.clone()); });
        }
        o
    });
    let mut c = Command::new("git");
    c.arg("-C").arg(&dir);
    for o in overrides {
        c.arg("-c").arg(o);
    }
    if read {
        c.args(["-c", "core.hooksPath=/dev/null"]);
    }
    // C locale: we parse git's "N files changed" line. No optional locks: never fight a user's git.
    c.env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env_remove("GIT_EXTERNAL_DIFF")
        .stdin(Stdio::null());
    c
}

/// The overrides from the repo's config as it is now (one `git config`, runs nothing).
fn config_overrides_now(dir: &str, read: bool) -> Vec<String> {
    let entries = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["config", "--includes", "--null", "--get-regexp", r"^(core\.fsmonitor|filter\..+\.(clean|smudge|process))$"])
        .env("LC_ALL", "C") // else the regex `.` skips non-UTF-8 bytes and such a driver is not listed at all
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map(|o| o.stdout)
        .unwrap_or_default();
    // a non-UTF-8 driver name would be mangled into a different key (and still run): on reads, refuse instead.
    // Lossy is fine for writes: filters are kept there and a mangled fsmonitor value reads as a hook (overridden).
    match String::from_utf8(entries) {
        Err(_) if read => vec![REFUSE.to_string()],
        Ok(e) => config_overrides(&e, read),
        Err(e) => config_overrides(&String::from_utf8_lossy(e.as_bytes()), read),
    }
}

fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = git_cmd(repo, true).args(args).output().map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Like `git` but reads at most `limit` bytes of stdout, then kills git. Returns (bytes, was_cut).
fn git_capped(repo: &str, args: &[&str], limit: usize, exit1_ok: bool) -> Result<(Vec<u8>, bool), String> {
    let mut child = git_cmd(repo, true)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run git: {e}"))?;
    let mut buf = Vec::new();
    let mut out = child.stdout.take().ok_or("no stdout")?;
    out.by_ref().take(limit as u64 + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let cut = buf.len() > limit;
    if cut {
        let _ = child.kill();
        buf.truncate(limit);
    }
    drop(out);
    let done = child.wait_with_output().map_err(|e| e.to_string())?;
    if !cut && !done.status.success() && (!exit1_ok || done.status.code() != Some(1)) {
        return Err(String::from_utf8_lossy(&done.stderr).trim().to_string());
    }
    Ok((buf, cut))
}

/// Text view of capped output: lossy UTF-8, and when cut, dropped back to the last full line.
fn capped_text(mut bytes: Vec<u8>, cut: bool) -> String {
    if cut && let Some(nl) = bytes.iter().rposition(|&b| b == b'\n') {
        bytes.truncate(nl + 1);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn valid_oid(o: &str) -> bool {
    matches!(o.len(), 40 | 64) && o.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Ids come from the UI and become git arguments: only accept plain hex ids.
fn check_oid(o: &str) -> Result<(), String> {
    if valid_oid(o) { Ok(()) } else { Err(format!("not a commit id: {o:?}")) }
}

fn open(path: &str) -> Result<RepoInfo, String> {
    let root = git(path, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let name = Path::new(&root).file_name().map_or(root.clone(), |n| n.to_string_lossy().into_owned());
    let nonempty = |s: String| Some(s.trim().to_string()).filter(|s| !s.is_empty());
    let branch = git(&root, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().and_then(nonempty);
    let oid = git(&root, &["rev-parse", "-q", "--verify", "HEAD"]).ok().and_then(nonempty);
    // No upstream (or empty repo) makes this fail: that simply means 0/0.
    let (behind, ahead) = git(&root, &["rev-list", "--left-right", "--count", "@{u}...HEAD"])
        .ok()
        .and_then(|s| {
            let mut it = s.split_whitespace().map(|n| n.parse::<u32>());
            Some((it.next()?.ok()?, it.next()?.ok()?))
        })
        .unwrap_or((0, 0));
    let lfs_warning = lfs_warning(&root);
    Ok(RepoInfo { root, name, branch, oid, ahead, behind, lfs_warning })
}

/// The repo uses Git LFS but this machine cannot smudge its files: say so instead of silently showing pointer files.
/// Cheap: one file read; `git config` runs only for LFS repos (at open, never per poll).
fn lfs_warning(root: &str) -> Option<String> {
    let attrs = std::fs::read_to_string(Path::new(root).join(".gitattributes")).ok()?;
    if !attrs.lines().any(|l| !l.trim_start().starts_with('#') && l.contains("filter=lfs")) {
        return None;
    }
    let on_path = std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join("git-lfs").is_file()));
    if !on_path {
        return Some("This repository uses Git LFS, but git-lfs is not installed here: LFS files show as pointer files.".into());
    }
    let set = |k: &str| git(root, &["config", "--get", k]).is_ok_and(|v| !v.trim().is_empty());
    (!set("filter.lfs.process") && !set("filter.lfs.smudge"))
        .then(|| "This repository uses Git LFS, but git-lfs is not set up (run `git lfs install`): LFS files show as pointer files.".into())
}

fn count(repo: &str, revs: &[String]) -> Result<u32, String> {
    git(repo, &with_revs(&["rev-list", "--count"], revs))?.trim().parse().map_err(|e| format!("bad count: {e}"))
}

fn refs(repo: &str) -> Result<Refs, String> {
    let fmt = format!("--format=%(refname){FIELD}%(objectname){FIELD}%(*objectname){FIELD}%(HEAD){FIELD}%(upstream:short)");
    let list = git(repo, &["for-each-ref", &fmt, "refs/heads", "refs/remotes", "refs/tags"])?;
    let stash_fmt = format!("--format=%gd{FIELD}%H{FIELD}%gs");
    // `stash list` fails on some very old gits without a stash ref; treat any failure as "none".
    let stashes = git(repo, &["stash", "list", &stash_fmt]).unwrap_or_default();
    let subs = git(repo, &["submodule", "status"]).unwrap_or_default();
    let trees = git(repo, &["worktree", "list", "--porcelain"]).unwrap_or_default();
    let root = git(repo, &["rev-parse", "--show-toplevel"]).unwrap_or_default();
    Ok(Refs {
        refs: parse_refs(&list),
        stashes: parse_stashes(&stashes),
        submodules: parse_submodules(&subs),
        worktrees: parse_worktrees(&trees, root.trim()),
        remotes: remotes(repo),
    })
}

/// Blocks of `worktree <path>` / `HEAD <oid>` / `branch refs/heads/x` | `detached` | `bare`, blank-line separated.
fn parse_worktrees(out: &str, root: &str) -> Vec<Worktree> {
    out.split("\n\n")
        .filter_map(|block| {
            let (mut path, mut oid, mut branch) = (None, String::new(), None);
            for l in block.lines() {
                if let Some(p) = l.strip_prefix("worktree ") {
                    path = Some(p.to_string());
                } else if let Some(o) = l.strip_prefix("HEAD ") {
                    oid = o.into();
                } else if let Some(b) = l.strip_prefix("branch ") {
                    branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
                }
            }
            let path = path?;
            Some(Worktree { current: path == root, path, branch, oid })
        })
        .collect()
}

fn parse_refs(out: &str) -> Vec<RefItem> {
    out.lines()
        .filter_map(|l| {
            let mut f = l.split(FIELD);
            let (full, oid, peeled, head) = (f.next()?, f.next()?, f.next()?, f.next()?);
            let upstream = f.next().filter(|u| !u.is_empty()).map(String::from);
            let (kind, name) = if let Some(n) = full.strip_prefix("refs/heads/") {
                (RefKind::Branch, n)
            } else if let Some(n) = full.strip_prefix("refs/remotes/") {
                (RefKind::Remote, n)
            } else {
                (RefKind::Tag, full.strip_prefix("refs/tags/")?)
            };
            if kind == RefKind::Remote && name.ends_with("/HEAD") {
                return None;
            }
            // Annotated tags: show the commit they point to.
            let oid = if peeled.is_empty() { oid } else { peeled };
            Some(RefItem { name: name.into(), kind, oid: oid.into(), head: head == "*", upstream })
        })
        .collect()
}

fn parse_stashes(out: &str) -> Vec<Stash> {
    out.lines()
        .filter_map(|l| {
            let mut f = l.splitn(3, FIELD);
            let (name, oid, message) = (f.next()?, f.next()?, f.next()?);
            Some(Stash { name: name.into(), oid: oid.into(), message: message.into() })
        })
        .collect()
}

/// Lines look like `[ +-U]<sha> <path> (<describe>)`; `-` = not initialized.
fn parse_submodules(out: &str) -> Vec<Submodule> {
    out.lines()
        .filter_map(|l| {
            let mut c = l.chars();
            let flag = c.next()?;
            let mut it = c.as_str().split(' ');
            let (oid, path) = (it.next()?, it.next()?);
            Some(Submodule { path: path.into(), oid: oid.into(), initialized: flag != '-' })
        })
        .collect()
}

fn log(repo: &str, skip: u32, limit: u32, revs: &[String]) -> Result<Vec<Commit>, String> {
    if limit == 0 {
        return Ok(vec![]);
    }
    let fmt = format!("--format={RECORD}%H{FIELD}%P{FIELD}%an{FIELD}%ae{FIELD}%at{FIELD}%s{FIELD}%D");
    let (skip, max) = (format!("--skip={skip}"), format!("--max-count={limit}"));
    let opts = ["--topo-order", "--decorate=full", "--no-show-signature", "--no-ext-diff", "--no-textconv", &skip, &max, &fmt];
    let out = git(repo, &with_revs(&["log"], revs).into_iter().chain(opts).collect::<Vec<_>>())?;
    Ok(parse_log(&out))
}

fn parse_log(out: &str) -> Vec<Commit> {
    out.split(RECORD)
        .skip(1)
        .filter_map(|rec| {
            let mut f = rec.trim_end().split(FIELD);
            let (oid, parents, author, email, time, subject, deco) =
                (f.next()?, f.next()?, f.next()?, f.next()?, f.next()?, f.next()?, f.next()?);
            Some(Commit {
                oid: oid.into(),
                parents: parents.split_whitespace().map(String::from).collect(),
                author: author.into(),
                email: email.into(),
                time: time.parse().unwrap_or(0),
                subject: subject.into(),
                files: None,
                labels: parse_decorations(deco),
            })
        })
        .collect()
}

/// Changed-file counts for `oids`. Merges report 0 (git prints no stat for them).
fn stats(repo: &str, oids: &[String]) -> Result<Vec<(String, u32)>, String> {
    if oids.len() > MAX_STATS {
        return Err(format!("too many oids (max {MAX_STATS})"));
    }
    oids.iter().try_for_each(|o| check_oid(o))?;
    if oids.is_empty() {
        return Ok(vec![]);
    }
    let fmt = format!("--format={RECORD}%H");
    let mut args = vec!["log", "--no-walk=unsorted", "--shortstat", "--no-show-signature", "--no-ext-diff", "--no-textconv", &fmt];
    args.extend(oids.iter().map(String::as_str));
    args.push("--");
    Ok(parse_stats(&git(repo, &args)?))
}

fn parse_stats(out: &str) -> Vec<(String, u32)> {
    out.split(RECORD)
        .skip(1)
        .map(|rec| {
            let (oid, rest) = rec.split_once('\n').unwrap_or((rec, ""));
            let files = rest
                .lines()
                .find(|l| l.contains("changed"))
                .and_then(|l| l.split_whitespace().next()?.parse().ok())
                .unwrap_or(0);
            (oid.trim().to_string(), files)
        })
        .collect()
}

/// `%D` with `--decorate=full`: `HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main`.
fn parse_decorations(d: &str) -> Vec<Label> {
    let mut labels: Vec<Label> = d
        .split(", ")
        .filter_map(|item| {
            let (item, head) = match item.strip_prefix("HEAD -> ") {
                Some(rest) => (rest, true),
                None => (item, false),
            };
            if item == "HEAD" {
                return Some(Label { name: "HEAD".into(), kind: RefKind::Branch, head: true });
            }
            let (kind, name) = if let Some(n) = item.strip_prefix("refs/heads/") {
                (RefKind::Branch, n)
            } else if let Some(n) = item.strip_prefix("refs/remotes/") {
                (RefKind::Remote, n)
            } else {
                (RefKind::Tag, item.strip_prefix("tag: refs/tags/")?)
            };
            if kind == RefKind::Remote && name.ends_with("/HEAD") {
                return None;
            }
            Some(Label { name: name.into(), kind, head })
        })
        .collect();
    labels.sort_by_key(|l| !l.head); // checked-out branch first
    labels
}

// ---- M2: graph, commit detail, diffs, files, history, blame -------------------------------------

/// Parent row indices per commit, in the same order as `log` (topo order: parents always come later).
fn graph(repo: &str, revs: &[String]) -> Result<GraphData, String> {
    let out = git(repo, &with_revs(&["rev-list", "--topo-order", "--parents"], revs))?;
    let lines: Vec<&str> = out.lines().collect();
    let row: HashMap<&str, u32> =
        lines.iter().enumerate().map(|(i, l)| (l.split(' ').next().unwrap_or(""), i as u32)).collect();
    let parents = lines.iter().map(|l| l.split(' ').skip(1).filter_map(|p| row.get(p).copied()).collect()).collect();
    // annotated tags: %(*objectname) is the commit; hidden refs simply have no row
    let refs = git(repo, &["for-each-ref", "--format=%(objectname) %(*objectname)"]).unwrap_or_default();
    let head = git(repo, &["rev-parse", "-q", "--verify", "HEAD"]).unwrap_or_default();
    let mut tips: Vec<u32> = refs
        .lines()
        .filter_map(|l| l.split(' ').rfind(|s| !s.is_empty()))
        .chain(head.lines())
        .filter_map(|o| row.get(o.trim()).copied())
        .collect();
    tips.sort_unstable();
    tips.dedup();
    Ok(GraphData { parents, tips })
}

fn locate(repo: &str, oid: &str, revs: &[String]) -> Result<Option<u32>, String> {
    check_oid(oid)?;
    let out = git(repo, &with_revs(&["rev-list", "--topo-order"], revs))?;
    Ok(out.lines().position(|l| l == oid).map(|p| p as u32))
}

/// What a commit is compared against: its first parent, or the empty tree for a root commit.
fn diff_base(repo: &str, oid: &str) -> Result<String, String> {
    match git(repo, &["rev-parse", "-q", "--verify", &format!("{oid}^1")]) {
        Ok(p) => Ok(p.trim().to_string()),
        Err(_) => Ok(git(repo, &["hash-object", "-t", "tree", "/dev/null"])?.trim().to_string()),
    }
}

/// Base of a commit's diff: the first parent of `from` (a range of selected commits) or of `oid` itself.
fn range_base(repo: &str, oid: &str, from: Option<&str>) -> Result<String, String> {
    match from {
        Some(f) => {
            check_oid(f)?;
            diff_base(repo, f)
        }
        None => diff_base(repo, oid),
    }
}

fn show(repo: &str, oid: &str, from: Option<&str>) -> Result<Detail, String> {
    check_oid(oid)?;
    let fmt = format!("--format=%H{FIELD}%T{FIELD}%P{FIELD}%an{FIELD}%ae{FIELD}%at{FIELD}%cn{FIELD}%ct{FIELD}%s{FIELD}%b");
    let out = git(repo, &["show", "-s", "--no-show-signature", "--no-ext-diff", "--no-textconv", &fmt, oid])?;
    let f: Vec<&str> = out.splitn(10, FIELD).collect();
    let &[full, tree, parents, author, email, time, committer, commit_time, subject, body] = f.as_slice() else {
        return Err("unexpected output from git show".into());
    };
    let base = range_base(repo, oid, from)?;
    let numstat = git(repo, &["diff-tree", "-r", "-M", "-z", "--numstat", &base, oid])?;
    let names = git(repo, &["diff-tree", "-r", "-M", "-z", "--name-status", &base, oid])?;
    Ok(Detail {
        oid: full.trim().into(),
        tree: tree.into(),
        parents: parents.split_whitespace().map(String::from).collect(),
        author: author.into(),
        email: email.into(),
        time: time.parse().unwrap_or(0),
        committer: committer.into(),
        commit_time: commit_time.parse().unwrap_or(0),
        subject: subject.into(),
        body: body.trim().into(),
        files: parse_changes(&numstat, &names),
    })
}

/// `numstat -z` and `name-status -z` list the same files in the same order; zip them.
fn parse_changes(numstat: &str, names: &str) -> Vec<FileChange> {
    let mut counts = Vec::new(); // (adds, dels, path, old_path)
    let mut it = numstat.split('\0');
    while let Some(t) = it.next() {
        let mut p = t.splitn(3, '\t');
        let (Some(a), Some(d), Some(path)) = (p.next(), p.next(), p.next()) else { continue };
        let (path, old) = if path.is_empty() {
            let old = it.next().unwrap_or("").to_string();
            (it.next().unwrap_or("").to_string(), Some(old))
        } else {
            (path.to_string(), None)
        };
        counts.push((a.parse().ok(), d.parse().ok(), path, old));
    }
    let mut statuses = Vec::new();
    let mut it = names.split('\0');
    while let Some(st) = it.next() {
        let Some(c) = st.chars().next() else { continue };
        if matches!(c, 'R' | 'C') {
            it.next(); // old path: already known from numstat
        }
        it.next(); // (new) path
        statuses.push(c.to_string());
    }
    counts
        .into_iter()
        .zip(statuses)
        .map(|((adds, dels, path, old_path), status)| FileChange { path, old_path, status, adds, dels })
        .collect()
}

fn diff(
    repo: &str,
    oid: &str,
    path: &str,
    old_path: Option<&str>,
    (context, ignore_ws): (u32, bool),
    from: Option<&str>,
) -> Result<Patch, String> {
    check_oid(oid)?;
    let base = range_base(repo, oid, from)?;
    let unified = format!("-U{}", context.min(MAX_CONTEXT));
    let mut args = vec!["--literal-pathspecs", "diff", "-M", "--no-color", "--no-ext-diff", "--no-textconv", &unified];
    if ignore_ws {
        args.push("-w");
    }
    args.extend([base.as_str(), oid, "--", path]);
    args.extend(old_path);
    let (bytes, cut) = git_capped(repo, &args, PATCH_LIMIT, false)?;
    Ok(Patch { text: capped_text(bytes, cut), truncated: cut })
}

fn tree(repo: &str, oid: &str, path: &str) -> Result<Vec<TreeEntry>, String> {
    check_oid(oid)?;
    let spec = format!("{oid}:{}", path.trim_matches('/'));
    Ok(parse_tree(&git(repo, &["ls-tree", "-z", "-l", &spec])?))
}

fn parse_tree(out: &str) -> Vec<TreeEntry> {
    let mut v: Vec<TreeEntry> = out
        .split('\0')
        .filter_map(|rec| {
            let (meta, name) = rec.split_once('\t')?;
            let mut m = meta.split_whitespace();
            let (_mode, kind, _oid, size) = (m.next()?, m.next()?, m.next()?, m.next()?);
            let kind = match kind {
                "tree" => TreeKind::Tree,
                "commit" => TreeKind::Commit,
                _ => TreeKind::Blob,
            };
            Some(TreeEntry { name: name.into(), kind, size: size.parse().ok() })
        })
        .collect();
    v.sort_by_key(|e| (e.kind == TreeKind::Blob, e.name.to_lowercase())); // dirs and submodules first
    v
}

fn blob(repo: &str, rev: &str, path: &str) -> Result<Blob, String> {
    let (bytes, cut, size) = read_rev(repo, rev, path, BLOB_LIMIT)?;
    Ok(to_blob(bytes, cut, size))
}

fn to_blob(bytes: Vec<u8>, cut: bool, size: u64) -> Blob {
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return Blob { text: None, size, binary: true, truncated: false };
    }
    Blob { text: Some(capped_text(bytes, cut)), size, binary: false, truncated: cut }
}

/// Up to `limit` bytes of `path` at `rev` (a commit id, `HEAD`, `index` or `worktree`), whether they were
/// cut, and the full size.
fn read_rev(repo: &str, rev: &str, path: &str, limit: usize) -> Result<(Vec<u8>, bool, u64), String> {
    if rev == "worktree" {
        let rel = Path::new(path);
        // the path comes from the UI: stay inside the repo
        if path.is_empty() || !rel.components().all(|c| matches!(c, std::path::Component::Normal(_))) {
            return Err(format!("bad path: {path:?}"));
        }
        let full = Path::new(repo).join(rel);
        let meta = std::fs::symlink_metadata(&full).map_err(|e| format!("{path}: {e}"))?;
        if meta.file_type().is_symlink() {
            // git stores a symlink as its target text
            let target = std::fs::read_link(&full).map_err(|e| e.to_string())?.to_string_lossy().into_owned().into_bytes();
            let size = target.len() as u64;
            return Ok((target, false, size));
        }
        let mut buf = Vec::new();
        std::fs::File::open(&full).map_err(|e| format!("{path}: {e}"))?.take(limit as u64 + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        let cut = buf.len() > limit;
        buf.truncate(limit);
        return Ok((buf, cut, meta.len()));
    }
    let spec = match rev {
        "index" => format!(":{path}"),
        "HEAD" => format!("HEAD:{path}"),
        oid => {
            check_oid(oid)?;
            format!("{oid}:{path}")
        }
    };
    read_spec(repo, &spec, limit)
}

/// Up to `limit` bytes of the object `spec` names (`<rev>:<path>`, or a blob id), whether they were cut, the full size.
fn read_spec(repo: &str, spec: &str, limit: usize) -> Result<(Vec<u8>, bool, u64), String> {
    let size: u64 = git(repo, &["cat-file", "-s", spec])?.trim().parse().map_err(|e| format!("bad size: {e}"))?;
    let (mut bytes, cut) = git_capped(repo, &["cat-file", "blob", spec], limit, false)?;
    bytes.truncate(limit);
    Ok((bytes, cut, size))
}

fn files(repo: &str, oid: &str) -> Result<Vec<String>, String> {
    check_oid(oid)?;
    let out = git(repo, &["ls-tree", "-r", "-z", "--name-only", oid])?;
    Ok(out.split('\0').filter(|p| !p.is_empty()).map(String::from).collect())
}

fn file_log(repo: &str, oid: &str, path: &str, skip: u32, limit: u32) -> Result<Vec<Commit>, String> {
    check_oid(oid)?;
    if limit == 0 {
        return Ok(vec![]);
    }
    let fmt = format!("--format={RECORD}%H{FIELD}%P{FIELD}%an{FIELD}%ae{FIELD}%at{FIELD}%s{FIELD}%D");
    let (skip, max) = (format!("--skip={skip}"), format!("--max-count={limit}"));
    let out = git(
        repo,
        &["--literal-pathspecs", "log", "--follow", "--decorate=full", "--no-show-signature", "--no-ext-diff", "--no-textconv", &skip, &max, &fmt, oid, "--", path],
    )?;
    Ok(parse_log(&out))
}

fn blame(repo: &str, oid: &str, path: &str) -> Result<Vec<BlameLine>, String> {
    check_oid(oid)?;
    Ok(parse_blame(&git(repo, &["blame", "--porcelain", "--no-ext-diff", "--no-textconv", oid, "--", path])?))
}

/// Porcelain: `<oid> <orig> <final> [n]`, then author lines (first time an oid appears), then `\t<text>`.
fn parse_blame(out: &str) -> Vec<BlameLine> {
    let mut meta: HashMap<&str, (String, i64)> = HashMap::new();
    let mut cur = "";
    let mut lines = Vec::new();
    for l in out.split('\n') {
        if let Some(text) = l.strip_prefix('\t') {
            let (author, time) = meta.get(cur).cloned().unwrap_or_default();
            lines.push(BlameLine { oid: cur.into(), author, time, text: text.into() });
        } else if let Some(a) = l.strip_prefix("author ") {
            meta.entry(cur).or_default().0 = a.into();
        } else if let Some(t) = l.strip_prefix("author-time ") {
            meta.entry(cur).or_default().1 = t.parse().unwrap_or(0);
        } else if l.split(' ').count() >= 3 && l.split(' ').next().is_some_and(valid_oid) {
            cur = l.split(' ').next().unwrap_or("");
        }
    }
    lines
}

// ---- M4: line history, images ---------------------------------------------------------------------

fn line_log(repo: &str, oid: &str, path: &str, start: u32, end: u32, limit: u32) -> Result<Vec<Commit>, String> {
    check_oid(oid)?;
    if start == 0 || end < start {
        return Err(format!("bad line range {start}-{end}"));
    }
    if limit == 0 {
        return Ok(vec![]);
    }
    let fmt = format!("--format={RECORD}%H{FIELD}%P{FIELD}%an{FIELD}%ae{FIELD}%at{FIELD}%s{FIELD}%D");
    let range = format!("-L{start},{end}:{path}");
    let max = format!("--max-count={limit}");
    // `-L` normally prints a patch; --no-patch keeps just the commits. The range is matched against `oid`'s version of the file.
    let out = git(repo, &["log", "--no-patch", "--decorate=full", "--no-show-signature", "--no-ext-diff", "--no-textconv", &max, &fmt, &range, oid])?;
    Ok(parse_log(&out))
}

fn image_mime(path: &str) -> Option<&'static str> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

fn image(repo: &str, rev: &str, path: &str) -> Result<ImageData, String> {
    use base64::Engine;
    let mime = image_mime(path).ok_or_else(|| format!("not an image: {path}"))?;
    let (bytes, cut, _) = read_rev(repo, rev, path, IMAGE_LIMIT)?;
    if cut {
        return Err("image is larger than 8 MB".into());
    }
    Ok(ImageData { mime: mime.into(), size: bytes.len() as u64, base64: base64::engine::general_purpose::STANDARD.encode(&bytes) })
}


// ---- F6: search ----------------------------------------------------------------------------------

const MAX_SEARCH: u32 = 1000;

/// git does dates, paths and `-S`; text filters run here on the streamed log, so every filter ANDs the same way
/// and no user text is ever read by git as an option or a pattern. Stops reading once `limit` matched.
fn search(repo: &str, q: &SearchQuery, limit: u32, revs: &[String]) -> Result<SearchResult, String> {
    let limit = limit.clamp(1, MAX_SEARCH) as usize;
    let lower = |v: &[String]| v.iter().map(|s| s.to_lowercase()).collect::<Vec<_>>();
    let (text, message, author, commit) = (lower(&q.text), lower(&q.message), lower(&q.author), lower(&q.commit));
    if let Some(c) = commit.iter().find(|c| c.is_empty() || c.len() > 64 || !c.bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err(format!("commit: takes a hex hash or prefix, not {c:?}"));
    }
    if q.content.len() > 1 {
        return Err("Only one contents: term is supported.".into());
    }
    if q.branch.len() > 1 {
        return Err("Only one branch: term is supported.".into());
    }
    let all = [&q.text, &q.message, &q.author, &q.commit, &q.file, &q.content, &q.branch];
    if all.iter().flat_map(|v| v.iter()).chain(q.after.iter()).chain(q.before.iter()).any(|v| v.trim().is_empty() || v.contains('\0')) {
        return Err("Search terms can't be empty.".into());
    }
    if all.iter().all(|v| v.is_empty()) && q.after.is_none() && q.before.is_none() {
        return Err("Nothing to search for.".into());
    }
    let fmt = format!("--format={RECORD}%H{FIELD}%an{FIELD}%ae{FIELD}%B");
    // option values are glued to their flag (`--since=…`, `-S…`), paths come after `--` and are literal
    let mut args = vec!["--literal-pathspecs".to_string(), "log".into(), "--no-show-signature".into(), "--no-ext-diff".into(), "--no-textconv".into(), fmt];
    args.extend(q.after.iter().map(|a| format!("--since={a}")));
    args.extend(q.before.iter().map(|b| format!("--until={b}")));
    args.extend(q.content.iter().map(|c| format!("-S{c}")));
    match q.branch.first() {
        // the rows still come from the full list's order below, so only reachability changes
        Some(b) => args.push(search_branch(repo, b)?),
        None => args.extend(revs.iter().cloned()),
    }
    args.push("--".into());
    args.extend(q.file.iter().cloned());

    let mut child = git_cmd(repo, true)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run git: {e}"))?;
    let mut out = std::io::BufReader::new(child.stdout.take().ok_or("no stdout")?);
    let (mut found, mut truncated, mut rec) = (Vec::new(), false, Vec::new());
    loop {
        rec.clear();
        if std::io::BufRead::read_until(&mut out, RECORD as u8, &mut rec).map_err(|e| e.to_string())? == 0 {
            break;
        }
        let r = String::from_utf8_lossy(rec.strip_suffix(&[RECORD as u8]).unwrap_or(&rec)).to_lowercase();
        let mut f = r.splitn(4, FIELD);
        let (Some(oid), Some(name), Some(email), Some(msg)) = (f.next(), f.next(), f.next(), f.next()) else { continue };
        let who = |t: &String| name.contains(t.as_str()) || email.contains(t.as_str());
        let hit = text.iter().all(|t| msg.contains(t.as_str()) || who(t) || oid.starts_with(t.as_str()))
            && message.iter().all(|t| msg.contains(t.as_str()))
            && author.iter().all(who)
            && commit.iter().all(|c| oid.starts_with(c.as_str()));
        if !hit {
            continue;
        }
        if found.len() == limit {
            truncated = true;
            let _ = child.kill();
            break;
        }
        found.push(oid.to_string());
    }
    drop(out);
    let done = child.wait_with_output().map_err(|e| e.to_string())?;
    if !truncated && !done.status.success() {
        return Err(String::from_utf8_lossy(&done.stderr).trim().to_string());
    }
    // rows in the commit list's order (the graph's), so the UI can show just these
    let order = git(repo, &with_revs(&["rev-list", "--topo-order"], revs))?;
    let want: std::collections::HashSet<&str> = found.iter().map(String::as_str).collect();
    let rows = order.lines().enumerate().filter(|(_, l)| want.contains(l)).map(|(i, _)| i as u32).collect();
    Ok(SearchResult { rows, truncated })
}

/// `branch:` value: a local branch, remote branch or tag by short name, as its full ref name.
fn search_branch(repo: &str, name: &str) -> Result<String, String> {
    ["refs/heads/", "refs/remotes/", "refs/tags/"]
        .iter()
        .map(|p| format!("{p}{name}"))
        .find(|full| commit_rev(repo, full).is_ok())
        .ok_or_else(|| format!("branch: no branch, remote branch or tag named {name:?}"))
}

// ---- M3: working copy ----------------------------------------------------------------------------

const MAX_STATUS: usize = 20_000;
const PATH_CHUNK: usize = 400; // paths per git invocation: stays far below the OS argument limit
const MAX_PATCH_IN: usize = 8 << 20;

/// Run git with `input` on stdin, as a step of the current job (see `git_out`).
fn git_stdin(repo: &str, args: &[&str], input: &[u8]) -> Result<String, String> {
    exec(repo, args, Some(input), &[])
}

/// A write step: like `git`, but inside a job its process group can be killed by `cancel` and its output streams
/// to the job's sink. On failure the error is git's stderr (hook output lands there too), progress redraws settled.
fn git_out(repo: &str, args: &[&str]) -> Result<String, String> {
    exec(repo, args, None, &[])
}

/// Extra environment for write steps (the app's askpass helper for local repos). Never set in the agent, so remote
/// repos keep git's plain "terminal prompts disabled" error.
static WRITE_ENV: std::sync::OnceLock<Vec<(String, String)>> = std::sync::OnceLock::new();

/// Set once at startup by the desktop app; later calls are ignored.
pub fn set_write_env(env: Vec<(String, String)>) {
    let _ = WRITE_ENV.set(env);
}

/// Hide a password embedded in a URL (`https://user:secret@host` -> `https://user:***@host`) before output is shown.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let end = tail.find(|c: char| c == '/' || c.is_whitespace() || c == '\'' || c == '"').unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority.rfind('@').and_then(|at| authority[..at].find(':').map(|colon| (colon, at))) {
            Some((colon, at)) => {
                out.push_str(&authority[..=colon]);
                out.push_str("***");
                out.push_str(&authority[at..]);
            }
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// `env`: set after the defaults (a rebase's scripted editors replace `GIT_EDITOR=true`).
fn exec(repo: &str, args: &[&str], input: Option<&[u8]>, env: &[(&str, String)]) -> Result<String, String> {
    let mut cmd = git_cmd(repo, false);
    cmd.args(args).env("GIT_EDITOR", "true");
    for (k, v) in WRITE_ENV.get().into_iter().flatten() {
        cmd.env(k, v);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    run_step(cmd, "git", input)
}

/// Run `cmd` as a write step of the current job: killable process group, output streamed to the job's sink.
/// `what` names the program in errors.
fn run_step(mut cmd: Command, what: &str, input: Option<&[u8]>) -> Result<String, String> {
    use std::io::Write;
    use std::os::unix::process::CommandExt;
    let (job, sink) = JOB.with(|j| j.borrow().clone()).unzip();
    let sink: Option<Sink> = sink.flatten().map(|s| Arc::new(move |t: &str| s(&redact(t))) as Sink);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    if input.is_some() {
        cmd.stdin(Stdio::piped());
    }
    if job.is_some() {
        cmd.process_group(0); // its own group: Cancel kills git together with hooks, ssh, credential helpers
    }
    let mut child = {
        // spawn and register under the lock, so a Cancel can never fall between the two
        let mut jobs = jobs();
        let slot = job.map(|id| jobs.entry(id).or_default());
        if slot.as_ref().is_some_and(|s| s.cancelled) {
            return Err(CANCELLED.into());
        }
        let child = cmd.spawn().map_err(|e| format!("cannot run {what}: {e}"))?;
        if let Some(s) = slot {
            s.pgid = Some(child.id() as i32);
        }
        child
    };
    let wrote = match (input, child.stdin.take()) {
        // git reads all of its input before producing much output, so writing first cannot deadlock
        (Some(data), Some(mut w)) => w.write_all(data),
        _ => Ok(()),
    };
    let (out, err) = (child.stdout.take().ok_or("no stdout")?, child.stderr.take().ok_or("no stderr")?);
    let err_sink = sink.clone();
    let err_reader = std::thread::spawn(move || pump(err, err_sink.as_ref()));
    let stdout = pump(out, sink.as_ref());
    let stderr = err_reader.join().unwrap_or_default();
    // pipes closed: forget the group before reaping, so its id can never be reused under a later Cancel
    if let Some(id) = job
        && let Some(s) = jobs().get_mut(&id)
    {
        s.pgid = None;
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        let err = settle(&String::from_utf8_lossy(&stderr));
        let msg = if err.is_empty() { String::from_utf8_lossy(&stdout).trim().to_string() } else { err };
        return Err(if msg.is_empty() { format!("{what} failed") } else { redact(&msg) });
    }
    wrote.map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

/// Read all of `r`, passing it to `sink` in pieces that end at a line break (`\n` or `\r`, so UTF-8 is never split).
fn pump(mut r: impl Read, sink: Option<&Sink>) -> Vec<u8> {
    let (mut all, mut buf, mut sent) = (Vec::new(), [0u8; 8192], 0);
    while let Ok(n) = r.read(&mut buf) {
        if n == 0 {
            break;
        }
        all.extend_from_slice(&buf[..n]);
        if let (Some(s), Some(end)) = (sink, all.iter().rposition(|&b| b == b'\n' || b == b'\r'))
            && end + 1 > sent
        {
            s(&String::from_utf8_lossy(&all[sent..=end]));
            sent = end + 1;
        }
    }
    if let Some(s) = sink.filter(|_| sent < all.len()) {
        s(&String::from_utf8_lossy(&all[sent..]));
    }
    all
}

/// Output as a terminal would leave it: a `\r` redraws its line (progress counters), so keep the last draw.
fn settle(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').map(|l| l.trim_end_matches('\r').rsplit('\r').next().unwrap_or("")).collect();
    lines.join("\n").trim().to_string()
}

/// `git <base> -- <paths>` in chunks. Callers put `--literal-pathspecs` in `base`: a file called
/// `a[1].txt` or `:(exclude)x` must name itself, not act as a pattern.
fn git_paths(repo: &str, base: &[&str], paths: &[String]) -> Result<(), String> {
    if let Some(bad) = paths.iter().find(|p| p.is_empty() || p.contains('\0')) {
        return Err(format!("bad path: {bad:?}"));
    }
    for chunk in paths.chunks(PATH_CHUNK) {
        let mut args = base.to_vec();
        args.push("--");
        args.extend(chunk.iter().map(String::as_str));
        git_out(repo, &args)?;
    }
    Ok(())
}

fn has_head(repo: &str) -> bool {
    git(repo, &["rev-parse", "-q", "--verify", "HEAD"]).is_ok()
}

fn status(repo: &str) -> Result<Status, String> {
    let out = git(repo, &["status", "--porcelain=v2", "-z", "--untracked-files=all"])?;
    let mut st = parse_status(&out);
    // one rev-parse for both checks (each git call is a process spawn; a round trip over ssh adds nothing here,
    // but Status is the poll)
    let p = git_dir_paths(repo, &["MERGE_HEAD", "MERGE_MSG", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"])?;
    st.merge = merge_message_at(&p[0], &p[1]);
    st.op = op_at(&p[2..]).map(String::from);
    if st.op.is_some() {
        st.edit = edit_stop(repo)?;
    }
    Ok(st)
}

/// The dashboard's row: one `status --branch` (the same parser as `Status`) and one `log -1`, both hardened reads.
fn overview(repo: &str) -> Result<Overview, String> {
    // fsmonitor off as well: the built-in daemon would start a background process for every listed repository
    let out = git(repo, &["-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])?;
    let st = parse_status(&out);
    let mut o = Overview { changed: st.files.len() as u32, truncated: st.truncated, ..Default::default() };
    let (mut born, mut tracked) = (true, false);
    for h in out.split('\0').filter_map(|r| r.strip_prefix("# branch.")) {
        match h.split_once(' ') {
            Some(("oid", "(initial)")) => born = false,
            Some(("head", b)) if b != "(detached)" => o.branch = Some(b.into()),
            Some(("upstream", u)) => o.upstream = Some(u.into()),
            Some(("ab", ab)) => {
                // `+3 -1`; missing when the upstream is gone
                let mut n = ab.split(' ').map(|x| x.trim_start_matches(['+', '-']).parse::<u32>().unwrap_or(0));
                (o.ahead, o.behind, tracked) = (n.next().unwrap_or(0), n.next().unwrap_or(0), true);
            }
            _ => {}
        }
    }
    if !tracked {
        o.upstream = None;
    }
    if born {
        let last = git(repo, &["log", "-1", "--no-ext-diff", "--no-textconv", "--format=%ct%x1f%s", "HEAD"])?;
        if let Some((t, s)) = last.trim_end_matches('\n').split_once(FIELD) {
            (o.time, o.subject) = (t.parse().ok(), Some(s.to_string()));
        }
    }
    Ok(o)
}

/// The rebase, cherry-pick or revert that stopped half-way (a merge is `merge_message`).
fn in_progress(repo: &str) -> Result<Option<&'static str>, String> {
    Ok(op_at(&git_dir_paths(repo, &["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"])?))
}

/// `git rev-parse --git-path` for each name: paths come back relative to the repo dir (absolute for linked
/// worktrees); `join` keeps absolute ones.
fn git_dir_paths(repo: &str, names: &[&str]) -> Result<Vec<std::path::PathBuf>, String> {
    let mut args = vec!["rev-parse"];
    for n in names {
        args.extend(["--git-path", n]);
    }
    let out = git(repo, &args)?;
    let dir = expand(repo);
    let paths: Vec<_> = out.lines().map(|p| Path::new(&dir).join(p)).collect();
    if paths.len() != names.len() {
        return Err(format!("git rev-parse --git-path: expected {} paths, got {}", names.len(), paths.len()));
    }
    Ok(paths)
}

/// From the rebase-merge, rebase-apply, CHERRY_PICK_HEAD, REVERT_HEAD paths.
fn op_at(p: &[std::path::PathBuf]) -> Option<&'static str> {
    match p.iter().map(|p| p.exists()).collect::<Vec<_>>()[..] {
        [true, ..] | [_, true, ..] => Some("rebase"),
        [_, _, true, _] => Some("cherry-pick"),
        [_, _, _, true] => Some("revert"),
        _ => None,
    }
}

/// `--continue`/`--skip`/`--abort` of whatever is in progress; decided here, from the repo, not from a stale UI.
fn sequence(repo: &str, action: SeqAction) -> Result<(), String> {
    let op = match in_progress(repo)? {
        Some(op) => op,
        None if merge_message(repo)?.is_some() => "merge",
        None => return Err("No rebase, cherry-pick, revert or merge is in progress.".into()),
    };
    let flag = match action {
        SeqAction::Continue => "--continue",
        SeqAction::Abort => "--abort",
        SeqAction::Skip if op == "merge" => return Err("A merge cannot skip; continue or abort it.".into()),
        SeqAction::Skip => "--skip",
    };
    git_out(repo, &[op, flag]).map(|_| ())
}

/// MERGE_MSG when a merge is in progress (MERGE_HEAD exists), with git's `#` comment lines kept.
fn merge_message(repo: &str) -> Result<Option<String>, String> {
    let p = git_dir_paths(repo, &["MERGE_HEAD", "MERGE_MSG"])?;
    Ok(merge_message_at(&p[0], &p[1]))
}

fn merge_message_at(head: &Path, msg: &Path) -> Option<String> {
    head.exists().then(|| std::fs::read_to_string(msg).unwrap_or_default())
}

/// Porcelain v2 with -z: `1 XY sub mH mI mW hH hI path`, `2 XY sub mH mI mW hH hI Xscore path\0orig`,
/// `u XY sub m1 m2 m3 mW h1 h2 h3 path`, `? path`.
fn parse_status(out: &str) -> Status {
    let mut files = Vec::new();
    let mut truncated = false;
    let mut it = out.split('\0');
    while let Some(rec) = it.next() {
        let kind = rec.as_bytes().first().copied();
        let xy = |s: &str| {
            let mut c = s.chars();
            (c.next().unwrap_or('.'), c.next().unwrap_or('.'))
        };
        let file = match kind {
            Some(b'1') => {
                let f: Vec<&str> = rec.splitn(9, ' ').collect();
                (f.len() == 9).then(|| {
                    let (index, worktree) = xy(f[1]);
                    WorkFile { path: f[8].into(), old_path: None, index, worktree, kind: WorkKind::Changed }
                })
            }
            Some(b'2') => {
                let f: Vec<&str> = rec.splitn(10, ' ').collect();
                let orig = it.next().unwrap_or("").to_string(); // always consume: it is a separate -z record
                (f.len() == 10).then(|| {
                    let (index, worktree) = xy(f[1]);
                    WorkFile { path: f[9].into(), old_path: Some(orig), index, worktree, kind: WorkKind::Changed }
                })
            }
            Some(b'u') => {
                let f: Vec<&str> = rec.splitn(11, ' ').collect();
                (f.len() == 11).then(|| WorkFile { path: f[10].into(), old_path: None, index: 'U', worktree: 'U', kind: WorkKind::Conflicted })
            }
            Some(b'?') => rec.strip_prefix("? ").map(|p| WorkFile { path: p.into(), old_path: None, index: '.', worktree: '?', kind: WorkKind::Untracked }),
            _ => None,
        };
        if let Some(f) = file {
            if files.len() >= MAX_STATUS {
                truncated = true;
                break;
            }
            files.push(f);
        }
    }
    Status { files, truncated, merge: None, op: None, edit: None }
}

fn work_diff(repo: &str, path: &str, old_path: Option<&str>, (staged, untracked, conflicted): (bool, bool, bool), (context, ignore_ws): (u32, bool)) -> Result<Patch, String> {
    let unified = format!("-U{}", context.min(MAX_CONTEXT));
    let mut args = vec!["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", &unified];
    if ignore_ws {
        args.push("-w");
    }
    if conflicted {
        // plain `git diff` gives a combined (--cc) diff for unmerged paths; against HEAD it is a normal one
        args.extend(["HEAD", "--", path]);
    } else if untracked {
        // not known to git yet: diff against nothing (exit status 1 just means "they differ")
        args.extend(["--no-index", "--", "/dev/null", path]);
    } else {
        if staged {
            args.extend(["--cached", "-M"]);
        }
        args.extend(["--", path]);
        args.extend(old_path);
    }
    let (bytes, cut) = git_capped(repo, &args, PATCH_LIMIT, untracked)?;
    Ok(Patch { text: capped_text(bytes, cut), truncated: cut })
}

fn unstage(repo: &str, paths: &[String]) -> Result<(), String> {
    if has_head(repo) {
        git_paths(repo, &["--literal-pathspecs", "restore", "--staged"], paths)
    } else {
        // no commits yet: there is no HEAD to restore from, just forget the paths
        git_paths(repo, &["--literal-pathspecs", "rm", "-r", "--cached", "-q"], paths)
    }
}

/// Tracked files go back to their index content; untracked files are deleted. Decided here, from a fresh
/// status, so a stale UI cannot delete a file it believes is tracked.
fn discard(repo: &str, paths: &[String]) -> Result<(), String> {
    let st = status(repo)?;
    let untracked = |p: &String| st.files.iter().any(|f| f.kind == WorkKind::Untracked && &f.path == p);
    let (gone, tracked): (Vec<String>, Vec<String>) = paths.iter().cloned().partition(untracked);
    git_paths(repo, &["--literal-pathspecs", "restore", "--worktree"], &tracked)?;
    git_paths(repo, &["--literal-pathspecs", "clean", "-f", "-d", "-q"], &gone)
}

fn apply(repo: &str, patch: &str, mode: ApplyMode) -> Result<(), String> {
    if patch.len() > MAX_PATCH_IN {
        return Err("patch too large".into());
    }
    let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
    // a diff shown with 0 context lines has hunks git apply refuses unless told
    if !patch.lines().any(|l| l.starts_with(' ')) {
        args.push("--unidiff-zero");
    }
    args.extend(match mode {
        ApplyMode::Stage => &["--cached"][..],
        ApplyMode::Unstage => &["--cached", "--reverse"][..],
        ApplyMode::Discard => &["--reverse"][..],
        ApplyMode::Worktree => &[][..],
    });
    args.push("-");
    git_stdin(repo, &args, patch.as_bytes()).map(|_| ())
}

fn commit(repo: &str, message: &str, amend: bool, signoff: bool, no_verify: bool) -> Result<(), String> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err("Commit message is empty.".into());
    }
    // gpg signing, hooks and identity all come from the user's own git config.
    let mut args = vec!["commit", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    if signoff {
        args.push("--signoff");
    }
    if no_verify {
        args.push("--no-verify");
    }
    git_stdin(repo, &args, msg.as_bytes()).map(|_| ())
}

/// Run `base` plus flags the UI picked; anything outside `allowed` is refused (never pass arbitrary options to git).
fn git_flags(repo: &str, base: &[&str], flags: &[String], allowed: &[&str], tail: &[&str]) -> Result<(), String> {
    let mut args = base.to_vec();
    for (i, f) in flags.iter().enumerate() {
        if flags[..i].contains(f) {
            return Err(format!("repeated flag: {f}"));
        }
        args.push(allowed.iter().find(|&&k| k == f).ok_or_else(|| format!("unsupported flag: {f}"))?);
    }
    args.extend(tail);
    git_out(repo, &args).map(|_| ())
}

/// A user-typed argument for git: never empty, never read as an option, one line.
fn plain_arg<'a>(what: &str, v: &'a str) -> Result<&'a str, String> {
    if v.trim().is_empty() || v.starts_with('-') || v.contains(['\0', '\n']) {
        return Err(format!("bad {what}: {v:?}"));
    }
    Ok(v)
}

fn add_worktree(repo: &str, path: &str, branch: Option<&str>) -> Result<(), String> {
    let mut args = vec!["worktree", "add", "--", plain_arg("path", path)?];
    if let Some(b) = branch {
        args.push(plain_arg("branch", b)?);
    }
    git_out(repo, &args).map(|_| ())
}

fn add_submodule(repo: &str, url: &str, path: Option<&str>) -> Result<(), String> {
    let mut args = vec!["submodule", "add", "--", plain_arg("url", url)?];
    if let Some(p) = path {
        args.push(plain_arg("path", p)?);
    }
    git_out(repo, &args).map(|_| ())
}

/// `base` + `-- <path>` when `path` is one of the repo's submodules (by `git submodule status`), else refused.
fn with_submodule<'a>(repo: &str, mut base: Vec<&'a str>, path: Option<&'a str>) -> Result<Vec<&'a str>, String> {
    if let Some(p) = path {
        let listed = parse_submodules(&git(repo, &["submodule", "status"]).unwrap_or_default());
        if !listed.iter().any(|m| m.path == p) {
            return Err(format!("not a submodule: {p:?}"));
        }
        base.extend(["--", p]);
    }
    Ok(base)
}

/// `stash@{n}` that still names the stash with id `oid` (the list may have shifted since the UI read it).
fn stash_entry<'a>(repo: &str, stash: &'a str, oid: &str) -> Result<&'a str, String> {
    let n = stash.strip_prefix("stash@{").and_then(|r| r.strip_suffix('}'));
    if !n.is_some_and(|n| !n.is_empty() && n.len() < 10 && n.bytes().all(|b| b.is_ascii_digit())) {
        return Err(format!("not a stash: {stash:?}"));
    }
    check_oid(oid)?;
    let now = git(repo, &["rev-parse", "-q", "--verify", &format!("{stash}^{{commit}}")]).map_err(|_| format!("{stash} no longer exists"))?;
    if now.trim() != oid {
        return Err(format!("The stash list changed: {stash} is a different stash now. Refresh and try again."));
    }
    Ok(stash)
}

fn checkout(repo: &str, name: &str) -> Result<(), String> {
    // a leading '-' would be read as an option
    if name.is_empty() || name.starts_with('-') || name.contains(['\0', '\n']) {
        return Err(format!("bad branch name: {name:?}"));
    }
    git_out(repo, &["checkout", name, "--"]).map(|_| ())
}

// ---- M5a: branch/ref arguments. Everything here becomes a git argument, so it is checked before git sees it.

/// A short name for a new branch (`prefix` `refs/heads/`) or tag (`refs/tags/`): no option-like or blank values,
/// and git itself must accept it as a ref (`git check-ref-format`).
fn ref_name<'a>(repo: &str, prefix: &str, name: &'a str) -> Result<&'a str, String> {
    // `@` and `HEAD` pass check-ref-format but read as HEAD everywhere else
    let plain = !name.is_empty() && !name.starts_with('-') && !matches!(name, "@" | "HEAD") && !name.chars().any(|c| c.is_whitespace() || c.is_control());
    if !plain || git(repo, &["check-ref-format", &format!("{prefix}{name}")]).is_err() {
        return Err(format!("not a valid name: {name:?}"));
    }
    Ok(name)
}

fn exists(repo: &str, full: &str) -> bool {
    git(repo, &["show-ref", "--verify", "-q", full]).is_ok()
}

/// An existing local branch, by short name.
fn local_branch<'a>(repo: &str, name: &'a str) -> Result<&'a str, String> {
    ref_name(repo, "refs/heads/", name)?;
    if !exists(repo, &format!("refs/heads/{name}")) {
        return Err(format!("no branch named {name:?}"));
    }
    Ok(name)
}

/// An existing tag, by short name.
fn tag<'a>(repo: &str, name: &'a str) -> Result<&'a str, String> {
    ref_name(repo, "refs/tags/", name)?;
    if !exists(repo, &format!("refs/tags/{name}")) {
        return Err(format!("no tag named {name:?}"));
    }
    Ok(name)
}

/// A commit the UI picked: a full commit id, or the full name of an existing branch, remote branch or tag.
fn commit_rev<'a>(repo: &str, rev: &'a str) -> Result<&'a str, String> {
    if valid_oid(rev) {
        return Ok(rev);
    }
    let named = ["refs/heads/", "refs/remotes/", "refs/tags/"].iter().any(|p| rev.strip_prefix(p).is_some_and(|n| !n.is_empty()));
    let plain = !rev.chars().any(|c| c.is_whitespace() || c.is_control());
    if named && plain && git(repo, &["check-ref-format", rev]).is_ok() && exists(repo, rev) {
        Ok(rev)
    } else {
        Err(format!("not a commit id or ref: {rev:?}"))
    }
}

fn remotes(repo: &str) -> Vec<String> {
    git(repo, &["remote"]).unwrap_or_default().lines().map(String::from).collect()
}

/// One of the repo's remotes.
fn remote_name<'a>(repo: &str, name: &'a str) -> Result<&'a str, String> {
    if remotes(repo).iter().any(|r| r == name) { Ok(name) } else { Err(format!("no remote named {name:?}")) }
}

/// `refs/remotes/<remote>/<branch>` split at the longest configured remote (remote names may contain `/`).
fn remote_branch(repo: &str, full: &str) -> Result<(String, String), String> {
    commit_rev(repo, full)?;
    let rest = full.strip_prefix("refs/remotes/").ok_or_else(|| format!("not a remote branch: {full:?}"))?;
    let remote = remotes(repo).into_iter().filter(|r| rest.strip_prefix(r.as_str()).is_some_and(|b| b.len() > 1 && b.starts_with('/'))).max_by_key(String::len);
    let remote = remote.ok_or_else(|| format!("no remote for {full:?}"))?;
    let branch = rest[remote.len() + 1..].to_string();
    Ok((remote, branch))
}

fn create_branch(repo: &str, name: &str, from: Option<&str>, checkout: bool) -> Result<(), String> {
    let name = ref_name(repo, "refs/heads/", name)?;
    let from = from.map(|f| commit_rev(repo, f)).transpose()?;
    let mut args = if checkout { vec!["checkout", "-b", name] } else { vec!["branch", "--", name] };
    args.extend(from);
    if checkout {
        args.push("--"); // checkout: what follows `--` would be paths, so it closes the list
    }
    git_out(repo, &args).map(|_| ())
}

fn create_tag(repo: &str, name: &str, rev: &str, message: Option<&str>) -> Result<(), String> {
    let (name, rev) = (ref_name(repo, "refs/tags/", name)?, commit_rev(repo, rev)?);
    match message.map(str::trim) {
        Some("") => Err("An annotated tag needs a message.".into()),
        Some(m) => git_stdin(repo, &["tag", "-a", "-F", "-", "--", name, rev], m.as_bytes()).map(|_| ()),
        None => git_out(repo, &["tag", "--", name, rev]).map(|_| ()),
    }
}

fn set_upstream(repo: &str, branch: &str, upstream: Option<&str>) -> Result<(), String> {
    let b = local_branch(repo, branch)?;
    match upstream {
        Some(u) => {
            if !u.starts_with("refs/remotes/") {
                return Err(format!("not a remote branch: {u:?}"));
            }
            let u = format!("--set-upstream-to={}", commit_rev(repo, u)?);
            git_out(repo, &["branch", &u, "--", b]).map(|_| ())
        }
        None => git_out(repo, &["branch", "--unset-upstream", "--", b]).map(|_| ()),
    }
}

// ---- M5b: push target, remotes, undo/redo

/// `git push` with flags from a fixed list; with `remote` + `branch`, that branch to its upstream branch on that
/// remote, or to the same name there with `--set-upstream` when it has no upstream yet.
fn push(repo: &str, flags: &[String], remote: Option<&str>, branch: Option<&str>) -> Result<(), String> {
    const FLAGS: &[&str] = &["--force", "--force-with-lease", "--no-verify"];
    let (remote, branch) = match (remote, branch) {
        (None, None) => return git_flags(repo, &["push", "--progress"], flags, FLAGS, &[]),
        (Some(r), Some(b)) => (remote_name(repo, r)?, local_branch(repo, b)?),
        _ => return Err("push needs both a remote and a branch".into()),
    };
    let config = |key: &str| git(repo, &["config", "--get", &format!("branch.{branch}.{key}")]).ok().map(|s| s.trim().to_string());
    let (up_remote, up_merge) = (config("remote"), config("merge"));
    // the upstream's name on that remote, if it is a plain branch there (our refspec; git checks the name again)
    let dst = up_merge.filter(|m| up_remote.as_deref() == Some(remote) && m.starts_with("refs/heads/") && !m.chars().any(|c| c.is_whitespace() || c.is_control() || c == ':'));
    let base: &[&str] = if up_remote.is_none() { &["push", "--progress", "--set-upstream"] } else { &["push", "--progress"] };
    let spec = format!("refs/heads/{branch}:{}", dst.unwrap_or_else(|| format!("refs/heads/{branch}")));
    git_flags(repo, base, flags, FLAGS, &["--", remote, &spec])
}

/// A name for a new remote: no option-like or blank values, and git's own rule (`refs/remotes/<name>/x` is a ref).
fn remote_new_name<'a>(repo: &str, name: &'a str) -> Result<&'a str, String> {
    let plain = !name.is_empty() && !name.starts_with('-') && !name.chars().any(|c| c.is_whitespace() || c.is_control());
    if !plain || git(repo, &["check-ref-format", &format!("refs/remotes/{name}/x")]).is_err() {
        return Err(format!("not a valid remote name: {name:?}"));
    }
    Ok(name)
}

/// A remote URL or path: one line, not option-like, and not git's command-running `ext::` transport.
fn remote_url(url: &str) -> Result<&str, String> {
    let u = url.trim();
    if u.is_empty() || u.starts_with('-') || u.chars().any(|c| c.is_control()) || u.to_ascii_lowercase().starts_with("ext::") {
        return Err(format!("not a valid remote URL: {url:?}"));
    }
    Ok(u)
}

pub const REPO_CHANGED: &str = "The repository changed since; it can no longer be undone.";

/// A ref Undo may move: a local branch or tag with a plain, valid name (stash handled on its own).
fn undo_ref(repo: &str, name: &str) -> Result<bool, String> {
    if !["refs/heads/", "refs/tags/"].iter().any(|p| name.strip_prefix(p).is_some_and(|n| !n.is_empty())) {
        return Ok(false); // remote-tracking and other refs are not restored
    }
    if name.chars().any(|c| c.is_whitespace() || c.is_control()) || git(repo, &["check-ref-format", name]).is_err() {
        return Err(format!("bad ref name: {name:?}"));
    }
    Ok(true)
}

fn undo_oid(o: &Option<String>) -> Result<(), String> {
    o.as_deref().map_or(Ok(()), check_oid)
}

/// Undo (or redo) a journal entry: put HEAD and the local branches/tags it moved back to their other side, and
/// re-add a stash it popped. Refuses instead of touching anything that is not exactly as the entry left it.
fn undo(repo: &str, m: &Moved, redo: bool, mode: UndoMode, check: bool) -> Result<(), String> {
    let (from, to) = if redo { (&m.head_before, &m.head_after) } else { (&m.head_after, &m.head_before) };
    for h in [from, to] {
        undo_oid(&h.oid)?;
        if let Some(b) = &h.branch
            && !(b.starts_with("refs/heads/") && undo_ref(repo, b)?)
        {
            return Err(format!("bad HEAD branch: {b:?}"));
        }
    }
    let (Some(from_oid), Some(to_oid)) = (from.oid.as_deref(), to.oid.as_deref()) else {
        return Err("Undo needs a commit on both sides; the first commit of a repository can't be undone.".into());
    };
    // (name, now, target)
    let (mut moves, mut stash) = (Vec::new(), None);
    for r in &m.refs {
        let (now, target) = if redo { (&r.before, &r.after) } else { (&r.after, &r.before) };
        undo_oid(now)?;
        undo_oid(target)?;
        if r.name == "refs/stash" {
            stash = Some((now.clone(), target.clone()));
        } else if undo_ref(repo, &r.name)? {
            moves.push((r.name.clone(), now.clone(), target.clone()));
        }
    }
    if moves.is_empty() && stash.is_none() && from == to {
        return Err("Nothing to undo here: it only changed remote-tracking branches.".into());
    }
    if in_progress(repo)?.is_some() || merge_message(repo)?.is_some() {
        return Err("Finish or abort the merge, rebase, cherry-pick or revert in progress first.".into());
    }
    let (head, refs) = snapshot(repo)?;
    if head != *from || moves.iter().any(|(n, now, _)| refs.get(n) != now.as_ref()) {
        return Err(REPO_CHANGED.into());
    }
    if let Some(b) = &to.branch {
        let at = moves.iter().find(|(n, ..)| n == b).map_or_else(|| refs.get(b).cloned(), |(.., t)| t.clone());
        if at.as_deref() != Some(to_oid) {
            return Err(REPO_CHANGED.into());
        }
    }
    if let Some((now, target)) = &stash {
        if refs.get("refs/stash") != now.as_ref() {
            return Err(REPO_CHANGED.into());
        }
        // only re-adding a popped stash; going the other way would drop one (its changes may exist nowhere else)
        let listed = git(repo, &["log", "--walk-reflogs", "--format=%H", "refs/stash", "--"]).unwrap_or_default();
        if target.as_ref().is_none_or(|t| listed.lines().any(|l| l == t)) {
            return Err("Undo would drop a stash; pop, apply or drop it yourself instead.".into());
        }
    }
    // a branch checked out in another worktree must not move under it
    let root = git(repo, &["rev-parse", "--show-toplevel"])?;
    let others = parse_worktrees(&git(repo, &["worktree", "list", "--porcelain"])?, root.trim());
    let current = from.branch.as_ref();
    for (n, ..) in moves.iter().filter(|(n, ..)| Some(n) != current) {
        if let Some(short) = n.strip_prefix("refs/heads/")
            && others.iter().any(|w| !w.current && w.branch.as_deref() == Some(short))
        {
            return Err(format!("{short} is checked out in another worktree."));
        }
    }
    let switch = from.branch != to.branch;
    if from_oid != to_oid && (switch || mode == UndoMode::Keep) {
        // like `reset --keep` / `checkout`: refuse when a file to update has local changes
        let changed = git(repo, &["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", from_oid, to_oid, "--"])?;
        let changed: std::collections::HashSet<&str> = changed.split('\0').filter(|p| !p.is_empty()).collect();
        let st = status(repo)?;
        let local = st.files.iter().flat_map(|f| std::iter::once(&f.path).chain(&f.old_path)).find(|p| changed.contains(p.as_str()));
        if let Some(p) = local {
            return Err(format!("Undo would overwrite local changes to {p}; commit or stash them first."));
        }
    }
    if from_oid != to_oid && !switch && mode == UndoMode::Mixed && git(repo, &["diff", "--cached", "--quiet", "--no-ext-diff", "HEAD", "--"]).is_err() {
        return Err("Undo would reset the staged changes; commit or unstage them first.".into());
    }
    if check {
        return Ok(());
    }

    let (own, rest): (Vec<_>, Vec<_>) = moves.into_iter().partition(|(n, ..)| Some(n) == current);
    update_refs(repo, &rest, false)?;
    let head_moved = if switch {
        match &to.branch {
            Some(b) => git_out(repo, &["checkout", b.trim_start_matches("refs/heads/"), "--"]),
            None => git_out(repo, &["checkout", "--detach", to_oid, "--"]),
        }
    } else if from_oid != to_oid {
        let flag = match mode {
            UndoMode::Soft => "--soft",
            UndoMode::Mixed => "--mixed",
            UndoMode::Keep => "--keep",
        };
        git_out(repo, &["reset", "-q", flag, to_oid, "--"])
    } else {
        Ok(String::new())
    };
    if let Err(e) = head_moved {
        let _ = update_refs(repo, &rest, true); // put the other refs back: all or nothing
        return Err(e);
    }
    // the branch HEAD left: reset already moved it when HEAD stayed on it
    if switch {
        update_refs(repo, &own, false)?;
    }
    if let Some((_, Some(oid))) = stash {
        let msg = git(repo, &["show", "-s", "--format=%s", &oid])?;
        git_out(repo, &["stash", "store", "-q", "-m", msg.trim(), &oid])?;
    }
    Ok(())
}

/// One `update-ref --stdin` transaction (all or nothing, each ref checked against its expected value).
/// `back`: the inverse, to roll back.
fn update_refs(repo: &str, moves: &[(String, Option<String>, Option<String>)], back: bool) -> Result<(), String> {
    let mut input = String::new();
    for (name, now, target) in moves {
        let (old, new) = if back { (target, now) } else { (now, target) };
        input += &match (old, new) {
            (Some(o), Some(n)) => format!("update {name} {n} {o}\n"),
            (None, Some(n)) => format!("create {name} {n}\n"),
            (Some(o), None) => format!("delete {name} {o}\n"),
            (None, None) => continue,
        };
    }
    if input.is_empty() {
        return Ok(());
    }
    git_stdin(repo, &["update-ref", "-m", "commit.kiwi: undo", "--stdin"], input.as_bytes()).map(|_| ())
}

fn identity(repo: &str) -> String {
    // useConfigOnly: no name@hostname guesses; config or GIT_AUTHOR_* env only, else "" ("Click here to set user details")
    let Ok(ident) = git(repo, &["-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"]) else { return String::new() };
    // "Name <email> 1699999999 +0100": drop the timestamp and zone
    let mut parts: Vec<&str> = ident.trim().rsplitn(3, ' ').collect();
    parts.pop().unwrap_or("").to_string()
}

fn set_identity(repo: &str, name: &str, email: &str) -> Result<(), String> {
    let (name, email) = (name.trim(), email.trim());
    if name.is_empty() || email.is_empty() || name.starts_with('-') || email.starts_with('-') || format!("{name}{email}").contains(['\0', '\n', '<', '>']) {
        return Err("Enter a name and an email address.".into());
    }
    git_out(repo, &["config", "--global", "user.name", name])?;
    git_out(repo, &["config", "--global", "user.email", email]).map(|_| ())
}

/// Resolve a conflict with one whole side; a side that deleted the file resolves by deleting it.
fn resolve(repo: &str, path: &str, theirs: bool) -> Result<(), String> {
    let stage = if theirs { 3 } else { 2 };
    let stages = unmerged_stages(repo, path)?;
    if stages.is_empty() {
        return Err(format!("{path} has no merge conflict"));
    }
    if !stages.iter().any(|s| s.2 == stage) {
        return git_out(repo, &["--literal-pathspecs", "rm", "-q", "--", path]).map(|_| ());
    }
    let side = if theirs { "--theirs" } else { "--ours" };
    git_out(repo, &["--literal-pathspecs", "checkout", side, "--", path])?;
    git_out(repo, &["--literal-pathspecs", "add", "--", path]).map(|_| ())
}

/// gitignore syntax: `*?[]\` are special inside a pattern; a trailing space needs a backslash.
fn ignore_entry(path: &str) -> String {
    let mut e = String::from("/");
    for c in path.chars() {
        if "*?[]\\".contains(c) {
            e.push('\\');
        }
        e.push(c);
    }
    if e.ends_with(' ') {
        e.insert(e.len() - 1, '\\');
    }
    e
}

fn ignore(repo: &str, path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains(['\0', '\n']) {
        return Err(format!("bad path: {path:?}"));
    }
    let root = git(repo, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let file = Path::new(&root).join(".gitignore");
    let err = |e: std::io::Error| format!("cannot write .gitignore: {e}");
    // a repo could make .gitignore a symlink to any file of the user's: never write through one
    let mut text = match std::fs::symlink_metadata(&file) {
        Ok(m) if !m.is_file() => return Err(".gitignore is not a regular file; not changing it".into()),
        Ok(_) => std::fs::read_to_string(&file).map_err(err)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(err(e)),
    };
    let entry = ignore_entry(path);
    if text.lines().any(|l| l == entry) {
        return Ok(());
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&entry);
    text.push('\n');
    // temp file + rename: never a half-written .gitignore, and rename replaces a path, it doesn't follow it.
    // create_new (O_EXCL) refuses a pre-planted file or symlink at the temp name.
    let tmp = Path::new(&root).join(format!(".gitignore.{}.tmp", std::process::id()));
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(err)?;
    let written = std::io::Write::write_all(&mut f, text.as_bytes()).and_then(|()| std::fs::rename(&tmp, &file));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map_err(err)
}

// ---- M6: merge tool (conflict stages, save) and commit editing (scripted rebase)

/// A repo-relative path from the UI: plain components only (no `..`, no absolute paths, no empty parts).
fn plain_path(path: &str) -> Result<&Path, String> {
    let rel = Path::new(path);
    if path.is_empty() || path.contains('\0') || !rel.components().all(|c| matches!(c, std::path::Component::Normal(_))) {
        return Err(format!("bad path: {path:?}"));
    }
    Ok(rel)
}

/// `git ls-files -u` of one path: (mode, blob id, stage 1..3).
fn unmerged_stages(repo: &str, path: &str) -> Result<Vec<(String, String, u8)>, String> {
    plain_path(path)?;
    let out = git(repo, &["--literal-pathspecs", "ls-files", "-u", "-z", "--", path])?;
    let mut stages = Vec::new();
    for rec in out.split('\0').filter(|r| !r.is_empty()) {
        let (meta, p) = rec.split_once('\t').ok_or("unexpected ls-files output")?;
        let f: Vec<&str> = meta.split(' ').collect();
        let (&[mode, oid, stage], true) = (&f[..], p == path) else { continue };
        check_oid(oid)?;
        if let Ok(n @ 1..=3) = stage.parse::<u8>() {
            stages.push((mode.to_string(), oid.to_string(), n));
        }
    }
    Ok(stages)
}

fn conflict(repo: &str, path: &str) -> Result<ConflictFile, String> {
    let stages = unmerged_stages(repo, path)?;
    if stages.is_empty() {
        return Err(format!("{path} has no merge conflict"));
    }
    let side = |n: u8| -> Result<Option<ConflictSide>, String> {
        let Some((mode, oid, _)) = stages.iter().find(|s| s.2 == n) else { return Ok(None) };
        let blob = if mode == "160000" {
            let t = format!("Subproject commit {oid}\n");
            Blob { size: t.len() as u64, text: Some(t), binary: false, truncated: false }
        } else {
            let (bytes, cut, size) = read_spec(repo, oid, BLOB_LIMIT)?;
            to_blob(bytes, cut, size)
        };
        Ok(Some(ConflictSide { mode: mode.clone(), blob }))
    };
    let root = git(repo, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let merged = match std::fs::symlink_metadata(Path::new(&root).join(plain_path(path)?)) {
        Ok(_) => Some(blob(&root, "worktree", path)?),
        Err(_) => None,
    };
    let verify = |r: &str| git(repo, &["rev-parse", "-q", "--verify", &format!("{r}^{{commit}}")]).ok().map(|s| s.trim().to_string()).filter(|s| valid_oid(s));
    let theirs_commit = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"].iter().find_map(|r| verify(r));
    Ok(ConflictFile { base: side(1)?, ours: side(2)?, theirs: side(3)?, merged, ours_commit: verify("HEAD"), theirs_commit })
}

/// Write the merge tool's text over an unmerged file: inside the repo, no symlink anywhere on the way (a repo could
/// point one at any file of the user's), temp file + rename in the same folder (never half-written), mode kept.
fn save_merge(repo: &str, path: &str, text: &str, stage: bool) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    if text.len() > MAX_PATCH_IN {
        return Err("file too large".into());
    }
    let stages = unmerged_stages(repo, path)?;
    if stages.is_empty() {
        return Err(format!("{path} has no merge conflict"));
    }
    let root = git(repo, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let rel = plain_path(path)?;
    let err = |e: std::io::Error| format!("cannot write {path}: {e}");
    let mut dir = std::path::PathBuf::from(&root);
    if let Some(parent) = rel.parent() {
        for c in parent.components() {
            dir.push(c);
            match std::fs::symlink_metadata(&dir) {
                Ok(m) if m.is_dir() => {}
                Ok(_) => return Err(format!("{} is not a folder (or is a symlink); not writing {path}", dir.display())),
                Err(e) => return Err(err(e)),
            }
        }
    }
    let file = Path::new(&root).join(rel);
    let mode = match std::fs::symlink_metadata(&file) {
        Ok(m) if m.is_file() => m.permissions().mode() & 0o777,
        Ok(_) => return Err(format!("{path} is not a regular file (or is a symlink); resolve it with a whole side instead")),
        // missing (deleted on our side): ours' or theirs' mode
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if stages.iter().any(|s| s.0 == "100755") { 0o755 } else { 0o644 }
        }
        Err(e) => return Err(err(e)),
    };
    let name = rel.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let tmp = dir.join(format!(".{name}.commitkiwi-{}-{nanos}.tmp", std::process::id()));
    // create_new (O_EXCL) refuses a pre-planted file or symlink at the temp name; rename replaces the path itself
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(mode).open(&tmp).map_err(err)?;
    let written = std::io::Write::write_all(&mut f, text.as_bytes())
        .and_then(|()| f.set_permissions(std::fs::Permissions::from_mode(mode)))
        .and_then(|()| std::fs::rename(&tmp, &file));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map_err(err)?;
    if stage {
        git_out(repo, &["--literal-pathspecs", "add", "--", path])?;
    }
    Ok(())
}

/// The commit a rebase stopped at for an `edit` line (git writes `rebase-merge/amend` only then).
fn edit_stop(repo: &str) -> Result<Option<String>, String> {
    let p = git(repo, &["rev-parse", "--git-path", "rebase-merge/amend"])?;
    let oid = std::fs::read_to_string(Path::new(&expand(repo)).join(p.trim())).unwrap_or_default().trim().to_string();
    Ok(valid_oid(&oid).then_some(oid))
}

/// Start of the error a `Rewrite` of commits on a remote-tracking branch gets (the UI asks, then retries).
pub const PUBLISHED: &str = "PUBLISHED";
/// The furthest back a rewrite may reach (commits in its todo list).
const MAX_REWRITE: usize = 1000;

/// The todo list for `git rebase -i`: `list` is the range, oldest first (full ids from `rev-list`, never user text).
fn rewrite_todo(action: RewriteAction, list: &[String], picked: &[String]) -> Result<Vec<String>, String> {
    let at = |c: &String| list.iter().position(|x| x == c).ok_or_else(|| format!("{c} is not on the current branch"));
    let mut todo: Vec<(&str, &str)> = list.iter().map(|o| ("pick", o.as_str())).collect();
    let one = || match picked {
        [c] => at(c),
        _ => Err("Pick exactly one commit for this.".to_string()),
    };
    match action {
        RewriteAction::Reword => todo[one()?].0 = "reword",
        RewriteAction::Edit => todo[one()?].0 = "edit",
        RewriteAction::Drop => {
            for c in picked {
                todo[at(c)?].0 = "drop";
            }
        }
        RewriteAction::MoveUp => {
            let i = one()?;
            if i + 1 >= todo.len() {
                return Err("It is already the newest commit of the branch.".into());
            }
            todo.swap(i, i + 1);
        }
        RewriteAction::MoveDown => {
            let i = one()?;
            if i == 0 {
                return Err("It is the first commit; it cannot move down.".into());
            }
            todo.swap(i - 1, i);
        }
        RewriteAction::Squash | RewriteAction::Fixup => {
            let verb = if action == RewriteAction::Squash { "squash" } else { "fixup" };
            let mut idx = picked.iter().map(at).collect::<Result<Vec<_>, _>>()?;
            idx.sort_unstable();
            if let [i] = idx[..] {
                if i == 0 {
                    return Err("The first commit has no parent to squash into.".into());
                }
                todo[i].0 = verb;
            } else {
                // the others move up to the oldest one, in their order
                let moved: Vec<&str> = idx[1..].iter().map(|&i| todo[i].1).collect();
                for &i in idx[1..].iter().rev() {
                    todo.remove(i);
                }
                for (k, o) in moved.into_iter().enumerate() {
                    todo.insert(idx[0] + 1 + k, (verb, o));
                }
            }
        }
    }
    Ok(todo.into_iter().map(|(v, o)| format!("{v} {o}\n")).collect())
}

/// Before any scripted rebase: nothing in progress, no local changes (untracked files are fine).
fn rebase_ready(repo: &str) -> Result<(), String> {
    if in_progress(repo)?.is_some() || merge_message(repo)?.is_some() {
        return Err("Finish or abort the merge, rebase, cherry-pick or revert in progress first.".into());
    }
    if status(repo)?.files.iter().any(|f| f.kind != WorkKind::Untracked) {
        return Err("Commit or stash your changes first: editing commits needs a clean working directory.".into());
    }
    Ok(())
}

/// `upstream..HEAD` (everything with None), oldest first: full ids from `rev-list`, refused when it holds a merge,
/// reaches past `MAX_REWRITE`, or does not start right after `upstream`.
fn rebase_range(repo: &str, upstream: Option<&str>) -> Result<Vec<String>, String> {
    let range = upstream.map_or("HEAD".to_string(), |u| format!("{u}..HEAD"));
    let lines = git(repo, &["rev-list", "--reverse", "--parents", &range, "--"])?;
    let mut list = Vec::new();
    for (i, l) in lines.lines().enumerate() {
        let ids: Vec<&str> = l.split(' ').collect();
        if ids.len() > 2 {
            return Err("The commits since then include a merge; rewriting them would flatten it.".into());
        }
        if i == 0 && ids.get(1).copied() != upstream {
            return Err("The commits since then are not a straight line.".into());
        }
        check_oid(ids[0])?;
        list.push(ids[0].to_string());
    }
    if list.len() > MAX_REWRITE {
        return Err(format!("That reaches {} commits back; at most {MAX_REWRITE} can be rewritten at once.", list.len()));
    }
    Ok(list)
}

/// Refused with `PUBLISHED` when `first` (and so everything after it) is on a remote-tracking branch.
fn published_check(repo: &str, first: &str) -> Result<(), String> {
    let on = git(repo, &["for-each-ref", "--contains", first, "--format=%(refname)", "refs/remotes/"])?;
    let on: Vec<&str> = on.lines().filter(|l| !l.ends_with("/HEAD")).map(|l| l.trim_start_matches("refs/remotes/")).collect();
    if !on.is_empty() {
        return Err(format!("{PUBLISHED}: these commits are on {}; rewriting them rewrites published history.", on.join(", ")));
    }
    Ok(())
}

fn rewrite(repo: &str, action: RewriteAction, commits: &[String], message: Option<&str>, published_ok: bool) -> Result<(), String> {
    if commits.is_empty() {
        return Err("No commits given.".into());
    }
    for (i, c) in commits.iter().enumerate() {
        check_oid(c)?;
        if commits[..i].contains(c) {
            return Err(format!("{c} is listed twice"));
        }
    }
    let message = match (action, message.map(str::trim)) {
        (RewriteAction::Reword, Some(m)) if !m.is_empty() => Some(m),
        (RewriteAction::Reword, _) => return Err("The commit message is empty.".into()),
        _ => None,
    };
    rebase_ready(repo)?;
    // the oldest commit the todo list must hold: the oldest picked one, or its parent when that changes too
    let mut oldest: Option<(usize, &String)> = None;
    for c in commits {
        if git(repo, &["merge-base", "--is-ancestor", c, "HEAD"]).is_err() {
            return Err(format!("{} is not on the current branch", &c[..8]));
        }
        let n = git(repo, &["rev-list", "--count", &format!("{c}..HEAD"), "--"])?.trim().parse::<usize>().map_err(|e| e.to_string())?;
        if oldest.is_none_or(|(m, _)| n > m) {
            oldest = Some((n, c));
        }
    }
    let Some((_, oldest)) = oldest else { return Err("No commits given.".into()) };
    let parent_of = |c: &str| git(repo, &["rev-parse", "-q", "--verify", &format!("{c}^1")]).ok().map(|s| s.trim().to_string()).filter(|s| valid_oid(s));
    let needs_parent = matches!(action, RewriteAction::MoveDown) || (commits.len() == 1 && matches!(action, RewriteAction::Squash | RewriteAction::Fixup));
    let first = if needs_parent {
        parent_of(oldest).ok_or_else(|| match action {
            RewriteAction::MoveDown => "It is the first commit; it cannot move down.".to_string(),
            _ => "The first commit has no parent to squash into.".to_string(),
        })?
    } else {
        oldest.clone()
    };
    let upstream = parent_of(&first);
    let list = rebase_range(repo, upstream.as_deref())?;
    if list.first() != Some(&first) {
        return Err("The commits since then are not a straight line.".into());
    }
    if !published_ok {
        published_check(repo, &first)?;
    }
    let todo = rewrite_todo(action, &list, commits)?;

    // the scripted editors: copy our files over the ones git asks to edit
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("commitkiwi-rebase-{}-{nanos}", std::process::id()));
    let shown = dir.to_string_lossy().into_owned();
    if shown.contains(['\'', '\n', '\0']) {
        return Err("The temporary folder's path cannot be quoted for git.".into());
    }
    std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700).create(&dir).map_err(|e| format!("cannot create {shown}: {e}"))?;
    let r = (|| {
        std::fs::write(dir.join("todo"), todo.concat()).map_err(|e| e.to_string())?;
        let mut env = vec![("GIT_SEQUENCE_EDITOR", format!("cp '{shown}/todo'"))];
        if let Some(m) = message {
            std::fs::write(dir.join("msg"), format!("{m}\n")).map_err(|e| e.to_string())?;
            env.push(("GIT_EDITOR", format!("cp '{shown}/msg'")));
        }
        let base = upstream.as_deref().unwrap_or("--root");
        exec(repo, &["rebase", "-i", "--no-autosquash", "--no-autostash", base], None, &env).map(|_| ())
    })();
    let _ = std::fs::remove_dir_all(&dir);
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decorations() {
        let l = parse_decorations(
            "refs/remotes/origin/main, HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/HEAD, refs/stash",
        );
        let names: Vec<_> = l.iter().map(|l| (l.name.as_str(), l.kind, l.head)).collect();
        assert_eq!(
            names,
            [("main", RefKind::Branch, true), ("origin/main", RefKind::Remote, false), ("v1", RefKind::Tag, false)]
        );
        assert!(parse_decorations("").is_empty());
        assert_eq!(parse_decorations("HEAD")[0].name, "HEAD");
    }

    #[test]
    fn submodules() {
        let s = parse_submodules(" 1234abcd vendor/a (v1.0)\n-9999ffff vendor/b\n+aaaa0000 c (heads/x)\n");
        assert_eq!(s.len(), 3);
        assert!(s[0].initialized && !s[1].initialized && s[2].initialized);
        assert_eq!(s[1].path, "vendor/b");
    }

    #[test]
    fn worktrees_porcelain() {
        let out = "worktree /r\nHEAD aaaa\nbranch refs/heads/feature/x\n\nworktree /r-2\nHEAD bbbb\ndetached\n\n";
        let w = parse_worktrees(out, "/r");
        assert_eq!(w.len(), 2);
        assert_eq!((w[0].current, w[0].branch.as_deref(), w[0].oid.as_str()), (true, Some("feature/x"), "aaaa"));
        assert_eq!((w[1].current, w[1].branch.as_deref(), w[1].path.as_str()), (false, None, "/r-2"));
    }

    #[test]
    fn redacts_url_passwords() {
        assert_eq!(redact("fatal: unable to access 'https://bob:s3cr3t@example.com/r.git/': 403"), "fatal: unable to access 'https://bob:***@example.com/r.git/': 403");
        assert_eq!(redact("To https://example.com/r.git\n   a..b  main -> main"), "To https://example.com/r.git\n   a..b  main -> main");
        assert_eq!(redact("ssh://git@host:22/x and http://u:p@h"), "ssh://git@host:22/x and http://u:***@h");
        assert_eq!(redact("no urls: a:b@c"), "no urls: a:b@c");
    }

    #[test]
    fn tilde() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand("~/x"), format!("{home}/x"));
        assert_eq!(expand("~"), home);
        assert_eq!(expand("/a/~/b"), "/a/~/b");
    }

    #[test]
    fn log_and_stats_parse() {
        let raw = format!(
            "{r}aaa{f}p1 p2{f}A{f}a@x{f}10{f}merge{f}\n{r}bbb{f}p1{f}B{f}b@x{f}9{f}one{f}HEAD -> refs/heads/m\n",
            r = RECORD,
            f = FIELD
        );
        let c = parse_log(&raw);
        assert_eq!((c.len(), c[0].parents.len(), c[0].files), (2, 2, None));
        assert!(c[1].labels[0].head);

        let st = format!("{r}aaa\n{r}bbb\n\n 2 files changed, 3 insertions(+)\n", r = RECORD);
        assert_eq!(parse_stats(&st), [("aaa".to_string(), 0), ("bbb".to_string(), 2)]);
    }

    #[test]
    fn stats_rejects_non_hex_ids() {
        let evil = vec!["--output=/tmp/x".to_string()];
        assert!(stats(".", &evil).is_err());
        assert!(stats(".", &["g".repeat(40)]).is_err());
        assert!(stats(".", &vec!["a".repeat(40); MAX_STATS + 1]).is_err());
        assert_eq!(stats(".", &[]).unwrap(), vec![]);
    }

    #[test]
    fn changes_zip_numstat_and_status() {
        let numstat = "3\t1\ta.txt\0-\t-\timg.png\x000\t0\t\0old name.txt\0new name.txt\0";
        let names = "M\0a.txt\0A\0img.png\0R100\0old name.txt\0new name.txt\0";
        let c = parse_changes(numstat, names);
        assert_eq!(c.len(), 3);
        assert_eq!((c[0].status.as_str(), c[0].adds, c[0].dels), ("M", Some(3), Some(1)));
        assert_eq!((c[1].path.as_str(), c[1].adds), ("img.png", None)); // binary
        assert_eq!((c[2].status.as_str(), c[2].path.as_str(), c[2].old_path.as_deref()), ("R", "new name.txt", Some("old name.txt")));
    }

    #[test]
    fn tree_sorts_dirs_first() {
        let out = "100644 blob aaaa     12\tb.txt\x00040000 tree bbbb      -\tsrc\x00160000 commit cccc      -\tvendor\x00100644 blob dddd      3\tA.md\0";
        let t = parse_tree(out);
        let names: Vec<_> = t.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["src", "vendor", "A.md", "b.txt"]);
        assert_eq!((t[0].kind, t[1].kind, t[3].size), (TreeKind::Tree, TreeKind::Commit, Some(12)));
    }

    #[test]
    fn blame_porcelain() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let raw = format!(
            "{a} 1 1 1\nauthor Ann\nauthor-time 100\nsummary x\nfilename f\n\tone\n{b} 2 2 1\nauthor Bob\nauthor-time 200\nfilename f\n\ttwo\n{a} 2 3 1\nfilename f\n\tauthor not a header\n"
        );
        let l = parse_blame(&raw);
        assert_eq!(l.len(), 3);
        assert_eq!((l[0].author.as_str(), l[0].time, l[0].text.as_str()), ("Ann", 100, "one"));
        assert_eq!((l[1].oid.as_str(), l[1].author.as_str()), (b.as_str(), "Bob"));
        assert_eq!((l[2].author.as_str(), l[2].text.as_str()), ("Ann", "author not a header")); // reused meta
    }

    #[test]
    fn capped_text_cuts_on_line_boundary() {
        assert_eq!(capped_text(b"one\ntwo\nthr".to_vec(), true), "one\ntwo\n");
        assert_eq!(capped_text(b"one\ntwo\nthr".to_vec(), false), "one\ntwo\nthr");
    }

    #[test]
    fn status_v2_records() {
        let raw = "1 .M N... 100644 100644 100644 aaa bbb dir/a b.txt\x001 A. N... 000000 100644 100644 000 ccc new.rs\x002 R. N... 100644 100644 100644 ddd eee R100 moved.txt\x00old name.txt\x00u UU N... 100644 100644 100644 100644 f1 f2 f3 conflict.txt\x00? sp ace.txt\x00";
        let st = parse_status(raw);
        let f: Vec<_> = st.files.iter().map(|f| (f.path.as_str(), f.index, f.worktree, f.kind)).collect();
        assert_eq!(f, [
            ("dir/a b.txt", '.', 'M', WorkKind::Changed),
            ("new.rs", 'A', '.', WorkKind::Changed),
            ("moved.txt", 'R', '.', WorkKind::Changed),
            ("conflict.txt", 'U', 'U', WorkKind::Conflicted),
            ("sp ace.txt", '.', '?', WorkKind::Untracked),
        ]);
        assert_eq!(st.files[2].old_path.as_deref(), Some("old name.txt")); // consumed its extra record
        assert!(!st.truncated);
    }

    #[test]
    fn ignore_entries_escape_patterns() {
        assert_eq!(ignore_entry("a/b.txt"), "/a/b.txt");
        assert_eq!(ignore_entry("weird[1]*.txt"), "/weird\\[1\\]\\*.txt");
        assert_eq!(ignore_entry("trail "), "/trail\\ ");
    }

    #[test]
    fn image_mimes() {
        assert_eq!(image_mime("a/b/Logo.PNG"), Some("image/png"));
        assert_eq!(image_mime("x.svg"), Some("image/svg+xml"));
        assert_eq!(image_mime("x.txt"), None);
        assert_eq!(image_mime("noext"), None);
    }

    #[test]
    fn paths_are_validated() {
        assert!(git_paths(".", &["status"], &["".into()]).is_err());
        assert!(git_paths(".", &["status"], &["a\0b".into()]).is_err());
        assert!(git_paths(".", &["status"], &[]).is_ok());
    }

    #[test]
    fn git_cmd_args() {
        let args = |repo: &str, read: bool| git_cmd(repo, read).get_args().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        let t = tempfile::tempdir().unwrap();
        let repo = |name: &str, fsmonitor: &str| {
            let d = t.path().join(name);
            let d = d.to_str().unwrap();
            Command::new("git").args(["init", "-q", d]).status().unwrap();
            Command::new("git").args(["-C", d, "config", "core.fsmonitor", fsmonitor]).status().unwrap();
            d.to_string()
        };
        // a boolean is git's own daemon (the user's speed-up): passed through untouched
        let builtin = repo("builtin", "true");
        assert_eq!(args(&builtin, false), format!("-C {builtin}"));
        assert_eq!(args(&builtin, true), format!("-C {builtin} -c core.hooksPath=/dev/null"));
        assert_eq!(args(&repo("off", "false"), false), format!("-C {}/off", t.path().display()));
        // a hook path would run on every status poll
        let hook = repo("hook", "/tmp/evil.sh");
        assert_eq!(args(&hook, false), format!("-C {hook} -c core.fsmonitor=false"));
        assert_eq!(args(&hook, true), format!("-C {hook} -c core.fsmonitor=false -c core.hooksPath=/dev/null"));
        // filters: the stock git-lfs driver stays (else LFS files look modified); any other is blanked on reads only
        let set = |d: &str, k: &str, v: &str| assert!(Command::new("git").args(["-C", d, "config", k, v]).status().unwrap().success());
        set(&builtin, "filter.lfs.clean", "git-lfs clean -- %f");
        set(&builtin, "filter.lfs.smudge", "git-lfs smudge -- %f");
        set(&builtin, "filter.lfs.process", "git-lfs filter-process");
        set(&builtin, "filter.lfs.required", "true");
        assert_eq!(args(&builtin, true), format!("-C {builtin} -c core.hooksPath=/dev/null"));
        set(&builtin, "filter.My.Evil.process", "sh -c evil");
        let blank = "-c filter.My.Evil.clean= -c filter.My.Evil.smudge= -c filter.My.Evil.process= -c filter.My.Evil.required=false";
        assert_eq!(args(&builtin, true), format!("-C {builtin} {blank} -c core.hooksPath=/dev/null"));
        assert_eq!(args(&builtin, false), format!("-C {builtin}"));
        // a near-lfs command line is not lfs
        set(&builtin, "filter.lfs.smudge", "git-lfs smudge -- %f; evil");
        assert!(args(&builtin, true).contains("-c filter.lfs.clean= "));
    }

    #[test]
    fn config_overrides_parse() {
        // last value wins; valueless key is boolean true; integers are booleans
        assert!(config_overrides("core.fsmonitor\n/x.sh\0core.fsmonitor\ntrue\0", false).is_empty());
        assert!(config_overrides("core.fsmonitor\0", false).is_empty());
        assert!(config_overrides("core.fsmonitor\n0\0", false).is_empty());
        assert_eq!(config_overrides("core.fsmonitor\ntrue\0core.fsmonitor\n/x.sh\0", false), ["core.fsmonitor=false"]);
        // an lfs line overridden by a later evil one; a name with spaces/dots; a name `-c` cannot express
        let o = config_overrides("filter.lfs.clean\ngit-lfs clean -- %f\0filter.lfs.clean\nevil\0filter.a b.c.smudge\nx\0", true);
        assert_eq!(o.len(), 8);
        assert!(o.contains(&"filter.lfs.process=".into()) && o.contains(&"filter.a b.c.required=false".into()));
        assert_eq!(config_overrides("filter.a=b.clean\nx\0", true), [REFUSE]);
    }

    #[test]
    fn progress_output() {
        assert_eq!(settle("Counting: 10%\rCounting: 100%\nerror: nope\r\n"), "Counting: 100%\nerror: nope");
        // pieces end on line breaks, so a multi-byte character is never split between two events
        let got = Arc::new(Mutex::new(Vec::<String>::new()));
        let g = got.clone();
        let sink: Sink = Arc::new(move |t: &str| g.lock().unwrap().push(t.into()));
        let all = pump(std::io::Cursor::new("a: 5%\ra: 9%\rdone é\ntail".as_bytes()), Some(&sink));
        assert_eq!(all, "a: 5%\ra: 9%\rdone é\ntail".as_bytes());
        assert_eq!(got.lock().unwrap().concat(), "a: 5%\ra: 9%\rdone é\ntail");
    }
}

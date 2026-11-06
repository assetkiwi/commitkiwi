//! The command line launcher: `commitkiwi [path ...]` opens each path's repository in a tab of the running app, or starts
//! it. The first instance listens on a unix socket in a private (0700) folder under the config dir; a later one sends
//! its resolved paths there as one JSON line, waits for `ok` and exits. Plus the `commitkiwi` symlink installer.
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const USAGE: &str = "usage: commitkiwi [path ...]

Opens the git repository holding each path in a commit.kiwi tab (a file opens the repository it is in).
Without a path it opens or focuses commit.kiwi.

  -h, --help     show this help
  -V, --version  show the version
";

#[derive(Debug, PartialEq)]
pub enum Cmd {
    Help,
    Version,
    /// absolute, not yet checked
    Open(Vec<PathBuf>),
}

/// Flags, and each path made absolute against `cwd` (a literal `~/...` against `home`; the shell usually expands it).
pub fn parse(args: &[String], cwd: &Path, home: Option<&Path>) -> Result<Cmd, String> {
    let (mut paths, mut flags) = (Vec::new(), true);
    for a in args {
        if flags {
            match a.as_str() {
                "-h" | "--help" => return Ok(Cmd::Help),
                "-V" | "--version" => return Ok(Cmd::Version),
                "--" => { flags = false; continue; }
                f if f.starts_with("-psn_") => continue, // older macOS adds a process serial number when Finder launches
                f if f.starts_with('-') => return Err(format!("unknown option: {f}")),
                _ => {}
            }
        }
        let p = match home {
            Some(h) if a == "~" => h.to_path_buf(),
            Some(h) if a.starts_with("~/") => h.join(&a[2..]),
            _ => PathBuf::from(a),
        };
        paths.push(cwd.join(p)); // an absolute `p` replaces `cwd`
    }
    Ok(Cmd::Open(paths))
}

/// What one launch asks for: repository roots to open (no duplicates) and one line per path that is not one.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Opened {
    pub open: Vec<String>,
    pub errors: Vec<String>,
}

pub fn resolve(paths: &[PathBuf]) -> Opened {
    let mut out = Opened::default();
    for p in paths {
        match repo_root(p) {
            Ok(r) => {
                let r = r.to_string_lossy().into_owned();
                if !out.open.contains(&r) {
                    out.open.push(r);
                }
            }
            Err(e) => out.errors.push(e),
        }
    }
    out
}

/// The work tree holding `p`: the nearest folder (from `p` up) with a `.git` folder, or file (worktrees, submodules).
/// shortcut: bare repositories and $GIT_DIR setups count as "not a repository"; ask git (`rev-parse`) if users need them.
fn repo_root(p: &Path) -> Result<PathBuf, String> {
    let c = p.canonicalize().map_err(|_| format!("No such file or directory: {}", p.display()))?;
    let start = if c.is_dir() { c.as_path() } else { c.parent().unwrap_or(&c) };
    start.ancestors().find(|d| d.join(".git").exists()).map(Path::to_path_buf).ok_or_else(|| format!("Not a git repository: {}", p.display()))
}

/// The socket's folder under the app config dir.
pub fn sock_dir(config: &Path) -> PathBuf {
    config.join("cli")
}

fn uid() -> u32 {
    unsafe { libc::getuid() }
}

/// Create `dir` 0700, or check an existing one is ours (a folder, not a link) and make it 0700 again.
fn private_dir(dir: &Path) -> std::io::Result<()> {
    if let Some(p) = dir.parent() {
        std::fs::create_dir_all(p)?;
    }
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
        _ => {}
    }
    let m = std::fs::symlink_metadata(dir)?;
    if !m.is_dir() || m.uid() != uid() {
        return Err(std::io::Error::other(format!("{} is not a folder owned by this user", dir.display())));
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// Hand `msg` to the instance listening in `dir`. Err(NotFound / ConnectionRefused): nobody listens.
pub fn send(dir: &Path, msg: &Opened) -> std::io::Result<()> {
    private_dir(dir)?;
    let mut c = UnixStream::connect(dir.join("s"))?;
    c.set_read_timeout(Some(Duration::from_secs(5)))?;
    c.set_write_timeout(Some(Duration::from_secs(5)))?;
    serde_json::to_writer(&mut c, msg)?;
    c.write_all(b"\n")?;
    c.shutdown(std::net::Shutdown::Write)?;
    let mut reply = String::new();
    c.take(16).read_to_string(&mut reply)?;
    if reply == "ok\n" { Ok(()) } else { Err(std::io::Error::other("the running commit.kiwi did not answer")) }
}

#[derive(Debug, PartialEq)]
pub enum Role {
    /// another instance has the paths: exit
    Forwarded,
    /// this process listens now; forwarded launches go to `on_open`
    Primary,
}

/// Forward `msg` to a running instance, or become the instance (a stale socket left by a crash is replaced).
pub fn claim(dir: &Path, msg: &Opened, on_open: impl Fn(Opened) + Send + 'static) -> std::io::Result<Role> {
    use std::io::ErrorKind::{AddrInUse, ConnectionRefused, NotFound};
    let sock = dir.join("s");
    for _ in 0..3 {
        match send(dir, msg) {
            Ok(()) => return Ok(Role::Forwarded),
            Err(e) if matches!(e.kind(), NotFound | ConnectionRefused) => {}
            Err(e) => return Err(e),
        }
        // shortcut: two launches racing through remove+bind can both listen (the later one wins the path); fine for a
        // person typing commands, use a lock file if scripts start many at once
        let _ = std::fs::remove_file(&sock);
        match UnixListener::bind(&sock) {
            Ok(listener) => {
                std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600))?;
                std::thread::spawn(move || {
                    for c in listener.incoming().flatten() {
                        serve(c, &on_open);
                    }
                });
                return Ok(Role::Primary);
            }
            Err(e) if e.kind() == AddrInUse => continue, // another instance just started: forward to it
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other("cannot reach or start the commit.kiwi instance"))
}

fn serve(c: UnixStream, on_open: &dyn Fn(Opened)) {
    if peer_uid(&c) != Some(uid()) {
        return; // the folder is 0700 already; this is the second lock
    }
    let _ = c.set_read_timeout(Some(Duration::from_secs(5)));
    let mut line = String::new();
    if BufReader::new((&c).take(1 << 20)).read_line(&mut line).is_err() {
        return;
    }
    let Ok(msg) = serde_json::from_str::<Opened>(&line) else { return };
    on_open(msg);
    let _ = (&c).write_all(b"ok\n");
}

#[cfg(target_os = "macos")]
fn peer_uid(c: &UnixStream) -> Option<u32> {
    let (mut uid, mut gid) = (0, 0);
    (unsafe { libc::getpeereid(c.as_raw_fd(), &mut uid, &mut gid) } == 0).then_some(uid)
}

#[cfg(target_os = "linux")]
fn peer_uid(c: &UnixStream) -> Option<u32> {
    let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let r = unsafe { libc::getsockopt(c.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&raw mut cred).cast(), &mut len) };
    (r == 0).then_some(cred.uid)
}

/// Start the app again away from the terminal, so the shell prompt comes back: through LaunchServices (`open -a`) for
/// a macOS bundle, else in a new session with stdio on /dev/null. `paths` are absolute: the cwd does not matter.
pub fn detach(exe: &Path, paths: &[PathBuf]) -> std::io::Result<()> {
    use std::process::{Command, Stdio};
    #[cfg(target_os = "macos")]
    if let Some(bundle) = exe.ancestors().nth(3).filter(|b| b.extension().is_some_and(|e| e == "app"))
        && Command::new("/usr/bin/open").arg("-a").arg(bundle).arg("--args").args(paths)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
    {
        return Ok(());
    }
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new(exe);
    cmd.args(paths).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().map(|_| ())
}

pub const TOOL: &str = "commitkiwi";

/// Where Install Command Line Tool looks, in order (the last is created when missing).
pub fn tool_dirs(home: &Path) -> Vec<PathBuf> {
    vec!["/usr/local/bin".into(), "/opt/homebrew/bin".into(), home.join(".local/bin")]
}

#[derive(Debug, PartialEq)]
pub enum Install {
    Done(PathBuf),
    /// `path` exists and is something else (`current`: where it points); install again with `replace` to overwrite
    Ask { path: PathBuf, current: String },
}

fn writable(dir: &Path) -> bool {
    let Ok(c) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else { return false };
    dir.is_dir() && unsafe { libc::access(c.as_ptr(), libc::W_OK) } == 0
}

/// Link `<dir>/commitkiwi` -> `target` in the first writable of `dirs`. Never runs sudo; never replaces something else
/// without `replace`.
pub fn install(target: &Path, dirs: &[PathBuf], replace: bool) -> Result<Install, String> {
    for (i, dir) in dirs.iter().enumerate() {
        if i + 1 == dirs.len() {
            let _ = std::fs::create_dir_all(dir);
        }
        if !writable(dir) {
            continue;
        }
        let link = dir.join(TOOL);
        if let Ok(m) = std::fs::symlink_metadata(&link) {
            let current = std::fs::read_link(&link).ok();
            if current.as_deref() == Some(target) {
                return Ok(Install::Done(link));
            }
            if m.is_dir() {
                return Err(format!("{} is a folder", link.display()));
            }
            if !replace {
                return Ok(Install::Ask { current: current.map_or("a file".into(), |c| c.display().to_string()), path: link });
            }
            std::fs::remove_file(&link).map_err(|e| format!("cannot replace {}: {e}", link.display()))?;
        }
        std::os::unix::fs::symlink(target, &link).map_err(|e| format!("cannot create {}: {e}", link.display()))?;
        return Ok(Install::Done(link));
    }
    Err(format!("none of {} is writable", dirs.iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(", ")))
}

/// Remove `<dir>/commitkiwi` where it is a link to `target`; anything else is left alone. Returns the removed links.
pub fn uninstall(target: &Path, dirs: &[PathBuf]) -> Vec<PathBuf> {
    dirs.iter()
        .map(|d| d.join(TOOL))
        .filter(|l| std::fs::read_link(l).is_ok_and(|t| t == target || l.canonicalize().is_ok_and(|c| c == target)))
        .filter(|l| std::fs::remove_file(l).is_ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn parses_flags_and_makes_paths_absolute() {
        let (cwd, home) = (Path::new("/work/here"), Path::new("/home/me"));
        let p = |a: &[&str]| parse(&s(a), cwd, Some(home));
        assert_eq!(p(&["--help", "x"]), Ok(Cmd::Help));
        assert_eq!(p(&["a", "-h"]), Ok(Cmd::Help));
        assert_eq!(p(&["--version"]), Ok(Cmd::Version));
        assert_eq!(p(&["-V"]), Ok(Cmd::Version));
        assert!(p(&["--bogus"]).unwrap_err().contains("--bogus"));
        assert_eq!(p(&[]), Ok(Cmd::Open(vec![])));
        let open = p(&[".", "sub/dir", "~/repo", "~", "/abs", "-psn_0_123", "--", "-dash"]).unwrap();
        let want = ["/work/here/.", "/work/here/sub/dir", "/home/me/repo", "/home/me", "/abs", "/work/here/-dash"];
        assert_eq!(open, Cmd::Open(want.iter().map(PathBuf::from).collect()));
        // without HOME a `~` stays a relative name
        assert_eq!(parse(&s(&["~/x"]), cwd, None), Ok(Cmd::Open(vec!["/work/here/~/x".into()])));
    }

    #[test]
    fn resolves_to_repository_roots() {
        let t = tempfile::tempdir().unwrap();
        let base = t.path().canonicalize().unwrap();
        let (a, b, plain) = (base.join("a"), base.join("b"), base.join("plain"));
        std::fs::create_dir_all(a.join(".git")).unwrap();
        std::fs::create_dir_all(a.join("src/deep")).unwrap();
        std::fs::write(a.join("src/file.rs"), "").unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join(".git"), "gitdir: /elsewhere\n").unwrap(); // a worktree
        std::fs::create_dir_all(&plain).unwrap();
        // relative, `.` and `~/` go through parse
        let Ok(Cmd::Open(paths)) = parse(&s(&[".", "src/deep", "src/file.rs", "~/b", "../plain", "missing"]), &a, Some(&base)) else { panic!() };
        let r = resolve(&paths);
        let root = |p: &Path| p.to_string_lossy().into_owned();
        assert_eq!(r.open, [root(&a), root(&b)], "duplicates collapse to one root, a file opens its repo");
        assert_eq!(r.errors, [format!("Not a git repository: {}", a.join("../plain").display()), format!("No such file or directory: {}", a.join("missing").display())]);
    }

    fn collector() -> (Arc<Mutex<Vec<Opened>>>, impl Fn(Opened) + Send + 'static) {
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        (got, move |m| g.lock().unwrap().push(m))
    }

    #[test]
    fn second_launch_forwards_to_the_first() {
        let t = tempfile::tempdir().unwrap();
        let dir = sock_dir(t.path());
        let first = Opened { open: vec!["/r1".into()], errors: vec![] };
        let (got, on) = collector();
        assert_eq!(claim(&dir, &first, on).unwrap(), Role::Primary);
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        let second = Opened { open: vec!["/r2".into(), "/r3".into()], errors: vec!["Not a git repository: /x".into()] };
        let (other, on2) = collector();
        assert_eq!(claim(&dir, &second, on2).unwrap(), Role::Forwarded);
        assert_eq!(*got.lock().unwrap(), [second], "the primary got the second launch's paths");
        assert!(other.lock().unwrap().is_empty());
        // garbage on the socket is ignored and the listener keeps serving
        let mut c = UnixStream::connect(dir.join("s")).unwrap();
        c.write_all(b"not json\n").unwrap();
        c.shutdown(std::net::Shutdown::Write).unwrap();
        let mut reply = String::new();
        c.read_to_string(&mut reply).unwrap();
        assert_eq!(reply, "");
        send(&dir, &Opened::default()).unwrap();
        assert_eq!(got.lock().unwrap().len(), 2);
    }

    #[test]
    fn stale_socket_is_taken_over() {
        let t = tempfile::tempdir().unwrap();
        let dir = sock_dir(t.path());
        std::fs::create_dir_all(&dir).unwrap();
        drop(UnixListener::bind(dir.join("s")).unwrap()); // a crashed instance: the file stays, nobody listens
        assert!(dir.join("s").exists());
        let (got, on) = collector();
        assert_eq!(claim(&dir, &Opened::default(), on).unwrap(), Role::Primary);
        send(&dir, &Opened { open: vec!["/r".into()], errors: vec![] }).unwrap();
        assert_eq!(got.lock().unwrap()[0].open, ["/r"]);
        // a folder that is a symlink is refused
        let link = t.path().join("linked");
        std::os::unix::fs::symlink(t.path(), &link).unwrap();
        assert!(send(&link, &Opened::default()).is_err());
    }

    #[test]
    fn installs_and_uninstalls_the_link() {
        let t = tempfile::tempdir().unwrap();
        let (ro, used, local) = (t.path().join("ro"), t.path().join("bin"), t.path().join("home/.local/bin"));
        std::fs::create_dir_all(&ro).unwrap();
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o500)).unwrap();
        let app = t.path().join("app");
        std::fs::write(&app, "").unwrap();
        let dirs = vec![ro.clone(), t.path().join("missing"), used.clone(), local.clone()];
        std::fs::create_dir_all(&used).unwrap();
        // the first writable dir wins; read-only and missing (not last) ones are skipped
        assert_eq!(install(&app, &dirs, false), Ok(Install::Done(used.join(TOOL))));
        assert_eq!(std::fs::read_link(used.join(TOOL)).unwrap(), app);
        assert_eq!(install(&app, &dirs, false), Ok(Install::Done(used.join(TOOL))), "again: nothing to do");
        // something else there: ask, then replace only when told
        std::fs::remove_file(used.join(TOOL)).unwrap();
        std::os::unix::fs::symlink("/usr/bin/true", used.join(TOOL)).unwrap();
        assert_eq!(install(&app, &dirs, false), Ok(Install::Ask { path: used.join(TOOL), current: "/usr/bin/true".into() }));
        assert_eq!(std::fs::read_link(used.join(TOOL)).unwrap(), Path::new("/usr/bin/true"));
        assert_eq!(uninstall(&app, &dirs), Vec::<PathBuf>::new(), "uninstall leaves other links alone");
        assert_eq!(install(&app, &dirs, true), Ok(Install::Done(used.join(TOOL))));
        assert_eq!(std::fs::read_link(used.join(TOOL)).unwrap(), app);
        assert_eq!(uninstall(&app, &dirs), [used.join(TOOL)]);
        assert!(std::fs::symlink_metadata(used.join(TOOL)).is_err());
        // only the last candidate left: it is created
        std::fs::remove_dir(&used).unwrap();
        assert_eq!(install(&app, &dirs, false), Ok(Install::Done(local.join(TOOL))));
        // a plain file is asked about, never removed by uninstall
        std::fs::remove_file(local.join(TOOL)).unwrap();
        std::fs::write(local.join(TOOL), "#!/bin/sh\n").unwrap();
        assert!(matches!(install(&app, &dirs, false), Ok(Install::Ask { current, .. }) if current == "a file"));
        assert!(uninstall(&app, &dirs).is_empty() && local.join(TOOL).is_file());
        assert!(install(&app, &dirs[..1], false).unwrap_err().contains("writable"));
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
}

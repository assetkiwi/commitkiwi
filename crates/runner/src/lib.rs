//! Where requests run: in this process (`Local`) or on another machine through the agent (`Remote`).
use commitkiwi_protocol::{Change, MAGIC, Msg, PROTO_VERSION, Req, Resp, check_len, decode, encode};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex as AsyncMutex, oneshot, watch};

const SSH: &str = "/usr/bin/ssh"; // explicit: shells may alias `ssh` to a wrapper
const HANDSHAKE: Duration = Duration::from_secs(20);
const STDERR_TAIL: usize = 2000;
/// A live link answers a `Hello` this often; one that does not within `PING_WAIT` is cut (and reconnected).
pub(crate) const PING_EVERY: Duration = Duration::from_secs(30);
pub(crate) const PING_WAIT: Duration = Duration::from_secs(20);

/// Where a watched repo's change events go (local watcher or the agent's `Changed` frames).
pub type ChangeFn = Arc<dyn Fn(Change) + Send + Sync>;

/// Local watchers by repo (the app's own process); dropping one stops it.
static LOCAL_WATCHES: LazyLock<Mutex<HashMap<String, commitkiwi_core::watch::Watcher>>> = LazyLock::new(Mutex::default);

pub use commitkiwi_core::Sink;
pub mod askpass;
pub mod link;

/// Extra environment for local git writes (the askpass helper); set once by the app.
pub fn set_local_write_env(env: Vec<(String, String)>) {
    commitkiwi_core::set_write_env(env);
}

pub enum Runner {
    Local,
    Remote(Box<Remote>),
}

impl Runner {
    pub async fn call(&self, req: Req) -> Result<Resp, String> {
        self.call_with(req, None).await
    }

    /// `call`; a `Req::Job`'s output goes to `sink` while it runs.
    pub async fn call_with(&self, req: Req, sink: Option<Sink>) -> Result<Resp, String> {
        self.call_timed(req, sink).await.map(|(r, _)| r)
    }

    /// `call_with`, plus how long handling took where the repo is (ms; the agent reports it, None from an
    /// older agent): the request timing trace.
    pub async fn call_timed(&self, req: Req, sink: Option<Sink>) -> Result<(Resp, Option<u32>), String> {
        match self {
            Runner::Local => tokio::task::spawn_blocking(move || {
                let t = std::time::Instant::now();
                let r = commitkiwi_core::handle_with(req, sink);
                (r, Some(t.elapsed().as_millis().min(u32::MAX as u128) as u32))
            })
            .await
            .map_err(|e| e.to_string()),
            Runner::Remote(r) => r.call_timed(req, sink).await,
        }
    }

    /// False once the remote connection died; callers should reconnect.
    pub fn alive(&self) -> bool {
        match self {
            Runner::Local => true,
            Runner::Remote(r) => !r.dead.load(SeqCst),
        }
    }

    /// Resolves when the connection is gone (never for `Local`).
    pub async fn closed(&self) {
        match self {
            Runner::Local => std::future::pending().await,
            Runner::Remote(r) => r.closed().await,
        }
    }

    /// Watch `repo`; changes go to `on`. Ok(Some(reason)) = no file events there, poll instead.
    pub async fn watch(&self, repo: &str, on: ChangeFn) -> Result<Option<String>, String> {
        match self {
            Runner::Local => {
                let (r, on2) = (repo.to_string(), on.clone());
                let w = tokio::task::spawn_blocking(move || commitkiwi_core::watch::watch(&r, Box::new(move |c| on2(c))))
                    .await
                    .map_err(|e| e.to_string())?;
                let mut map = LOCAL_WATCHES.lock().unwrap_or_else(|e| e.into_inner());
                Ok(match w {
                    Ok(w) => { map.insert(repo.into(), w); None }
                    Err(e) => { map.remove(repo); Some(e) }
                })
            }
            Runner::Remote(r) => {
                *r.on_change.lock().unwrap_or_else(|e| e.into_inner()) = Some(on);
                match r.call(Req::Watch { repo: repo.into() }).await? {
                    Resp::Watch { polling } => Ok(polling),
                    Resp::Err(e) => Err(e),
                    other => Err(format!("unexpected reply to Watch: {other:?}")),
                }
            }
        }
    }

    pub async fn unwatch(&self, repo: &str) -> Result<(), String> {
        match self {
            Runner::Local => {
                LOCAL_WATCHES.lock().unwrap_or_else(|e| e.into_inner()).remove(repo);
                Ok(())
            }
            Runner::Remote(r) => r.call(Req::Unwatch { repo: repo.into() }).await.map(|_| ()),
        }
    }

    /// Connect to `host` (an ssh config alias or `user@host`), installing the agent if needed.
    pub async fn connect_ssh(host: &str) -> Result<Runner, String> {
        if !valid_host(host) {
            return Err(format!("invalid host name: {host:?}"));
        }
        let path = install_agent(host, false).await?;
        match start_agent(host, &path).await {
            Ok(r) => Ok(r),
            // the installed file is not the agent this app speaks to (or it cannot start): upload it again, once
            Err(e) if e.contains("protocol") || e.contains("connection lost") || e.contains("handshake") => {
                let path = install_agent(host, true).await?;
                start_agent(host, &path).await.map_err(|e2| format!("{e2} (after reinstalling the agent; before: {e})"))
            }
            Err(e) => Err(e),
        }
    }
}

async fn start_agent(host: &str, path: &str) -> Result<Runner, String> {
    let child = ssh_cmd(host)
        .arg(format!("sh -c 'exec {path} --stdio'"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start ssh: {e}"))?;
    Ok(Runner::Remote(Box::new(Remote::from_child(child).await?)))
}

/// Copy this app's agent build for `host`'s platform to `~/.cache/commitkiwi/agent-<hash>` when it is not there
/// (`force`: always, e.g. Preferences > Remote > Reinstall agent). Returns the remote path.
pub async fn install_agent(host: &str, force: bool) -> Result<String, String> {
    if !valid_host(host) {
        return Err(format!("invalid host name: {host:?}"));
    }
    let (bin, path) = local_agent(host).await?;
    if force || ssh_run(host, &format!("test -x {path}"), None).await.is_err() {
        // temp name + rename: an agent running from the old file keeps working, a cut upload never becomes the agent
        let script = format!(
            "mkdir -p ~/.cache/commitkiwi && cat > {path}.part.$$ && chmod 755 {path}.part.$$ && mv -f {path}.part.$$ {path}"
        );
        ssh_run(host, &script, Some(&bin)).await?;
    }
    Ok(path)
}

/// This app's agent build for `host`'s platform and the path it gets there.
async fn local_agent(host: &str) -> Result<(Vec<u8>, String), String> {
    let platform = platform_dir(&ssh_run(host, "uname -sm", None).await?)?;
    let bin = tokio::fs::read(find_agent(&platform)?).await.map_err(|e| format!("cannot read agent: {e}"))?;
    let path = remote_agent_path(&bin);
    Ok((bin, path))
}

/// Shell script for `sh -c '...'` (so: no single quote in it) that marks agent `cur` as used now and deletes the
/// other regular files `agent-*` in `~/.cache/commitkiwi` (and the pre-rename `~/.cache/{sourcerykiwi,mergekiwi,gitmerge}`,
/// each removed with `rmdir` once empty; never followed when it is a symlink) not modified for `minutes` (0: all). Symlinks, directories and other names are never touched;
/// half-uploaded `.part.` files wait at least an hour. Prints "<files> <bytes>".
fn cleanup_script(cur: &str, minutes: u64) -> Result<String, String> {
    let hex = cur.strip_prefix("agent-").unwrap_or("");
    if hex.is_empty() || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("invalid agent name: {cur:?}"));
    }
    Ok(format!(
        r#"d="$HOME/.cache/commitkiwi"; [ -f "$d/{cur}" ] && touch "$d/{cur}"; n=0; b=0; for o in "$d" "$HOME/.cache/sourcerykiwi" "$HOME/.cache/mergekiwi" "$HOME/.cache/gitmerge"; do [ "$o" != "$d" ] && [ -L "$o" ] && continue; for f in "$o"/agent-*; do [ "$f" = "$d/{cur}" ] && continue; [ -f "$f" ] && [ ! -L "$f" ] || continue; m={minutes}; case "$f" in *.part.*) [ $m -lt 60 ] && m=60;; esac; [ $m -eq 0 ] || [ -n "$(find "$f" -prune -mmin +$m)" ] || continue; s=$(wc -c < "$f"); rm -f -- "$f" && n=$((n+1)) && b=$((b+s)); done; [ "$o" != "$d" ] && [ -d "$o" ] && rmdir -- "$o" 2>/dev/null; done; echo $n $b"#
    ))
}

/// Remove agent builds on `host` that were not used for `days` days (0: every one but the current), after marking
/// the current one as used. Returns (files, bytes) removed. Nothing else on the host is touched.
pub async fn cleanup_agents(host: &str, days: u32) -> Result<(u64, u64), String> {
    if !valid_host(host) {
        return Err(format!("invalid host name: {host:?}"));
    }
    let (_, path) = local_agent(host).await?;
    let cur = path.rsplit('/').next().unwrap_or_default();
    let out = ssh_run(host, &cleanup_script(cur, u64::from(days) * 1440)?, None).await?;
    let mut it = out.split_whitespace().map(str::parse::<u64>);
    match (it.next(), it.next()) {
        (Some(Ok(n)), Some(Ok(b))) => Ok((n, b)),
        _ => Err(format!("unexpected answer from {host}: {:?}", out.trim())),
    }
}

/// A request waiting for its reply, and where its `Output` events go meanwhile.
type Pending = Arc<Mutex<HashMap<u64, (oneshot::Sender<(Resp, Option<u32>)>, Option<Sink>)>>>;

pub struct Remote {
    stdin: AsyncMutex<ChildStdin>,
    pending: Pending,
    next: AtomicU64,
    dead: Arc<AtomicBool>,
    closed: watch::Receiver<bool>,
    stderr_tail: Arc<Mutex<String>>,
    on_change: Arc<Mutex<Option<ChangeFn>>>,
    child: Mutex<Child>, // spawned with kill_on_drop
}

impl Remote {
    /// Speak the protocol over a child's stdio (ssh in production, the agent binary directly in tests).
    pub async fn from_child(mut child: Child) -> Result<Self, String> {
        let (stdin, stdout, stderr) = match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
            (Some(i), Some(o), Some(e)) => (i, o, e),
            _ => return Err("child needs piped stdin, stdout and stderr".into()),
        };
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let dead = Arc::new(AtomicBool::new(false));
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        let on_change = Arc::new(Mutex::new(None));
        let (closed_tx, closed) = watch::channel(false);
        tokio::spawn(read_loop(stdout, pending.clone(), dead.clone(), on_change.clone(), closed_tx));
        tokio::spawn(collect_stderr(stderr, stderr_tail.clone()));
        let r = Remote {
            stdin: AsyncMutex::new(stdin), pending, next: AtomicU64::new(1), dead, closed, stderr_tail, on_change, child: Mutex::new(child),
        };
        match tokio::time::timeout(HANDSHAKE, r.call(Req::Hello)).await {
            Ok(Ok(Resp::Hello { proto })) if proto == PROTO_VERSION => Ok(r),
            Ok(Ok(Resp::Hello { proto })) => Err(format!("agent speaks protocol {proto}, this app {PROTO_VERSION}")),
            Ok(Ok(other)) => Err(format!("unexpected handshake reply: {other:?}")),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(r.lost("agent handshake timed out")),
        }
    }

    /// Resolves once the reader saw the stream end (EOF, a bad frame, the process gone).
    pub async fn closed(&self) {
        let mut rx = self.closed.clone();
        let _ = rx.wait_for(|c| *c).await;
    }

    /// Cut the link (kill ssh / the agent): a hung connection then ends like a dropped one.
    pub fn kill(&self) {
        let _ = self.child.lock().unwrap_or_else(|e| e.into_inner()).start_kill();
    }

    /// Why the link ended, for the UI: "connection lost" plus ssh's last words.
    pub fn lost_reason(&self) -> String {
        self.lost("connection lost")
    }

    fn lost(&self, what: &str) -> String {
        let tail = self.stderr_tail.lock().unwrap_or_else(|e| e.into_inner()).trim().to_string();
        if tail.is_empty() { what.into() } else { format!("{what}: {tail}") }
    }

    pub async fn call(&self, req: Req) -> Result<Resp, String> {
        self.call_with(req, None).await
    }

    pub async fn call_with(&self, req: Req, sink: Option<Sink>) -> Result<Resp, String> {
        self.call_timed(req, sink).await.map(|(r, _)| r)
    }

    /// The reply and the agent's own handling time (ms), when it reports one.
    pub async fn call_timed(&self, req: Req, sink: Option<Sink>) -> Result<(Resp, Option<u32>), String> {
        let id = self.next.fetch_add(1, SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, (tx, sink));
        // Check after inserting: if the reader died before this, it already drained; if after, it drains us.
        if self.dead.load(SeqCst) {
            self.forget(id);
            return Err(self.lost("connection lost"));
        }
        let bytes = encode(&Msg { id, body: req, ms: None });
        let sent = {
            let mut w = self.stdin.lock().await;
            w.write_all(&bytes).await.and(w.flush().await)
        };
        if sent.is_err() {
            self.forget(id);
            return Err(self.lost("connection lost"));
        }
        rx.await.map_err(|_| self.lost("connection lost"))
    }

    fn forget(&self, id: u64) {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }
}

async fn read_loop(stdout: ChildStdout, pending: Pending, dead: Arc<AtomicBool>, on_change: Arc<Mutex<Option<ChangeFn>>>, closed: watch::Sender<bool>) {
    let mut r = BufReader::new(stdout);
    if skip_to_magic(&mut r).await {
        loop {
            let mut hdr = [0u8; 4];
            if r.read_exact(&mut hdr).await.is_err() {
                break;
            }
            let Ok(n) = check_len(hdr) else { break };
            let mut buf = vec![0u8; n];
            if r.read_exact(&mut buf).await.is_err() {
                break;
            }
            let Ok(m) = decode::<Resp>(&buf) else { break };
            if let Resp::Output(text) = &m.body {
                // an event: the request keeps waiting for its reply
                let sink = pending.lock().unwrap_or_else(|e| e.into_inner()).get(&m.id).and_then(|p| p.1.clone());
                if let Some(s) = sink {
                    s(text);
                }
                continue;
            }
            if let Resp::Changed(c) = m.body {
                // an unsolicited watcher event (id 0)
                let on = on_change.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if let Some(on) = on {
                    on(c);
                }
                continue;
            }
            if let Some((tx, _)) = pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&m.id) {
                let _ = tx.send((m.body, m.ms));
            }
        }
    }
    // Order matters: flag first, then drain, so `call` can never wait on a reply that cannot come.
    dead.store(true, SeqCst);
    pending.lock().unwrap_or_else(|e| e.into_inner()).clear();
    let _ = closed.send(true);
}

/// Discard whatever a remote shell printed before the agent's marker (bounded: 64 KiB).
async fn skip_to_magic<R: AsyncRead + Unpin>(r: &mut R) -> bool {
    let mut window: Vec<u8> = Vec::with_capacity(MAGIC.len() + 1);
    for _ in 0..(64 << 10) {
        let mut b = [0u8; 1];
        if r.read_exact(&mut b).await.is_err() {
            return false;
        }
        window.push(b[0]);
        if window.ends_with(MAGIC) {
            return true;
        }
        if window.len() > MAGIC.len() {
            window.remove(0);
        }
    }
    false
}

async fn collect_stderr(mut e: ChildStderr, tail: Arc<Mutex<String>>) {
    let mut buf = [0u8; 512];
    while let Ok(n) = e.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
        t.push_str(&String::from_utf8_lossy(&buf[..n]));
        if t.len() > STDERR_TAIL {
            let mut cut = t.len() - STDERR_TAIL;
            while !t.is_char_boundary(cut) {
                cut += 1;
            }
            t.drain(..cut);
        }
    }
}

fn ssh_cmd(host: &str) -> Command {
    let mut c = Command::new(SSH);
    // One multiplexed connection: later calls (probe, upload, agent) skip the handshake.
    c.args([
        "-o", "BatchMode=yes",
        "-o", "ControlMaster=auto",
        "-o", "ControlPath=~/.ssh/commitkiwi-%C",
        "-o", "ControlPersist=10m",
        "-o", "ConnectTimeout=10",
        // a silently dead network ends ssh (and so the agent stream) within ~45 s instead of hanging forever
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
        "--",
    ])
    .arg(host)
    .kill_on_drop(true);
    c
}

/// Run `script` on the host (login shell, so `~` expands). Returns stdout; Err carries stderr.
async fn ssh_run(host: &str, script: &str, stdin: Option<&[u8]>) -> Result<String, String> {
    let mut c = ssh_cmd(host);
    debug_assert!(!script.contains('\''));
    c.arg(format!("sh -c '{script}'")).stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| format!("cannot start ssh: {e}"))?;
    if let (Some(data), Some(mut w)) = (stdin, child.stdin.take()) {
        w.write_all(data).await.map_err(|e| format!("upload failed: {e}"))?;
        // dropping `w` closes stdin so the remote `cat` ends
    }
    let out = child.wait_with_output().await.map_err(|e| format!("ssh failed: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(format!("ssh {host}: {}", err.trim()))
    }
}

/// Host comes from the UI. A leading `-` would be read by ssh as an option (e.g. ProxyCommand).
pub fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 255
        && !h.starts_with('-')
        && h.chars().all(|c| c.is_ascii_alphanumeric() || "._@-".contains(c))
}

/// `uname -sm` output -> directory name used for agent builds (`linux-x86_64`).
fn platform_dir(uname: &str) -> Result<String, String> {
    let mut it = uname.split_whitespace();
    let (os, arch) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
    let os = match os {
        "Linux" => "linux",
        "Darwin" => "darwin",
        _ => return Err(format!("unsupported remote OS: {os:?}")),
    };
    let arch = match arch {
        "x86_64" | "amd64" => "x86_64",
        "aarch64" | "arm64" => "aarch64",
        _ => return Err(format!("unsupported remote CPU: {arch:?}")),
    };
    Ok(format!("{os}-{arch}"))
}

fn local_platform() -> String {
    let os = if std::env::consts::OS == "macos" { "darwin" } else { std::env::consts::OS };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// Where agent builds are searched, in order (COMMITKIWI_AGENT_DIR, or a pre-rename SOURCERYKIWI_/MERGEKIWI_/GITMERGE_AGENT_DIR, first).
/// Layout: `<dir>/<platform>/commitkiwi-agent`.
fn agent_dirs(exe_dir: Option<&std::path::Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var("COMMITKIWI_AGENT_DIR").or_else(|_| std::env::var("SOURCERYKIWI_AGENT_DIR")).or_else(|_| std::env::var("MERGEKIWI_AGENT_DIR")).or_else(|_| std::env::var("GITMERGE_AGENT_DIR")).into_iter().map(PathBuf::from).collect();
    if let Some(d) = exe_dir {
        dirs.push(d.join("agents"));
        dirs.push(d.join("../Resources/agents")); // macOS bundle
    }
    // `cargo run` / `tauri dev`: the exe sits in target/debug, but scripts/build-agents.sh writes to <repo>/agents.
    if cfg!(debug_assertions) {
        dirs.push(PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../agents")));
    }
    dirs
}

/// Where an agent build lives on a remote: named by its hash, so a changed build installs itself next to the old one.
fn remote_agent_path(bin: &[u8]) -> String {
    let hash: String = Sha256::digest(bin).iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("~/.cache/commitkiwi/agent-{hash}")
}

/// The agent builds this app ships, as (platform, path it gets on a remote), for the Preferences window.
pub fn bundled_agents() -> Vec<(String, String)> {
    ["linux-x86_64", "linux-aarch64", "darwin-x86_64", "darwin-aarch64"]
        .iter()
        .filter_map(|p| Some((p.to_string(), remote_agent_path(&std::fs::read(find_agent(p).ok()?).ok()?))))
        .collect()
}

fn find_agent(platform: &str) -> Result<PathBuf, String> {
    let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf()));
    let dirs = agent_dirs(exe_dir.as_deref());
    let mut found = dirs.iter().map(|d| d.join(platform).join("commitkiwi-agent")).find(|f| f.is_file());
    if found.is_none() && platform == local_platform() {
        // ssh to the same OS and CPU as this machine: the agent built next to this binary.
        found = exe_dir.map(|d| d.join("commitkiwi-agent")).filter(|f| f.is_file());
    }
    found.ok_or_else(|| {
        let looked: Vec<_> = dirs.iter().map(|d| d.join(platform).display().to_string()).collect();
        format!("no agent build for {platform}; run scripts/build-agents.sh (looked in: {})", looked.join(", "))
    })
}

/// Concrete `Host` aliases from ~/.ssh/config, for the host picker.
/// shortcut: `Include` files are not followed; add that if the picker misses hosts.
pub fn ssh_hosts() -> Vec<String> {
    let path = std::env::var("HOME").map(|h| PathBuf::from(h).join(".ssh/config"));
    path.ok().and_then(|p| std::fs::read_to_string(p).ok()).map(|s| parse_ssh_hosts(&s)).unwrap_or_default()
}

fn parse_ssh_hosts(config: &str) -> Vec<String> {
    let mut hosts: Vec<String> = config
        .lines()
        .filter_map(|l| {
            let mut w = l.split_whitespace();
            w.next()?.eq_ignore_ascii_case("host").then_some(w)
        })
        .flatten()
        .filter(|h| !h.contains(['*', '?', '!']) && valid_host(h))
        .map(String::from)
        .collect();
    hosts.sort();
    hosts.dedup();
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_validation() {
        assert!(valid_host("example-host") && valid_host("me@dev-1.example.com"));
        for bad in ["", "-oProxyCommand=x", "a b", "a;rm", "a$(x)", "a/b"] {
            assert!(!valid_host(bad), "{bad:?}");
        }
    }

    #[test]
    fn dev_builds_search_the_repo_agents_dir() {
        let dirs = agent_dirs(Some(std::path::Path::new("/x/target/debug")));
        assert!(dirs.iter().any(|d| d.ends_with("crates/runner/../../agents")), "{dirs:?}");
        assert!(dirs.contains(&PathBuf::from("/x/target/debug/agents")));
        let err = find_agent("plan9-mips").unwrap_err();
        assert!(err.contains("plan9-mips") && err.contains("looked in"), "{err}");
    }

    #[test]
    fn release_bundles_search_the_app_resources() {
        // tauri.conf.json bundle.resources puts the agents at Contents/Resources/agents/<platform>/commitkiwi-agent
        let dirs = agent_dirs(Some(std::path::Path::new("/Applications/commit.kiwi.app/Contents/MacOS")));
        assert!(dirs.contains(&PathBuf::from("/Applications/commit.kiwi.app/Contents/MacOS/../Resources/agents")), "{dirs:?}");
    }

    /// Runs the very script the remote gets, with `sh -c` in a temp HOME.
    fn sweep(home: &std::path::Path, cur: &str, minutes: u64) -> String {
        let out = std::process::Command::new("sh").arg("-c").arg(cleanup_script(cur, minutes).unwrap()).env("HOME", home).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    fn age(p: &std::path::Path, days: u64) {
        let t = std::time::SystemTime::now() - std::time::Duration::from_secs(days * 86400);
        std::fs::File::open(p).unwrap().set_modified(t).unwrap();
    }

    #[test]
    fn cleanup_script_rejects_hostile_names() {
        for bad in ["", "agent-", "agent-x", "agent-0a; rm -rf ~", "agent-0a'b", "agent-0a b", "../agent-0a", "agent-$(x)", "other-0a"] {
            assert!(cleanup_script(bad, 1).is_err(), "{bad:?}");
        }
        assert!(cleanup_script("agent-0123456789abcdef", 1).is_ok());
        assert!(!cleanup_script("agent-0123456789abcdef", 1).unwrap().contains('\''));
    }

    #[test]
    fn cleanup_sweeps_only_old_agent_files() {
        let home = tempfile::tempdir().unwrap();
        let d = home.path().join(".cache/commitkiwi");
        std::fs::create_dir_all(d.join("agent-dir")).unwrap();
        let w = |n: &str, len: usize, days: u64| {
            std::fs::write(d.join(n), vec![b'x'; len]).unwrap();
            age(&d.join(n), days);
        };
        w("agent-aaaa", 10, 90); // current, old: kept and touched
        w("agent-bbbb", 100, 40); // old: removed
        w("agent-cc dd $(touch pwned) -rf", 50, 40); // hostile file name: removed, not executed
        w("agent-dddd", 7, 5); // recent (another computer): kept
        w("agent-eeee.part.1", 7, 40); // stale half upload: removed
        w("agent-ffff.part.2", 7, 0); // fresh half upload: kept
        w("notagent", 7, 400); // unrelated: kept
        w(".agent-hidden", 7, 400);
        w("agent-gggg", 7, 400);
        std::os::unix::fs::symlink(d.join("notagent"), d.join("agent-link")).unwrap();
        std::os::unix::fs::symlink(&home, d.join("agent-linkdir")).unwrap();
        age(&d.join("agent-dir"), 400);
        std::fs::write(d.join("agent-dir/inner"), "x").unwrap();
        let before = std::fs::metadata(d.join("agent-aaaa")).unwrap().modified().unwrap();
        assert_eq!(sweep(home.path(), "agent-aaaa", 30 * 1440), "4 164");
        let left = |n: &str| d.join(n).symlink_metadata().is_ok();
        for kept in ["agent-aaaa", "agent-dddd", "agent-ffff.part.2", "notagent", ".agent-hidden", "agent-link", "agent-linkdir", "agent-dir/inner"] {
            assert!(left(kept), "{kept} was removed");
        }
        for gone in ["agent-bbbb", "agent-cc dd $(touch pwned) -rf", "agent-eeee.part.1", "agent-gggg"] {
            assert!(!left(gone), "{gone} survived");
        }
        assert!(!home.path().join("pwned").exists() && !d.join("pwned").exists());
        assert!(std::fs::metadata(d.join("agent-aaaa")).unwrap().modified().unwrap() > before, "current not touched");
        // 0: everything but the current one and the fresh half upload; a missing current file is not created
        assert_eq!(sweep(home.path(), "agent-aaaa", 0), "1 7");
        assert!(!left("agent-dddd") && left("agent-aaaa") && left("agent-ffff.part.2") && left("agent-link"));
        assert_eq!(sweep(home.path(), "agent-9999", 0), "1 10"); // nothing is current: aaaa goes too, 9999 is not made
        assert!(!left("agent-9999"));
        // no cache folder at all
        assert_eq!(sweep(tempfile::tempdir().unwrap().path(), "agent-aaaa", 1), "0 0");
    }

    #[test]
    fn cleanup_sweeps_the_pre_rename_cache_dir() {
        let home = tempfile::tempdir().unwrap();
        let (d, o) = (home.path().join(".cache/commitkiwi"), home.path().join(".cache/sourcerykiwi"));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::create_dir_all(&o).unwrap();
        let w = |p: std::path::PathBuf, len: usize, days: u64| {
            std::fs::write(&p, vec![b'x'; len]).unwrap();
            age(&p, days);
        };
        w(d.join("agent-aaaa"), 1, 0); // current
        w(o.join("agent-aaaa"), 10, 40); // same name in the old dir is not "current": removed
        w(o.join("agent-bbbb"), 20, 5); // recent: kept, so the old dir stays
        w(o.join("notagent"), 3, 400);
        std::os::unix::fs::symlink(o.join("notagent"), o.join("agent-link")).unwrap();
        assert_eq!(sweep(home.path(), "agent-aaaa", 30 * 1440), "1 10");
        assert!(d.join("agent-aaaa").exists() && o.join("agent-bbbb").exists() && o.join("agent-link").symlink_metadata().is_ok());
        assert_eq!(sweep(home.path(), "agent-aaaa", 0), "1 20");
        assert!(o.join("notagent").exists(), "other files keep the old dir");
        std::fs::remove_file(o.join("notagent")).unwrap();
        std::fs::remove_file(o.join("agent-link")).unwrap();
        assert_eq!(sweep(home.path(), "agent-aaaa", 0), "0 0");
        assert!(!o.exists(), "empty old dir removed");
        assert!(d.join("agent-aaaa").exists());
        // the old dir as a symlink: never followed into, never removed
        let elsewhere = tempfile::tempdir().unwrap();
        w(elsewhere.path().join("agent-cccc"), 5, 400);
        std::os::unix::fs::symlink(elsewhere.path(), &o).unwrap();
        assert_eq!(sweep(home.path(), "agent-aaaa", 0), "0 0");
        assert!(o.symlink_metadata().is_ok() && elsewhere.path().join("agent-cccc").exists());
        // the older names are swept the same way, an old dir with other files stays
        let (merge, gitmerge) = (home.path().join(".cache/mergekiwi"), home.path().join(".cache/gitmerge"));
        std::fs::create_dir_all(&merge).unwrap();
        std::fs::create_dir_all(&gitmerge).unwrap();
        w(merge.join("agent-dddd"), 4, 400);
        w(gitmerge.join("agent-eeee"), 6, 400);
        w(gitmerge.join("agent-ffff"), 7, 1); // recent
        assert_eq!(sweep(home.path(), "agent-aaaa", 30 * 1440), "2 10");
        assert!(!merge.exists(), "emptied: removed");
        assert!(gitmerge.join("agent-ffff").exists() && d.join("agent-aaaa").exists());
    }

    #[test]
    fn platforms() {
        assert_eq!(platform_dir("Linux x86_64\n").unwrap(), "linux-x86_64");
        assert_eq!(platform_dir("Darwin arm64").unwrap(), "darwin-aarch64");
        assert!(platform_dir("FreeBSD amd64").is_err() && platform_dir("Linux riscv64").is_err());
    }

    #[test]
    fn hosts_from_config() {
        let cfg = "Host *\n  User x\nhost example-host  staging\n\tHostName 1.2.3.4\nHost web-* !bad\nHostname nope\nHost example-host\n";
        assert_eq!(parse_ssh_hosts(cfg), ["example-host", "staging"]);
    }

    #[tokio::test]
    async fn skips_shell_noise_before_magic() {
        let mut data = b"Welcome to box!\n".to_vec();
        data.extend_from_slice(MAGIC);
        data.extend_from_slice(b"rest");
        let mut r = &data[..];
        assert!(skip_to_magic(&mut r).await);
        assert_eq!(r, b"rest");
        assert!(!skip_to_magic(&mut &b"no marker here"[..]).await);
    }
}

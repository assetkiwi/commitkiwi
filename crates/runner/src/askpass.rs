//! Password/passphrase prompts for git and ssh run on LOCAL repos (remote repos keep git's error: they rely on the
//! user's ssh agent). git and ssh run the askpass program (`GIT_ASKPASS`, `SSH_ASKPASS`) with the prompt as its
//! argument and read the answer from its stdout. Ours is the app's own executable in helper mode ([`helper_main`]):
//! it asks the running app over a unix socket in a private (0700) temp dir, authenticated with a random token, and
//! the app shows the prompt in the window. Answers are never stored or logged: they pass socket -> stdout -> git.
//!
//! Wire: the helper sends `<token>\n<prompt>` and closes its write side; the app replies `1<answer>` or `0` (cancelled).
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Env vars the helper reads; their presence is what puts the executable in helper mode.
pub const SOCK_ENV: &str = "COMMITKIWI_ASKPASS_SOCK";
pub const TOKEN_ENV: &str = "COMMITKIWI_ASKPASS_TOKEN";
/// How long one prompt waits for the user before it counts as cancelled.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_PROMPT: u64 = 16 << 10;

type Pending = Arc<Mutex<HashMap<u64, Sender<Option<String>>>>>;

pub struct Askpass {
    dir: PathBuf,
    sock: PathBuf,
    token: String,
    pending: Pending,
}

fn random_hex(bytes: usize) -> std::io::Result<String> {
    let mut b = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// Equal-time compare, so the token can't be guessed byte by byte.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl Askpass {
    /// Listen for prompts; `on_prompt(id, prompt)` shows one, [`Askpass::answer`] replies to it.
    pub fn start(on_prompt: impl Fn(u64, String) + Send + Sync + 'static) -> std::io::Result<Self> {
        // short name: unix socket paths are limited to ~104 bytes and macOS temp dirs are long
        let dir = std::env::temp_dir().join(format!("gm-{}", random_hex(8)?));
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?; // fails if it exists: nobody planted it
        let sock = dir.join("s");
        let listener = UnixListener::bind(&sock)?;
        std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600))?;
        let (token, pending): (String, Pending) = (random_hex(32)?, Arc::default());
        let (tok, pend, on_prompt) = (token.clone(), pending.clone(), Arc::new(on_prompt));
        std::thread::spawn(move || {
            let next = AtomicU64::new(1);
            for conn in listener.incoming().flatten() {
                let (tok, pend, on_prompt) = (tok.clone(), pend.clone(), on_prompt.clone());
                let id = next.fetch_add(1, Ordering::Relaxed);
                std::thread::spawn(move || serve(conn, &tok, id, &pend, &*on_prompt));
            }
        });
        Ok(Self { dir, sock, token, pending })
    }

    /// The environment for git writes: askpass for git and ssh (forced, there is no terminal), plus the channel.
    pub fn env(&self, helper: &Path) -> Vec<(String, String)> {
        let h = helper.to_string_lossy().into_owned();
        vec![
            ("GIT_ASKPASS".into(), h.clone()),
            ("SSH_ASKPASS".into(), h),
            ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
            (SOCK_ENV.into(), self.sock.to_string_lossy().into_owned()),
            (TOKEN_ENV.into(), self.token.clone()),
        ]
    }

    /// The user's answer to prompt `id`; None = cancelled. Unknown ids (timed out, git gone) are ignored.
    pub fn answer(&self, id: u64, answer: Option<String>) {
        if let Some(tx) = self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
            let _ = tx.send(answer);
        }
    }
}

impl Drop for Askpass {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn serve(mut conn: UnixStream, token: &str, id: u64, pending: &Pending, on_prompt: &(dyn Fn(u64, String) + Send + Sync)) {
    let _ = conn.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::new();
    if (&mut conn).take(MAX_PROMPT).read_to_end(&mut buf).is_err() {
        return;
    }
    let Some(nl) = buf.iter().position(|&b| b == b'\n') else { return };
    if !same(&buf[..nl], token.as_bytes()) {
        return; // not our helper: no prompt, no reply
    }
    let prompt = String::from_utf8_lossy(&buf[nl + 1..]).into_owned();
    let (tx, rx) = channel();
    pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
    on_prompt(id, prompt);
    let answer = rx.recv_timeout(ANSWER_TIMEOUT).ok().flatten();
    pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    let reply = match answer {
        Some(a) => [b"1".as_slice(), a.as_bytes()].concat(),
        None => b"0".to_vec(),
    };
    let _ = conn.write_all(&reply);
}

/// Helper mode, when [`SOCK_ENV`] is set: ask the app, print the answer for git/ssh. Exit code 1 = cancelled/failed.
pub fn helper_main() -> i32 {
    let (Ok(sock), Ok(token)) = (std::env::var(SOCK_ENV), std::env::var(TOKEN_ENV)) else { return 1 };
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let ask = || -> std::io::Result<Option<String>> {
        let mut c = UnixStream::connect(sock)?;
        c.write_all(format!("{token}\n{prompt}").as_bytes())?;
        c.shutdown(std::net::Shutdown::Write)?;
        let mut reply = Vec::new();
        c.read_to_end(&mut reply)?;
        Ok(reply.strip_prefix(b"1").map(|a| String::from_utf8_lossy(a).into_owned()))
    };
    match ask() {
        Ok(Some(answer)) => {
            let mut out = std::io::stdout();
            if writeln!(out, "{answer}").and_then(|()| out.flush()).is_ok() { 0 } else { 1 }
        }
        _ => 1,
    }
}

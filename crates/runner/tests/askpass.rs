//! The askpass channel end to end: real git asks the helper binary, the helper asks our server, the "UI" answers.
use commitkiwi_runner::askpass::{Askpass, SOCK_ENV, TOKEN_ENV};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::mpsc::channel;
use std::sync::{Arc, OnceLock};

const HELPER: &str = env!("CARGO_BIN_EXE_commitkiwi-askpass");

/// `git credential fill` prompts for username and password through GIT_ASKPASS: no network needed.
fn fill(env: &[(String, String)], home: &std::path::Path) -> std::process::Output {
    let mut c = Command::new("git");
    c.args(["-c", "credential.helper=", "credential", "fill"])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", home)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = c.spawn().unwrap();
    child.stdin.take().unwrap().write_all(b"protocol=https\nhost=example.com\n\n").unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn askpass_round_trip() {
    let home = tempfile::tempdir().unwrap();
    let (tx, rx) = channel::<(u64, String)>();
    let tx = std::sync::Mutex::new(tx);
    let server = Arc::new(Askpass::start(move |id, prompt| { let _ = tx.lock().unwrap().send((id, prompt)); }).unwrap());
    let env = server.env(std::path::Path::new(HELPER));
    let sock = env.iter().find(|(k, _)| k == SOCK_ENV).unwrap().1.clone();
    let mode = std::fs::metadata(std::path::Path::new(&sock).parent().unwrap()).unwrap();
    assert_eq!(std::os::unix::fs::PermissionsExt::mode(&mode.permissions()) & 0o777, 0o700, "private dir");

    // the "UI": answers username, then password; records the prompts it saw
    let seen = Arc::new(OnceLock::<Vec<String>>::new());
    let (srv, seen2) = (server.clone(), seen.clone());
    let ui = std::thread::spawn(move || {
        let mut prompts = Vec::new();
        for _ in 0..2 {
            let (id, p) = rx.recv().unwrap();
            srv.answer(id, Some(if p.starts_with("Username") { "alice".into() } else { "s3cret pass".into() }));
            prompts.push(p);
        }
        // third prompt (next run): cancel
        let (id, _) = rx.recv().unwrap();
        srv.answer(id, None);
        let _ = seen2.set(prompts);
    });
    let out = fill(&env, home.path());
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(text.contains("username=alice\n") && text.contains("password=s3cret pass\n"), "{text}");

    // cancel: git fails, no password
    let out = fill(&env, home.path());
    assert!(!out.status.success());
    assert!(!String::from_utf8_lossy(&out.stdout).contains("password="));
    ui.join().unwrap();
    let prompts = seen.get().unwrap();
    assert!(prompts[0].starts_with("Username for 'https://example.com'"), "{prompts:?}");
    assert!(prompts[1].starts_with("Password for 'https://alice@example.com'"), "{prompts:?}");

    // a wrong token is never shown to the user and gets no answer
    let mut bad = env.clone();
    bad.iter_mut().find(|(k, _)| k == TOKEN_ENV).unwrap().1 = "0".repeat(64);
    let out = Command::new(HELPER).arg("Password: ").envs(bad.iter().map(|(k, v)| (k, v))).output().unwrap();
    assert!(!out.status.success() && out.stdout.is_empty());
    let out = Command::new(HELPER).arg("x").env_remove(SOCK_ENV).output().unwrap();
    assert!(!out.status.success(), "no channel: fail, never hang");
}

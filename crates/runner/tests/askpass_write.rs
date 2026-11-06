//! A real git write (fetch over http) from core asks for credentials through the app's askpass channel, and the
//! answer never shows up in the job's output or error. A tiny local HTTP server always answers 401.
use commitkiwi_protocol::{Req, Resp};
use commitkiwi_runner::askpass::Askpass;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

#[test]
fn write_asks_through_the_app() {
    // SAFETY: only test in this binary.
    unsafe {
        for (k, v) in [("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_SYSTEM", "/dev/null")] {
            std::env::set_var(k, v);
        }
    }
    let http = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = http.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut c in http.incoming().flatten() {
            let mut buf = [0u8; 4096];
            let _ = c.read(&mut buf);
            let _ = c.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"x\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
    });
    let (tx, rx) = channel::<(u64, String)>();
    let tx = Mutex::new(tx);
    let server = Arc::new(Askpass::start(move |id, p| { let _ = tx.lock().unwrap().send((id, p)); }).unwrap());
    commitkiwi_runner::set_local_write_env(server.env(std::path::Path::new(env!("CARGO_BIN_EXE_commitkiwi-askpass"))));
    let srv = server.clone();
    let ui = std::thread::spawn(move || {
        let mut prompts = Vec::new();
        while let Ok((id, p)) = rx.recv_timeout(std::time::Duration::from_secs(20)) {
            srv.answer(id, Some(if p.starts_with("Username") { "bob".into() } else { "hunter2-secret".into() }));
            prompts.push(p);
            if prompts.len() == 2 {
                break;
            }
        }
        prompts
    });

    let d = tempfile::tempdir().unwrap();
    assert!(Command::new("git").args(["init", "-q"]).arg(d.path()).status().unwrap().success());
    let url = format!("http://127.0.0.1:{port}/r.git");
    assert!(Command::new("git").arg("-C").arg(d.path()).args(["remote", "add", "origin", &url]).status().unwrap().success());
    let out = Arc::new(Mutex::new(String::new()));
    let o = out.clone();
    let sink: commitkiwi_runner::Sink = Arc::new(move |t: &str| o.lock().unwrap().push_str(t));
    let r = commitkiwi_core::handle_with(Req::Job { job: 1, req: Box::new(Req::Fetch { repo: d.path().to_str().unwrap().into(), flags: vec![], remote: None }) }, Some(sink));
    let Resp::Err(e) = r else { panic!("401 forever must fail: {r:?}") };
    let prompts = ui.join().unwrap();
    assert_eq!(prompts.len(), 2, "{prompts:?} / {e}");
    assert!(prompts[0].starts_with("Username for") && prompts[1].starts_with("Password for"), "{prompts:?}");
    assert!(!e.contains("hunter2") && !out.lock().unwrap().contains("hunter2"), "{e}");
    // reads never ask: they keep GIT_TERMINAL_PROMPT=0 and get no askpass
    assert!(matches!(commitkiwi_core::handle(Req::Status { repo: d.path().to_str().unwrap().into() }), Resp::Status(_)));
}

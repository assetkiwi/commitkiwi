//! Console jobs: output streaming, ref moves for Undo, cancel (queued and running), reads not blocked by a job.
//! Single test: it sets process env to isolate from the user's git config.
use commitkiwi_core::{CANCELLED, Sink, handle, handle_with};
use commitkiwi_protocol::*;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn job(job: u64, req: Req) -> Req {
    Req::Job { job, req: Box::new(req) }
}

fn wait_for(what: &str, f: impl Fn() -> bool) {
    let t = Instant::now();
    while !f() {
        assert!(t.elapsed() < Duration::from_secs(10), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn jobs() {
    // SAFETY: only test in this binary; set before any thread starts.
    unsafe {
        for (k, v) in [
            ("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_SYSTEM", "/dev/null"),
            ("GIT_AUTHOR_NAME", "Tester"), ("GIT_AUTHOR_EMAIL", "t@example.com"),
            ("GIT_COMMITTER_NAME", "Tester"), ("GIT_COMMITTER_EMAIL", "t@example.com"),
        ] {
            std::env::set_var(k, v);
        }
    }
    let d = tempfile::tempdir().unwrap();
    let dir = d.path();
    let repo = dir.to_str().unwrap().to_string();
    git(dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", "first"]);
    let first = git(dir, &["rev-parse", "HEAD"]);

    // a commit job streams git's summary and reports HEAD and main moving
    std::fs::write(dir.join("a.txt"), "two\n").unwrap();
    git(dir, &["add", "."]);
    let out = Arc::new(Mutex::new(String::new()));
    let o = out.clone();
    let sink: Sink = Arc::new(move |t: &str| o.lock().unwrap().push_str(t));
    let commit = Req::Commit { repo: repo.clone(), message: "second".into(), amend: false, signoff: false, no_verify: false };
    let Resp::Moved(m) = handle_with(job(1, commit.clone()), Some(sink)) else { panic!("commit job must report moves") };
    let second = git(dir, &["rev-parse", "HEAD"]);
    assert_eq!(m.head_before, Head { branch: Some("refs/heads/main".into()), oid: Some(first.clone()) });
    assert_eq!(m.head_after, Head { branch: Some("refs/heads/main".into()), oid: Some(second.clone()) });
    assert_eq!(m.refs, [RefMove { name: "refs/heads/main".into(), before: Some(first.clone()), after: Some(second.clone()) }]);
    assert!(out.lock().unwrap().contains("second"), "commit summary streamed: {:?}", out.lock().unwrap());

    // a branch checkout moves HEAD only; a stash creates refs/stash
    git(dir, &["branch", "side", &first]);
    let Resp::Moved(m) = handle(job(2, Req::Checkout { repo: repo.clone(), name: "side".into() })) else { panic!() };
    assert_eq!((m.head_after.branch.as_deref(), m.refs.len()), (Some("refs/heads/side"), 0));
    std::fs::write(dir.join("a.txt"), "dirty\n").unwrap();
    let Resp::Moved(m) = handle(job(3, Req::Stash { repo: repo.clone(), flags: vec![] })) else { panic!() };
    assert_eq!((m.refs[0].name.as_str(), m.refs[0].before.as_deref()), ("refs/stash", None));
    // non-ref-moving writes still answer Done; a failing one carries git's error
    std::fs::write(dir.join("b.txt"), "b\n").unwrap();
    assert!(matches!(handle(job(4, Req::Stage { repo: repo.clone(), paths: vec!["b.txt".into()] })), Resp::Done));
    let Resp::Err(e) = handle(job(5, Req::Checkout { repo: repo.clone(), name: "nope".into() })) else { panic!() };
    assert!(e.contains("nope"), "{e}");

    // cancelled before it started (still queued when the Cancel arrived): never runs
    std::fs::write(dir.join("c.txt"), "c\n").unwrap();
    assert!(matches!(handle(Req::Cancel { job: 6 }), Resp::Done));
    let r = handle(job(6, Req::Stage { repo: repo.clone(), paths: vec!["c.txt".into()] }));
    assert!(matches!(&r, Resp::Err(e) if e == CANCELLED), "{r:?}");
    assert!(git(dir, &["status", "--porcelain"]).contains("?? c.txt"), "c.txt must stay unstaged");

    // cancel a running job: a pre-commit hook that hangs is killed with git, HEAD does not move
    let hook = dir.join(".git/hooks/pre-commit");
    let started = dir.join("hook-started");
    let finished = dir.join("hook-finished");
    std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\nsleep 30\ntouch '{}'\n", started.display(), finished.display())).unwrap();
    Command::new("chmod").arg("755").arg(&hook).status().unwrap();
    let head = git(dir, &["rev-parse", "HEAD"]);
    let r = repo.clone();
    let t0 = Instant::now();
    let running = std::thread::spawn(move || {
        handle(job(7, Req::Commit { repo: r, message: "slow".into(), amend: false, signoff: false, no_verify: false }))
    });
    wait_for("the hook to start", || started.exists());
    // while the job hangs, reads still answer (they never wait for writes)
    let t = Instant::now();
    assert!(matches!(handle(Req::Status { repo: repo.clone() }), Resp::Status(_)));
    assert!(t.elapsed() < Duration::from_secs(5));
    assert!(matches!(handle(Req::Cancel { job: 7 }), Resp::Done));
    let r = running.join().unwrap();
    assert!(matches!(&r, Resp::Err(e) if e == CANCELLED), "{r:?}");
    assert!(t0.elapsed() < Duration::from_secs(20), "cancel must not wait for the hook");
    std::thread::sleep(Duration::from_millis(300));
    assert!(!finished.exists(), "the hook's sleep was killed too");
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), head);
    assert!(!dir.join(".git/index.lock").exists(), "git cleaned up its lock");
    // the job id is free again and later jobs run normally
    std::fs::remove_file(&hook).unwrap();
    assert!(matches!(handle(job(8, Req::Stage { repo: repo.clone(), paths: vec!["c.txt".into()] })), Resp::Done));

    // nesting is refused
    assert!(matches!(handle(job(9, job(10, Req::Hello))), Resp::Err(_)));
}

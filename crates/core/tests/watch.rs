//! M8 file watcher against temp repos: events arrive, ignored folders stay quiet, bursts coalesce, limits fall back.
//! One test function: it sets process env (isolated git config) and the steps share timing assumptions.
use commitkiwi_core::watch::{watch, watch_capped};
use commitkiwi_protocol::{Change, Req, Resp};
use std::path::Path;
use std::process::Command;
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-q", "-b", "main"]);
    std::fs::write(d.path().join(".gitignore"), "build/\n*.log\n").unwrap();
    std::fs::create_dir_all(d.path().join("src/deep")).unwrap();
    std::fs::create_dir_all(d.path().join("build/out")).unwrap();
    std::fs::create_dir_all(d.path().join("node_modules/x")).unwrap();
    std::fs::write(d.path().join("src/deep/a.txt"), "a").unwrap();
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-q", "-m", "c0"]);
    d
}

fn start(d: &Path) -> (commitkiwi_core::watch::Watcher, Receiver<Change>) {
    let (tx, rx) = channel();
    let w = watch(d.to_str().unwrap(), Box::new(move |c| { let _ = tx.send(c); })).expect("watching");
    std::thread::sleep(Duration::from_millis(300)); // FSEvents needs a moment before the stream delivers
    (w, rx)
}

/// Events within `wait`, after which the watcher had `quiet` with nothing more.
fn drain(rx: &Receiver<Change>, wait: Duration) -> Vec<Change> {
    let end = Instant::now() + wait;
    let mut v = vec![];
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(c) => v.push(c),
            Err(_) => break,
        }
    }
    v
}

#[test]
fn watcher() {
    // SAFETY: only test in this binary.
    unsafe {
        for (k, v) in [
            ("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_SYSTEM", "/dev/null"),
            ("GIT_AUTHOR_NAME", "T"), ("GIT_AUTHOR_EMAIL", "t@x"), ("GIT_COMMITTER_NAME", "T"), ("GIT_COMMITTER_EMAIL", "t@x"),
        ] {
            std::env::set_var(k, v);
        }
    }
    let d = repo();
    let p = d.path();
    let (w, rx) = start(p);
    let name = p.to_str().unwrap().to_string();

    // a worktree edit: one event within 1 s, worktree only
    let t = Instant::now();
    std::fs::write(p.join("src/deep/a.txt"), "changed").unwrap();
    let c = rx.recv_timeout(Duration::from_secs(1)).expect("event within 1 s");
    println!("edit -> event in {:?}", t.elapsed());
    assert_eq!((c.repo.as_str(), c.work, c.refs, c.polling.as_deref()), (name.as_str(), true, false, None), "{c:?}");
    assert!(drain(&rx, Duration::from_millis(600)).is_empty(), "one event per edit");

    // ignored folders (gitignored, node_modules) and ignored files stay quiet
    std::fs::write(p.join("build/out/x.o"), "o").unwrap();
    std::fs::write(p.join("node_modules/x/i.js"), "i").unwrap();
    std::fs::write(p.join("src/debug.log"), "l").unwrap();
    let got = drain(&rx, Duration::from_millis(1200));
    assert!(got.is_empty(), "ignored paths must not refresh: {got:?}");

    // a new folder (created after start) is watched too, a new ignored one is not
    std::fs::create_dir_all(p.join("newdir/sub")).unwrap();
    std::fs::write(p.join("newdir/sub/n.txt"), "n").unwrap();
    assert!(!drain(&rx, Duration::from_millis(800)).is_empty(), "new folder's file");
    std::fs::write(p.join("newdir/sub/n.txt"), "n2").unwrap();
    assert!(rx.recv_timeout(Duration::from_secs(1)).is_ok(), "edit inside a folder created after start");
    let _ = drain(&rx, Duration::from_millis(500));

    // .git/HEAD moves (checkout of a new branch): a refs event
    git(p, &["checkout", "-q", "-b", "feature"]);
    let got = drain(&rx, Duration::from_millis(1200));
    assert!(got.iter().any(|c| c.refs), "HEAD change: {got:?}");
    // a commit: refs + index
    std::fs::write(p.join("src/deep/a.txt"), "committed").unwrap();
    git(p, &["commit", "-qam", "c1"]);
    let got = drain(&rx, Duration::from_millis(1200));
    assert!(got.iter().any(|c| c.refs) && got.iter().any(|c| c.work), "commit: {got:?}");
    // staging only touches the index: a worktree/status event, no refs
    std::fs::write(p.join("src/deep/a.txt"), "staged").unwrap();
    let _ = drain(&rx, Duration::from_millis(600));
    git(p, &["add", "src/deep/a.txt"]);
    let got = drain(&rx, Duration::from_millis(1000));
    assert!(!got.is_empty() && got.iter().all(|c| c.work && !c.refs), "index change: {got:?}");

    // our own status polls write nothing (GIT_OPTIONAL_LOCKS=0), so they cannot feed back into events
    for _ in 0..3 {
        assert!(matches!(commitkiwi_core::handle(Req::Status { repo: name.clone() }), Resp::Status(_)));
    }
    let got = drain(&rx, Duration::from_millis(800));
    assert!(got.is_empty(), "status must not trigger events: {got:?}");

    // a burst of 300 writes over ~0.3 s coalesces into very few events
    for i in 0..300 {
        std::fs::write(p.join(format!("src/burst{i}.txt")), "b").unwrap();
        if i % 50 == 0 {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let got = drain(&rx, Duration::from_millis(1500));
    println!("burst of 300 writes -> {} events", got.len());
    assert!(!got.is_empty() && got.len() <= 3, "coalesced: {}", got.len());

    // unwatching (drop) stops events
    drop(w);
    std::thread::sleep(Duration::from_millis(100));
    std::fs::write(p.join("src/deep/a.txt"), "after").unwrap();
    assert!(drain(&rx, Duration::from_millis(800)).is_empty(), "dropped watcher is silent");

    // too many folders: refuse with a reason (the caller polls)
    let big = repo();
    for i in 0..20 {
        std::fs::create_dir_all(big.path().join(format!("d{i}"))).unwrap();
    }
    let err = watch_capped(big.path().to_str().unwrap(), 10, Box::new(|_| {})).err().expect("cap");
    assert!(err.contains("more than 10 folders"), "{err}");
    // skipped/ignored folders don't count against the cap
    assert!(watch_capped(p.to_str().unwrap(), 10, Box::new(|_| {})).is_ok());
    // not a repo
    let plain = tempfile::tempdir().unwrap();
    assert!(watch(plain.path().to_str().unwrap(), Box::new(|_| {})).is_err());
}

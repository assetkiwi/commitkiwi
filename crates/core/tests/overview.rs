//! The dashboard's `Overview` read against real git in temp repos: clean, dirty, ahead, behind, diverged, no
//! upstream, upstream gone, detached, empty, not a repository; that it runs no fsmonitor hook; and the dashboard's
//! fast-forward-only pull (`Pull --ff-only` as a job) refusing a diverged branch.
//! Single test: it sets process env to isolate from the user's git config.
use commitkiwi_core::handle;
use commitkiwi_protocol::*;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}
fn commit(dir: &Path, file: &str, msg: &str) {
    std::fs::write(dir.join(file), msg).unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", msg]);
}
fn overview(dir: &Path) -> Overview {
    match handle(Req::Overview { repo: dir.to_str().unwrap().into() }) {
        Resp::Overview(o) => o,
        other => panic!("{other:?}"),
    }
}
fn job(req: Req) -> Resp {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    handle(Req::Job { job: N.fetch_add(1, std::sync::atomic::Ordering::Relaxed), req: Box::new(req) })
}
/// (branch, upstream, ahead, behind, changed)
fn short(o: &Overview) -> (Option<&str>, Option<&str>, u32, u32, u32) {
    (o.branch.as_deref(), o.upstream.as_deref(), o.ahead, o.behind, o.changed)
}

#[test]
fn overview_states() {
    // SAFETY: only test in this binary.
    unsafe {
        for (k, v) in [
            ("GIT_CONFIG_GLOBAL", "/dev/null"),
            ("GIT_CONFIG_SYSTEM", "/dev/null"),
            ("GIT_AUTHOR_NAME", "Tester"),
            ("GIT_AUTHOR_EMAIL", "t@example.com"),
            ("GIT_COMMITTER_NAME", "Tester"),
            ("GIT_COMMITTER_EMAIL", "t@example.com"),
        ] {
            std::env::set_var(k, v);
        }
    }
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let origin = t.join("origin.git");
    git(t, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    let seed = t.join("seed");
    git(t, &["clone", "-q", origin.to_str().unwrap(), seed.to_str().unwrap()]);
    commit(&seed, "a.txt", "first");
    git(&seed, &["push", "-q", "origin", "main"]);

    let d = t.join("repo");
    git(t, &["clone", "-q", origin.to_str().unwrap(), d.to_str().unwrap()]);

    // clean, tracking origin/main; last commit
    let o = overview(&d);
    assert_eq!(short(&o), (Some("main"), Some("origin/main"), 0, 0, 0));
    assert_eq!(o.subject.as_deref(), Some("first"));
    assert_eq!(o.time.map(|x| x.to_string()), Some(git(&d, &["log", "-1", "--format=%ct"])));

    // dirty: one modified, one untracked file in a new folder (counted per file, like Status)
    std::fs::write(d.join("a.txt"), "changed").unwrap();
    std::fs::create_dir(d.join("new")).unwrap();
    std::fs::write(d.join("new/b.txt"), "b").unwrap();
    assert_eq!(overview(&d).changed, 2);
    git(&d, &["checkout", "-q", "--", "a.txt"]);
    std::fs::remove_dir_all(d.join("new")).unwrap();

    // ahead
    commit(&d, "c.txt", "local");
    assert_eq!(short(&overview(&d)), (Some("main"), Some("origin/main"), 1, 0, 0));
    assert_eq!(overview(&d).subject.as_deref(), Some("local"));

    // behind (another clone pushed, we fetched) -> diverged
    commit(&seed, "d.txt", "remote");
    git(&seed, &["push", "-q", "origin", "main"]);
    git(&d, &["fetch", "-q"]);
    assert_eq!(short(&overview(&d)), (Some("main"), Some("origin/main"), 1, 1, 0));

    // the dashboard's pull is fast-forward only: a diverged branch is refused and nothing moves
    let before = git(&d, &["rev-parse", "HEAD"]);
    let r = job(Req::Pull { repo: d.to_str().unwrap().into(), flags: vec!["--ff-only".into()] });
    assert!(matches!(&r, Resp::Err(e) if e.contains("fast-forward")), "{r:?}");
    assert_eq!(git(&d, &["rev-parse", "HEAD"]), before);

    // behind only: drop the local commit, then the fast-forward pull works
    git(&d, &["reset", "-q", "--hard", "origin/main~1"]);
    assert_eq!(short(&overview(&d)), (Some("main"), Some("origin/main"), 0, 1, 0));
    assert!(matches!(job(Req::Pull { repo: d.to_str().unwrap().into(), flags: vec!["--ff-only".into()] }), Resp::Moved(_)));
    assert_eq!(short(&overview(&d)), (Some("main"), Some("origin/main"), 0, 0, 0));

    // no upstream
    git(&d, &["checkout", "-q", "-b", "topic"]);
    assert_eq!(short(&overview(&d)), (Some("topic"), None, 0, 0, 0));
    // upstream gone (pushed, then deleted on the remote and pruned)
    git(&d, &["push", "-q", "-u", "origin", "topic"]);
    assert_eq!(overview(&d).upstream.as_deref(), Some("origin/topic"));
    git(&d, &["push", "-q", "origin", "--delete", "topic"]);
    git(&d, &["fetch", "-q", "--prune"]);
    assert_eq!(short(&overview(&d)), (Some("topic"), None, 0, 0, 0));

    // detached
    git(&d, &["checkout", "-q", "--detach", "HEAD"]);
    let o = overview(&d);
    assert_eq!((o.branch.as_deref(), o.upstream.as_deref(), o.subject.as_deref()), (None, None, Some("remote")));

    // empty repository: a branch, no commit
    let e = t.join("empty");
    git(t, &["init", "-q", "-b", "main", e.to_str().unwrap()]);
    std::fs::write(e.join("x.txt"), "x").unwrap();
    assert_eq!(overview(&e), Overview { branch: Some("main".into()), changed: 1, ..Default::default() });

    // not a repository, and a folder that does not exist
    let plain = t.join("plain");
    std::fs::create_dir(&plain).unwrap();
    for p in [plain.clone(), t.join("missing")] {
        let r = handle(Req::Overview { repo: p.to_str().unwrap().into() });
        assert!(matches!(&r, Resp::Err(e) if !e.is_empty()), "{p:?}: {r:?}");
    }

    // never runs the repository's fsmonitor hook (Overview is a read)
    let marker = t.join("ran");
    let hook = t.join("fsmonitor.sh");
    std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
    Command::new("chmod").arg("+x").arg(&hook).status().unwrap();
    git(&d, &["config", "core.fsmonitor", hook.to_str().unwrap()]);
    overview(&d);
    assert!(!marker.exists(), "Overview ran the fsmonitor hook");
}

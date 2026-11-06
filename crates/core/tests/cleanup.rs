//! Branch cleanup assistant against real git in temp repos: which branches are offered and why (merged into the
//! default branch or HEAD, stale by committer date, upstream gone), what is never offered (current, default,
//! protected, checked out in a worktree), the bulk deletes (local undoable, remote on the bare origin), and refusals.
//! Single test: it sets process env to isolate from the user's git config.
use commitkiwi_core::handle;
use commitkiwi_protocol::*;
use std::path::Path;
use std::process::Command;

fn git_env(dir: &Path, args: &[&str], env: &[(&str, &str)]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).envs(env.iter().copied()).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}
fn git(dir: &Path, args: &[&str]) -> String {
    git_env(dir, args, &[])
}
fn commit(dir: &Path, file: &str, msg: &str, env: &[(&str, &str)]) {
    std::fs::write(dir.join(file), msg).unwrap();
    git(dir, &["add", "."]);
    git_env(dir, &["commit", "-q", "-m", msg], env);
}
fn has_ref(dir: &Path, full: &str) -> bool {
    Command::new("git").arg("-C").arg(dir).args(["show-ref", "--verify", "-q", full]).status().unwrap().success()
}
fn job(req: Req) -> Resp {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    handle(Req::Job { job: N.fetch_add(1, std::sync::atomic::Ordering::Relaxed), req: Box::new(req) })
}
fn list(repo: &str, days: u32, protected: &[&str]) -> Cleanup {
    match handle(Req::CleanupCandidates { repo: repo.into(), stale_days: days, protected: protected.iter().map(|s| s.to_string()).collect() }) {
        Resp::Cleanup(c) => c,
        other => panic!("{other:?}"),
    }
}
/// short name -> (merged, stale, gone)
fn reasons(c: &Cleanup) -> Vec<(String, (bool, bool, bool))> {
    let mut v: Vec<_> = c.branches.iter().map(|b| {
        let short = b.name.strip_prefix("refs/heads/").or_else(|| b.name.strip_prefix("refs/remotes/")).unwrap().to_string();
        (short, (b.merged, b.stale, b.gone))
    }).collect();
    v.sort();
    v
}

#[test]
fn cleanup() {
    // SAFETY: only test in this binary.
    unsafe {
        for (k, v) in [
            ("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_SYSTEM", "/dev/null"),
            ("GIT_AUTHOR_NAME", "Tester"), ("GIT_AUTHOR_EMAIL", "t@example.com"),
            ("GIT_COMMITTER_NAME", "Tester"), ("GIT_COMMITTER_EMAIL", "t@example.com"),
        ] {
            std::env::set_var(k, v);
        }
    }
    let t = tempfile::tempdir().unwrap();
    let dir = &t.path().join("r");
    let origin = &t.path().join("origin.git");
    git(t.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    git(t.path(), &["init", "-q", "-b", "main", dir.to_str().unwrap()]);
    git(dir, &["remote", "add", "origin", origin.to_str().unwrap()]);
    let repo = dir.to_str().unwrap();
    let old = [("GIT_COMMITTER_DATE", "2001-01-01T00:00:00Z"), ("GIT_AUTHOR_DATE", "2001-01-01T00:00:00Z")];

    commit(dir, "a", "base", &[]);
    // merged into main, also on origin
    git(dir, &["checkout", "-q", "-b", "done-a"]);
    commit(dir, "b", "done a", &[]);
    git(dir, &["checkout", "-q", "main"]);
    git(dir, &["merge", "-q", "--no-ff", "-m", "merge done-a", "done-a"]);
    // merged and protected; merged and checked out in another worktree
    git(dir, &["branch", "release/1.0"]);
    git(dir, &["branch", "in-tree"]);
    git(dir, &["worktree", "add", "-q", t.path().join("wt").to_str().unwrap(), "in-tree"]);
    // stale and unmerged (old committer date); recent and unmerged (never offered)
    git(dir, &["checkout", "-q", "-b", "old-wip"]);
    commit(dir, "c", "old work", &old);
    git(dir, &["checkout", "-q", "-b", "fresh", "main"]);
    commit(dir, "d", "fresh work", &[]);
    // its upstream is deleted on the remote: gone
    git(dir, &["checkout", "-q", "-b", "gone-x", "main"]);
    commit(dir, "e", "gone work", &[]);
    git(dir, &["push", "-q", "-u", "origin", "gone-x", "main", "done-a"]);
    // a stale branch that only the remote has
    git(dir, &["checkout", "-q", "-b", "remote-old", "main"]);
    commit(dir, "f", "remote old", &old);
    git(dir, &["push", "-q", "origin", "remote-old"]);
    git(dir, &["checkout", "-q", "main"]);
    git(dir, &["branch", "-q", "-D", "remote-old"]);
    git(origin, &["branch", "-q", "-D", "gone-x"]);
    git(dir, &["fetch", "-q", "--prune", "origin"]);
    git(dir, &["remote", "set-head", "origin", "main"]);
    // the current branch, with an ancestor that only HEAD has (merged into HEAD, not main)
    git(dir, &["checkout", "-q", "-b", "base-of-cur"]);
    commit(dir, "g", "base of current", &[]);
    git(dir, &["checkout", "-q", "-b", "current"]);
    commit(dir, "h", "current work", &[]);
    // merged into main after `current` branched off: git's own -d (HEAD) would refuse it
    git(dir, &["checkout", "-q", "-b", "late", "main"]);
    commit(dir, "i", "late", &[]);
    git(dir, &["checkout", "-q", "main"]);
    git(dir, &["merge", "-q", "--ff-only", "late"]);
    git(dir, &["checkout", "-q", "current"]);

    let c = list(repo, 90, &["main", "master", "develop", "trunk", "release/*"]);
    assert_eq!(c.default_branch.as_deref(), Some("main"));
    assert_eq!(reasons(&c), [
        ("base-of-cur".into(), (true, false, false)),
        ("done-a".into(), (true, false, false)),
        ("gone-x".into(), (false, false, true)),
        ("late".into(), (true, false, false)),
        ("old-wip".into(), (false, true, false)),
        ("origin/done-a".into(), (true, false, false)),
        ("origin/remote-old".into(), (false, true, false)),
    ], "never: current, main, origin/main, release/1.0 (protected), in-tree (worktree), fresh (nothing to clean)");
    let wip = c.branches.iter().find(|b| b.name == "refs/heads/old-wip").unwrap();
    assert_eq!((wip.ahead, wip.behind, wip.subject.as_str(), wip.author.as_str(), wip.time), (1, 1, "old work", "Tester", 978_307_200));
    let ro = c.branches.iter().find(|b| b.name == "refs/remotes/origin/remote-old").unwrap();
    assert_eq!((ro.remote.as_deref(), ro.ahead), (Some("origin"), 1));
    // stale off; without the protected list release/1.0 shows up
    assert!(!reasons(&list(repo, 0, &[])).iter().any(|(n, _)| n == "old-wip" || n == "origin/remote-old"));
    assert!(reasons(&list(repo, 0, &[])).iter().any(|(n, _)| n == "release/1.0"));
    assert!(matches!(handle(Req::CleanupCandidates { repo: repo.into(), stale_days: 90, protected: vec!["a\nb".into()] }), Resp::Err(_)));

    // ---- delete: a branch that is not merged in the merged list refuses the whole request
    let del = |merged: &[&str], unmerged: &[&str]| job(Req::DeleteBranches {
        repo: repo.into(), merged: merged.iter().map(|s| s.to_string()).collect(), unmerged: unmerged.iter().map(|s| s.to_string()).collect(),
    });
    assert!(matches!(del(&["done-a", "fresh"], &[]), Resp::Err(e) if e.contains("fresh is not merged")));
    assert!(has_ref(dir, "refs/heads/done-a"), "nothing was deleted");
    for bad in ["--force", "-D", "nope", "a b", "../x"] {
        assert!(matches!(del(&[bad], &[]), Resp::Err(_)), "{bad}");
        assert!(matches!(del(&[], &[bad]), Resp::Err(_)), "{bad}");
    }
    assert!(matches!(del(&["done-a"], &["done-a"]), Resp::Err(e) if e.contains("twice")));
    assert!(matches!(del(&[], &["current"]), Resp::Err(_)), "git refuses the checked-out branch");
    assert!(matches!(del(&[], &["in-tree"]), Resp::Err(_)), "git refuses a branch checked out in a worktree");

    let before: Vec<(String, String)> = ["done-a", "base-of-cur", "late", "old-wip", "gone-x"].iter().map(|b| (b.to_string(), git(dir, &["rev-parse", b]))).collect();
    let Resp::Moved(m) = del(&["done-a", "base-of-cur", "late"], &["old-wip", "gone-x"]) else { panic!() };
    assert_eq!(m.refs.len(), 5, "{m:?}");
    assert!(m.refs.iter().all(|r| r.name.starts_with("refs/heads/") && r.before.is_some() && r.after.is_none()));
    assert!(before.iter().all(|(b, _)| !has_ref(dir, &format!("refs/heads/{b}"))));
    // Undo recreates every one at its old commit
    let undo = job(Req::Undo { repo: repo.into(), moved: m, redo: false, mode: UndoMode::Keep, check: false });
    assert!(matches!(undo, Resp::Moved(_)), "{undo:?}");
    for (b, oid) in &before {
        assert_eq!(&git(dir, &["rev-parse", &format!("refs/heads/{b}")]), oid, "{b}");
    }

    // ---- remote: one push per remote; hostile or non-remote refs refused
    for bad in ["refs/heads/main", "refs/remotes/origin/--delete", "refs/remotes/origin/nope", "--all", "refs/remotes/nope/x"] {
        assert!(matches!(job(Req::DeleteRemoteBranches { repo: repo.into(), branches: vec![bad.into()] }), Resp::Err(_)), "{bad}");
    }
    let Resp::Moved(m) = job(Req::DeleteRemoteBranches { repo: repo.into(), branches: vec!["refs/remotes/origin/done-a".into(), "refs/remotes/origin/remote-old".into()] }) else { panic!() };
    assert!(!has_ref(origin, "refs/heads/done-a") && !has_ref(origin, "refs/heads/remote-old") && has_ref(origin, "refs/heads/main"));
    assert!(m.refs.iter().all(|r| r.name.starts_with("refs/remotes/origin/")), "only remote-tracking refs moved: {m:?}");
    assert!(!has_ref(dir, "refs/remotes/origin/done-a"));
}

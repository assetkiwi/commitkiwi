//! M5b: Undo/Redo of journal entries (the `Moved` record of each job) against real git in temp repos, push to a
//! branch/remote, and remote add/rename/remove/set-url. Single test: it sets process env to isolate from the
//! user's git config.
use commitkiwi_core::{REPO_CHANGED, handle};
use commitkiwi_protocol::*;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}
fn commit(dir: &Path, file: &str, text: &str, msg: &str) -> String {
    std::fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", msg]);
    git(dir, &["rev-parse", "HEAD"])
}
#[track_caller]
fn ok(r: Resp) {
    assert!(matches!(r, Resp::Done | Resp::Moved(_)), "{r:?}");
}
#[track_caller]
fn err(r: Resp) -> String {
    let Resp::Err(e) = r else { panic!("expected an error, got {r:?}") };
    e
}
static JOB: AtomicU64 = AtomicU64::new(1);
/// Run a write as a console job and return what it moved (the journal's Undo data).
#[track_caller]
fn job(req: Req) -> Moved {
    match handle(Req::Job { job: JOB.fetch_add(1, Ordering::Relaxed), req: Box::new(req) }) {
        Resp::Moved(m) => m,
        r => panic!("expected Moved, got {r:?}"),
    }
}
fn undo(repo: &str, m: &Moved, redo: bool, mode: UndoMode) -> Resp {
    handle(Req::Job { job: JOB.fetch_add(1, Ordering::Relaxed), req: Box::new(Req::Undo { repo: repo.into(), moved: m.clone(), redo, mode, check: false }) })
}
fn check(repo: &str, m: &Moved, redo: bool, mode: UndoMode) -> Resp {
    handle(Req::Undo { repo: repo.into(), moved: m.clone(), redo, mode, check: true })
}
/// HEAD (branch or "detached"), HEAD's commit, `git status --porcelain`, every ref: what an undo may change.
fn state(dir: &Path) -> (String, String, String, String) {
    let branch = Command::new("git").arg("-C").arg(dir).args(["symbolic-ref", "-q", "--short", "HEAD"]).output().unwrap();
    let branch = String::from_utf8_lossy(&branch.stdout).trim().to_string();
    (branch, git(dir, &["rev-parse", "HEAD"]), git(dir, &["status", "--porcelain"]), git(dir, &["for-each-ref", "--format=%(refname) %(objectname)"]))
}

#[test]
fn undo_redo() {
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
    let origin = t.path().join("origin.git");
    git(t.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    git(t.path(), &["init", "-q", "-b", "main", dir.to_str().unwrap()]);
    let repo = dir.to_str().unwrap().to_string();
    let r = || repo.clone();
    let c1 = commit(dir, "a.txt", "one\n", "first");
    let c2 = commit(dir, "a.txt", "two\n", "second");

    // ---- commit: undo (soft) leaves its changes staged, redo commits them again (same commit)
    std::fs::write(dir.join("a.txt"), "three\n").unwrap();
    git(dir, &["add", "."]);
    let m = job(Req::Commit { repo: r(), message: "third".into(), amend: false, signoff: false, no_verify: false });
    let c3 = git(dir, &["rev-parse", "HEAD"]);
    ok(check(&repo, &m, false, UndoMode::Soft));
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), c3, "a check changes nothing");
    ok(undo(&repo, &m, false, UndoMode::Soft));
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), c2);
    assert_eq!(git(dir, &["status", "--porcelain"]), "M  a.txt", "the undone commit's change is staged");
    err(undo(&repo, &m, false, UndoMode::Soft)); // already undone: HEAD is not where the entry left it
    ok(undo(&repo, &m, true, UndoMode::Soft));
    assert_eq!((git(dir, &["rev-parse", "HEAD"]), git(dir, &["status", "--porcelain"])), (c3.clone(), String::new()));
    git(dir, &["reset", "-q", "--hard", &c2]);

    // ---- checkout: back to the branch it left, and forward again
    git(dir, &["branch", "feature", &c1]);
    let m = job(Req::Checkout { repo: r(), name: "feature".into() });
    ok(undo(&repo, &m, false, UndoMode::Keep));
    assert_eq!((state(dir).0, std::fs::read_to_string(dir.join("a.txt")).unwrap()), ("main".into(), "two\n".into()));
    ok(undo(&repo, &m, true, UndoMode::Keep));
    assert_eq!((state(dir).0, std::fs::read_to_string(dir.join("a.txt")).unwrap()), ("feature".into(), "one\n".into()));
    git(dir, &["checkout", "-q", "main"]);

    // ---- checkout -b: back to main, and the new branch is gone; redo recreates and checks it out
    let m = job(Req::CreateBranch { repo: r(), name: "topic".into(), from: Some(c1.clone()), checkout: true });
    ok(undo(&repo, &m, false, UndoMode::Keep));
    assert_eq!(state(dir).0, "main");
    assert!(!git(dir, &["branch"]).contains("topic"));
    ok(undo(&repo, &m, true, UndoMode::Keep));
    assert_eq!((state(dir).0, state(dir).1), ("topic".into(), c1.clone()));
    git(dir, &["checkout", "-q", "main"]);
    git(dir, &["branch", "-q", "-D", "topic"]);

    // ---- merge, fast-forward and --no-ff: undo puts the branch and the working tree back
    git(dir, &["checkout", "-q", "-b", "side"]);
    let s1 = commit(dir, "s.txt", "side\n", "side work");
    git(dir, &["checkout", "-q", "main"]);
    let m = job(Req::Merge { repo: r(), rev: "refs/heads/side".into(), flags: vec![] });
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), s1, "fast-forward");
    ok(undo(&repo, &m, false, UndoMode::Keep));
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), c2);
    assert!(!dir.join("s.txt").exists() && git(dir, &["status", "--porcelain"]).is_empty());
    let before = state(dir);
    let m = job(Req::Merge { repo: r(), rev: "refs/heads/side".into(), flags: vec!["--no-ff".into()] });
    let merge = git(dir, &["rev-parse", "HEAD"]);
    ok(undo(&repo, &m, false, UndoMode::Keep));
    assert_eq!(state(dir), before);
    ok(undo(&repo, &m, true, UndoMode::Keep));
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), merge);
    git(dir, &["reset", "-q", "--hard", &c2]);

    // ---- reset --soft and --mixed come back exactly; --mixed refuses while something is staged
    let before = state(dir);
    let m = job(Req::Reset { repo: r(), rev: c1.clone(), mode: ResetMode::Soft });
    ok(undo(&repo, &m, false, UndoMode::Soft));
    assert_eq!(state(dir), before);
    let m = job(Req::Reset { repo: r(), rev: c1.clone(), mode: ResetMode::Mixed });
    assert_eq!(git(dir, &["status", "--porcelain"]), "M a.txt");
    std::fs::write(dir.join("new.txt"), "n\n").unwrap();
    git(dir, &["add", "new.txt"]);
    let e = err(check(&repo, &m, false, UndoMode::Mixed));
    assert!(e.contains("staged"), "{e}");
    git(dir, &["rm", "-q", "--cached", "new.txt"]);
    std::fs::remove_file(dir.join("new.txt")).unwrap();
    ok(undo(&repo, &m, false, UndoMode::Mixed));
    assert_eq!(state(dir), before);

    // ---- branch create/delete, tags
    let m = job(Req::CreateBranch { repo: r(), name: "x".into(), from: None, checkout: false });
    ok(undo(&repo, &m, false, UndoMode::Keep));
    assert!(!git(dir, &["branch"]).contains(" x"));
    ok(undo(&repo, &m, true, UndoMode::Keep));
    let m = job(Req::DeleteBranch { repo: r(), branch: "side".into(), force: true });
    ok(undo(&repo, &m, false, UndoMode::Keep));
    assert_eq!(git(dir, &["rev-parse", "side"]), s1, "deleted branch restored");
    let m = job(Req::CreateTag { repo: r(), name: "v1".into(), rev: c1.clone(), message: Some("rel".into()) });
    let m2 = job(Req::DeleteTag { repo: r(), name: "v1".into() });
    ok(undo(&repo, &m2, false, UndoMode::Keep));
    assert_eq!(git(dir, &["cat-file", "-t", "v1"]), "tag", "annotated tag restored");
    ok(undo(&repo, &m, false, UndoMode::Keep));
    assert!(git(dir, &["tag"]).is_empty());

    // ---- stash pop: undo puts the stash back (the working tree keeps the popped changes); undoing a stash push is refused
    std::fs::write(dir.join("a.txt"), "wip\n").unwrap();
    let push = job(Req::Stash { repo: r(), flags: vec![] });
    let stash = git(dir, &["rev-parse", "refs/stash"]);
    let e = err(check(&repo, &push, false, UndoMode::Keep));
    assert!(e.contains("drop a stash"), "{e}");
    let pop = job(Req::PopStash { repo: r() });
    assert!(git(dir, &["stash", "list"]).is_empty());
    ok(undo(&repo, &pop, false, UndoMode::Keep));
    assert_eq!(git(dir, &["rev-parse", "refs/stash"]), stash);
    assert!(git(dir, &["stash", "list"]).contains("WIP on main"), "{}", git(dir, &["stash", "list"]));
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "wip\n", "working tree untouched");
    let e = err(check(&repo, &pop, true, UndoMode::Keep));
    assert!(e.contains("drop a stash"), "redo of the pop would drop it: {e}");
    git(dir, &["checkout", "-q", "--", "a.txt"]);
    git(dir, &["stash", "drop", "-q"]);

    // ---- refusals: local changes in the way, HEAD moved elsewhere, an operation in progress, hostile records
    let m = job(Req::Merge { repo: r(), rev: "refs/heads/side".into(), flags: vec![] });
    std::fs::write(dir.join("s.txt"), "local edit\n").unwrap();
    let before = state(dir);
    let e = err(undo(&repo, &m, false, UndoMode::Keep));
    assert!(e.contains("overwrite local changes to s.txt"), "{e}");
    assert_eq!(state(dir), before, "refused: nothing changed");
    ok(check(&repo, &m, false, UndoMode::Soft)); // soft never touches files
    git(dir, &["checkout", "-q", "--", "s.txt"]);
    commit(dir, "b.txt", "b\n", "made outside the app");
    assert_eq!(err(undo(&repo, &m, false, UndoMode::Keep)), REPO_CHANGED);
    git(dir, &["reset", "-q", "--hard", &c2]);
    let m = job(Req::CreateBranch { repo: r(), name: "y".into(), from: None, checkout: false });
    git(dir, &["branch", "-f", "y", &c1]);
    assert_eq!(err(undo(&repo, &m, false, UndoMode::Keep)), REPO_CHANGED, "a ref moved outside the app");
    git(dir, &["branch", "-q", "-D", "y"]);
    let m = job(Req::CreateBranch { repo: r(), name: "z".into(), from: None, checkout: false });
    git(dir, &["checkout", "-q", "-b", "conflict", &c1]);
    commit(dir, "a.txt", "other\n", "conflicting");
    git(dir, &["checkout", "-q", "main"]);
    assert!(matches!(handle(Req::Merge { repo: r(), rev: "refs/heads/conflict".into(), flags: vec![] }), Resp::Err(_)));
    let e = err(undo(&repo, &m, false, UndoMode::Keep));
    assert!(e.contains("in progress"), "{e}");
    git(dir, &["merge", "--abort"]);
    let hostile = |name: &str, oid: &str| Moved {
        head_before: Head { branch: Some("refs/heads/main".into()), oid: Some(c2.clone()) },
        head_after: Head { branch: Some("refs/heads/main".into()), oid: Some(c2.clone()) },
        refs: vec![RefMove { name: name.into(), before: None, after: Some(oid.into()) }],
    };
    for (name, oid) in [("refs/heads/-x", c1.as_str()), ("refs/heads/a b", &c1), ("refs/heads/a..b", &c1), ("refs/heads/ok", "--all"), ("refs/heads/ok", &c1[..10])] {
        err(check(&repo, &hostile(name, oid), false, UndoMode::Keep));
    }
    let mut bad_head = hostile("refs/heads/z", &c2);
    bad_head.head_before.branch = Some("--orphan".into());
    err(check(&repo, &bad_head, false, UndoMode::Keep));
    ok(check(&repo, &hostile("refs/heads/z", &c2), false, UndoMode::Keep)); // the well-formed one is fine

    // ---- a branch checked out in another worktree is never moved
    let wt = t.path().join("wt");
    git(dir, &["worktree", "add", "-q", wt.to_str().unwrap(), "z"]);
    let e = err(check(&repo, &hostile("refs/heads/z", &c2), false, UndoMode::Keep));
    assert!(e.contains("another worktree"), "{e}");
    git(dir, &["worktree", "remove", wt.to_str().unwrap()]);

    // ---- push to a branch/remote: sets the upstream the first time; remote-only entries can't be undone
    git(dir, &["remote", "add", "origin", origin.to_str().unwrap()]);
    for (remote, branch) in [("--mirror", "main"), ("origin", "--all"), ("nope", "main")] {
        err(handle(Req::Push { repo: r(), flags: vec![], remote: Some(remote.into()), branch: Some(branch.into()) }));
    }
    err(handle(Req::Push { repo: r(), flags: vec!["--force".into(), "--force".into()], remote: None, branch: None }));
    err(handle(Req::Push { repo: r(), flags: vec![], remote: Some("origin".into()), branch: None }));
    let m = job(Req::Push { repo: r(), flags: vec![], remote: Some("origin".into()), branch: Some("main".into()) });
    assert_eq!(git(dir, &["rev-parse", "--abbrev-ref", "main@{u}"]), "origin/main");
    assert_eq!(git(&origin, &["rev-parse", "main"]), c2);
    let e = err(check(&repo, &m, false, UndoMode::Keep));
    assert!(e.contains("remote-tracking"), "{e}");
    // an upstream with another name: pushes there, not to a new same-named branch
    git(dir, &["branch", "-q", "local-name", &c1]);
    git(dir, &["push", "-q", "origin", "local-name:refs/heads/remote-name"]);
    git(dir, &["branch", "-q", "-u", "origin/remote-name", "local-name"]);
    git(dir, &["branch", "-q", "-f", "local-name", &c2]);
    job(Req::Push { repo: r(), flags: vec![], remote: Some("origin".into()), branch: Some("local-name".into()) });
    assert_eq!(git(&origin, &["rev-parse", "remote-name"]), c2);
    assert!(!git(&origin, &["branch"]).contains("local-name"));

    // ---- remotes: add, rename, set-url, remove; hostile names and URLs never reach git as options
    for (name, url) in [("-x", "/a"), ("a b", "/a"), ("", "/a"), ("bad..name", "/a"), ("ok", "--upload-pack=touch /tmp/pwn"), ("ok", "ext::sh -c touch% /tmp/pwn"), ("ok", "/a\nb"), ("ok", "")] {
        err(handle(Req::AddRemote { repo: r(), name: name.into(), url: url.into() }));
    }
    ok(handle(Req::AddRemote { repo: r(), name: "up".into(), url: origin.to_str().unwrap().into() }));
    job(Req::Fetch { repo: r(), flags: vec![], remote: None });
    git(dir, &["fetch", "-q", "up"]);
    assert!(git(dir, &["branch", "-r"]).contains("up/main"));
    err(handle(Req::RenameRemote { repo: r(), name: "up".into(), new_name: "--x".into() }));
    err(handle(Req::RenameRemote { repo: r(), name: "nope".into(), new_name: "x".into() }));
    let m = job(Req::RenameRemote { repo: r(), name: "up".into(), new_name: "upstream".into() });
    assert!(m.refs.iter().any(|x| x.name == "refs/remotes/upstream/main" && x.before.is_none()), "{m:?}");
    assert!(git(dir, &["branch", "-r"]).contains("upstream/main"));
    ok(handle(Req::SetRemoteUrl { repo: r(), name: "upstream".into(), url: "https://example.com/r.git".into() }));
    assert_eq!(git(dir, &["remote", "get-url", "upstream"]), "https://example.com/r.git");
    err(handle(Req::SetRemoteUrl { repo: r(), name: "upstream".into(), url: "-oProxyCommand=x".into() }));
    err(handle(Req::DeleteRemote { repo: r(), name: "--all".into() }));
    job(Req::DeleteRemote { repo: r(), name: "upstream".into() });
    assert_eq!(git(dir, &["remote"]), "origin");
    assert!(!std::path::Path::new("/tmp/pwn").exists());
}

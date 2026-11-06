//! M5a branch/ref operations against real git in temp repos: each operation, hostile names, conflicts with
//! continue/skip/abort, and the `Moved` record. Single test: it sets process env to isolate from the user's git config.
use commitkiwi_core::handle;
use commitkiwi_protocol::*;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}
#[track_caller]
fn ok(r: Resp) {
    assert!(matches!(r, Resp::Done), "{r:?}");
}
#[track_caller]
fn err(r: Resp) -> String {
    let Resp::Err(e) = r else { panic!("expected an error, got {r:?}") };
    e
}
fn commit(dir: &Path, file: &str, text: &str, msg: &str) -> String {
    std::fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", msg]);
    git(dir, &["rev-parse", "HEAD"])
}
fn status(repo: &str) -> Status {
    let Resp::Status(s) = handle(Req::Status { repo: repo.into() }) else { panic!() };
    s
}
fn refs(repo: &str) -> Refs {
    let Resp::Refs(r) = handle(Req::Refs { repo: repo.into() }) else { panic!() };
    r
}
fn has_ref(dir: &Path, full: &str) -> bool {
    Command::new("git").arg("-C").arg(dir).args(["show-ref", "--verify", "-q", full]).status().unwrap().success()
}

#[test]
fn branch_ops() {
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
    git(dir, &["remote", "add", "origin", origin.to_str().unwrap()]);
    let repo = dir.to_str().unwrap().to_string();
    let r = || repo.clone();
    let c1 = commit(dir, "a.txt", "one\n", "first");
    let c2 = commit(dir, "a.txt", "two\n", "second");

    // ---- hostile names never reach git as options or as two words
    for bad in ["--force", "-D", "a b", "a\tb", "x\ny", "", "a..b", "bad~1", "@", "x.lock", "HEAD", "a\u{7}b"] {
        err(handle(Req::CreateBranch { repo: r(), name: bad.into(), from: None, checkout: false }));
        err(handle(Req::CreateTag { repo: r(), name: bad.into(), rev: c2.clone(), message: None }));
    }
    for bad in ["--orphan", "-", "main", "HEAD~1", "refs/heads/nope", "refs/heads/a b", "refs/other/x", "refs/heads/", &c2[..12]] {
        err(handle(Req::CreateBranch { repo: r(), name: "ok".into(), from: Some(bad.into()), checkout: false }));
        err(handle(Req::Reset { repo: r(), rev: bad.into(), mode: ResetMode::Hard }));
        err(handle(Req::Merge { repo: r(), rev: bad.into(), flags: vec![] }));
    }
    err(handle(Req::Merge { repo: r(), rev: c1.clone(), flags: vec!["--strategy=ours".into()] }));
    err(handle(Req::DeleteBranch { repo: r(), branch: "--force".into(), force: true }));
    err(handle(Req::RenameBranch { repo: r(), branch: "main".into(), name: "-M".into() }));
    err(handle(Req::PushTag { repo: r(), remote: "--mirror".into(), name: "v1".into() }));
    err(handle(Req::DeleteRemoteBranch { repo: r(), branch: "refs/heads/main".into() }));
    err(handle(Req::SetUpstream { repo: r(), branch: "main".into(), upstream: Some("refs/heads/main".into()) }));
    assert_eq!(git(dir, &["for-each-ref", "--format=%(refname)"]), "refs/heads/main", "nothing was created");

    // ---- create (HEAD, a commit, a tag, a remote branch), with and without checkout; Moved records it
    let Resp::Moved(m) = handle(Req::Job { job: 1, req: Box::new(Req::CreateBranch { repo: r(), name: "feature/x".into(), from: None, checkout: false }) }) else { panic!() };
    assert_eq!(m.refs, [RefMove { name: "refs/heads/feature/x".into(), before: None, after: Some(c2.clone()) }]);
    assert_eq!(m.head_after.branch.as_deref(), Some("refs/heads/main"));
    ok(handle(Req::CreateBranch { repo: r(), name: "old".into(), from: Some(c1.clone()), checkout: true }));
    assert_eq!(git(dir, &["symbolic-ref", "--short", "HEAD"]), "old");
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), c1);
    git(dir, &["checkout", "-q", "main"]);
    ok(handle(Req::CreateTag { repo: r(), name: "v1".into(), rev: c1.clone(), message: None }));
    ok(handle(Req::CreateTag { repo: r(), name: "v2".into(), rev: "refs/heads/main".into(), message: Some("Release 2\n\nnotes".into()) }));
    assert_eq!(git(dir, &["cat-file", "-t", "v2"]), "tag", "annotated");
    assert_eq!(git(dir, &["cat-file", "-t", "v1"]), "commit", "lightweight");
    err(handle(Req::CreateTag { repo: r(), name: "v3".into(), rev: c1.clone(), message: Some("  ".into()) }));
    ok(handle(Req::CreateBranch { repo: r(), name: "from-tag".into(), from: Some("refs/tags/v2".into()), checkout: false }));
    assert_eq!(git(dir, &["rev-parse", "from-tag"]), c2);
    err(handle(Req::CreateBranch { repo: r(), name: "main".into(), from: None, checkout: false })); // exists

    // ---- push a branch and tags, then the remote side: upstream, delete remote tag/branch
    git(dir, &["push", "-q", "origin", "main", "feature/x"]);
    git(dir, &["fetch", "-q", "origin"]);
    ok(handle(Req::PushTag { repo: r(), remote: "origin".into(), name: "v1".into() }));
    assert!(git(&origin, &["tag"]).contains("v1"));
    err(handle(Req::PushTag { repo: r(), remote: "origin".into(), name: "nope".into() }));
    ok(handle(Req::DeleteRemoteTag { repo: r(), remote: "origin".into(), name: "v1".into() }));
    assert!(!git(&origin, &["tag"]).contains("v1"));
    ok(handle(Req::SetUpstream { repo: r(), branch: "main".into(), upstream: Some("refs/remotes/origin/main".into()) }));
    let rf = refs(&repo);
    assert_eq!(rf.remotes, ["origin"]);
    let main = rf.refs.iter().find(|x| x.name == "main").unwrap();
    assert_eq!(main.upstream.as_deref(), Some("origin/main"));
    ok(handle(Req::SetUpstream { repo: r(), branch: "main".into(), upstream: None }));
    assert_eq!(refs(&repo).refs.iter().find(|x| x.name == "main").unwrap().upstream, None);
    ok(handle(Req::CreateBranch { repo: r(), name: "tracking".into(), from: Some("refs/remotes/origin/feature/x".into()), checkout: false }));
    assert_eq!(git(dir, &["rev-parse", "--abbrev-ref", "tracking@{u}"]), "origin/feature/x", "a remote start point tracks it");
    let Resp::Moved(m) = handle(Req::Job { job: 2, req: Box::new(Req::DeleteRemoteBranch { repo: r(), branch: "refs/remotes/origin/feature/x".into() }) }) else { panic!() };
    assert!(m.refs.iter().any(|x| x.name == "refs/remotes/origin/feature/x" && x.after.is_none()), "{m:?}");
    assert!(!git(&origin, &["branch"]).contains("feature/x"));

    // ---- rename, delete (unmerged needs force), tags
    ok(handle(Req::RenameBranch { repo: r(), branch: "feature/x".into(), name: "feature/y".into() }));
    assert!(has_ref(dir, "refs/heads/feature/y") && !has_ref(dir, "refs/heads/feature/x"));
    err(handle(Req::RenameBranch { repo: r(), branch: "nope".into(), name: "z".into() }));
    git(dir, &["checkout", "-q", "-b", "side"]);
    commit(dir, "s.txt", "s\n", "side work");
    git(dir, &["checkout", "-q", "main"]);
    let e = err(handle(Req::DeleteBranch { repo: r(), branch: "side".into(), force: false }));
    assert!(e.contains("not fully merged"), "{e}");
    ok(handle(Req::DeleteBranch { repo: r(), branch: "side".into(), force: true }));
    assert!(!has_ref(dir, "refs/heads/side"));
    err(handle(Req::DeleteBranch { repo: r(), branch: "main".into(), force: true })); // checked out
    ok(handle(Req::DeleteTag { repo: r(), name: "v1".into() }));
    err(handle(Req::DeleteTag { repo: r(), name: "v1".into() }));

    // ---- merge with flags; a conflict leaves a merge in progress, abort it via Sequence
    git(dir, &["checkout", "-q", "-b", "topic"]);
    let topic = commit(dir, "t.txt", "t\n", "topic work");
    git(dir, &["checkout", "-q", "main"]);
    ok(handle(Req::Merge { repo: r(), rev: "refs/heads/topic".into(), flags: vec!["--no-ff".into()] }));
    assert_eq!(git(dir, &["rev-list", "--parents", "-n1", "HEAD"]).split(' ').count(), 3, "--no-ff made a merge commit");
    git(dir, &["reset", "-q", "--hard", &c2]);
    ok(handle(Req::Merge { repo: r(), rev: topic.clone(), flags: vec!["--squash".into()] }));
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), c2, "--squash does not commit");
    git(dir, &["reset", "-q", "--hard", &c2]);
    git(dir, &["checkout", "-q", "-b", "clash", &c1]);
    let clash = commit(dir, "a.txt", "clash\n", "clash");
    git(dir, &["checkout", "-q", "main"]);
    err(handle(Req::Merge { repo: r(), rev: "refs/heads/clash".into(), flags: vec!["--ff-only".into()] }));
    err(handle(Req::Merge { repo: r(), rev: "refs/heads/clash".into(), flags: vec![] }));
    let st = status(&repo);
    assert!(st.merge.is_some() && st.op.is_none());
    assert!(st.files.iter().any(|f| f.kind == WorkKind::Conflicted));
    err(handle(Req::Sequence { repo: r(), action: SeqAction::Skip }));
    ok(handle(Req::Sequence { repo: r(), action: SeqAction::Abort }));
    assert!(status(&repo).merge.is_none());
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), c2);
    err(handle(Req::Sequence { repo: r(), action: SeqAction::Continue })); // nothing in progress

    // ---- rebase: conflict -> op "rebase"; resolve + continue; and abort restores the branch
    git(dir, &["checkout", "-q", "clash"]);
    let e = err(handle(Req::Rebase { repo: r(), onto: "refs/heads/main".into() }));
    assert!(e.to_lowercase().contains("conflict"), "{e}");
    assert_eq!(status(&repo).op.as_deref(), Some("rebase"));
    ok(handle(Req::Sequence { repo: r(), action: SeqAction::Abort }));
    assert_eq!(status(&repo).op, None);
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), clash);
    assert_eq!(git(dir, &["symbolic-ref", "--short", "HEAD"]), "clash");
    err(handle(Req::Rebase { repo: r(), onto: "refs/heads/main".into() }));
    std::fs::write(dir.join("a.txt"), "resolved\n").unwrap();
    git(dir, &["add", "a.txt"]);
    ok(handle(Req::Sequence { repo: r(), action: SeqAction::Continue }));
    assert_eq!(status(&repo).op, None);
    assert_eq!(git(dir, &["rev-parse", "HEAD~1"]), c2, "clash now sits on main");
    assert_eq!(git(dir, &["log", "-1", "--format=%s"]), "clash");
    // skip drops the conflicting commit
    git(dir, &["reset", "-q", "--hard", &clash]);
    err(handle(Req::Rebase { repo: r(), onto: "refs/heads/main".into() }));
    ok(handle(Req::Sequence { repo: r(), action: SeqAction::Skip }));
    assert_eq!(status(&repo).op, None);
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), c2);

    // ---- cherry-pick and revert, with conflicts and continue/abort
    git(dir, &["checkout", "-q", "main"]);
    ok(handle(Req::CherryPick { repo: r(), rev: topic.clone() }));
    assert_eq!(git(dir, &["log", "-1", "--format=%s"]), "topic work");
    let picked = git(dir, &["rev-parse", "HEAD"]);
    err(handle(Req::CherryPick { repo: r(), rev: clash.clone() }));
    assert_eq!(status(&repo).op.as_deref(), Some("cherry-pick"));
    ok(handle(Req::Sequence { repo: r(), action: SeqAction::Abort }));
    assert_eq!((status(&repo).op, git(dir, &["rev-parse", "HEAD"])), (None, picked.clone()));
    ok(handle(Req::Revert { repo: r(), rev: picked.clone() }));
    assert!(git(dir, &["log", "-1", "--format=%s"]).starts_with("Revert"));
    assert!(!dir.join("t.txt").exists());
    let reverted = git(dir, &["rev-parse", "HEAD"]);
    commit(dir, "a.txt", "three\n", "third");
    err(handle(Req::Revert { repo: r(), rev: c2.clone() })); // "two" -> "one" clashes with "three"
    assert_eq!(status(&repo).op.as_deref(), Some("revert"));
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    git(dir, &["add", "a.txt"]);
    ok(handle(Req::Sequence { repo: r(), action: SeqAction::Continue }));
    assert_eq!(status(&repo).op, None);
    assert!(git(dir, &["log", "-1", "--format=%s"]).starts_with("Revert"));

    // ---- reset soft/mixed/hard; CountRange shows what a reset drops
    let head = git(dir, &["rev-parse", "HEAD"]);
    let Resp::Count(n) = handle(Req::CountRange { repo: r(), base: reverted.clone(), tip: head.clone() }) else { panic!() };
    assert_eq!(n, 2);
    err(handle(Req::CountRange { repo: r(), base: "--all".into(), tip: head.clone() }));
    ok(handle(Req::Reset { repo: r(), rev: reverted.clone(), mode: ResetMode::Soft }));
    assert!(status(&repo).files.iter().any(|f| f.path == "a.txt" && f.index == 'M'), "soft keeps the change staged");
    ok(handle(Req::Reset { repo: r(), rev: reverted.clone(), mode: ResetMode::Mixed }));
    assert!(status(&repo).files.iter().any(|f| f.path == "a.txt" && f.index == '.' && f.worktree == 'M'), "mixed unstages it");
    let Resp::Moved(m) = handle(Req::Job { job: 3, req: Box::new(Req::Reset { repo: r(), rev: c1.clone(), mode: ResetMode::Hard }) }) else { panic!() };
    assert_eq!((m.head_before.oid.as_deref(), m.head_after.oid.as_deref()), (Some(reverted.as_str()), Some(c1.as_str())));
    assert!(status(&repo).files.is_empty(), "hard drops the working copy changes");
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
}

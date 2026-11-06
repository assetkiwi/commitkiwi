//! F8 (context menu) requests against real git in temp repos: stash apply/pop/drop by entry (and the stale-entry
//! refusal), clear, remote URL, fetch from one remote, reset --keep, cherry-pick/revert of a commit's file patch into
//! the worktree, single-submodule update/sync, and `branch:` search. Single test: it sets process env to isolate
//! from the user's git config.
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
fn stashes(repo: &str) -> Vec<Stash> {
    let Resp::Refs(r) = handle(Req::Refs { repo: repo.into() }) else { panic!() };
    r.stashes
}
fn read(dir: &Path, f: &str) -> String {
    std::fs::read_to_string(dir.join(f)).unwrap()
}

#[test]
fn context_ops() {
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
    let c1 = commit(dir, "a.txt", "one\ntwo\nthree\n", "first");

    // ---- stashes: two entries; act on the older one by name + id
    std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\nold stash\n").unwrap();
    git(dir, &["stash", "push", "-q", "-m", "older"]);
    std::fs::write(dir.join("b.txt"), "b\n").unwrap();
    git(dir, &["add", "b.txt"]);
    git(dir, &["stash", "push", "-q", "-m", "newer"]);
    let s = stashes(&r());
    assert_eq!(s.len(), 2);
    let (newer, older) = (s[0].clone(), s[1].clone());
    assert_eq!(older.name, "stash@{1}");
    // the id must still match the name (the list may have shifted)
    let e = err(handle(Req::StashOp { repo: r(), stash: "stash@{1}".into(), oid: newer.oid.clone(), action: StashAction::Drop }));
    assert!(e.contains("different stash"), "{e}");
    for bad in ["--all", "stash@{-1}", "stash@{0} x", "HEAD", "stash@{}", "stash@{1"] {
        err(handle(Req::StashOp { repo: r(), stash: bad.into(), oid: older.oid.clone(), action: StashAction::Apply }));
    }
    err(handle(Req::StashOp { repo: r(), stash: "stash@{1}".into(), oid: "--x".into(), action: StashAction::Apply }));
    err(handle(Req::StashOp { repo: r(), stash: "stash@{7}".into(), oid: older.oid.clone(), action: StashAction::Apply }));
    // apply the older: its change appears, both stashes stay
    ok(handle(Req::StashOp { repo: r(), stash: older.name.clone(), oid: older.oid.clone(), action: StashAction::Apply }));
    assert!(read(dir, "a.txt").contains("old stash"));
    assert_eq!(stashes(&r()).len(), 2);
    git(dir, &["checkout", "--", "a.txt"]);
    // drop the older one: only the newer is left
    ok(handle(Req::StashOp { repo: r(), stash: older.name.clone(), oid: older.oid.clone(), action: StashAction::Drop }));
    let s = stashes(&r());
    assert_eq!(s.iter().map(|x| x.oid.as_str()).collect::<Vec<_>>(), [newer.oid.as_str()]);
    // pop it (now stash@{0}): b.txt comes back
    ok(handle(Req::StashOp { repo: r(), stash: "stash@{0}".into(), oid: newer.oid.clone(), action: StashAction::Pop }));
    assert!(dir.join("b.txt").exists());
    assert!(stashes(&r()).is_empty());
    git(dir, &["stash", "push", "-q", "-m", "again"]);
    ok(handle(Req::ClearStashes { repo: r() }));
    assert!(stashes(&r()).is_empty());

    // ---- remote URL; fetch from a named remote, an unknown one is refused
    let Resp::Text(url) = handle(Req::RemoteUrl { repo: r(), name: "origin".into() }) else { panic!() };
    assert_eq!(url, origin.to_str().unwrap());
    err(handle(Req::RemoteUrl { repo: r(), name: "--upload-pack=x".into() }));
    git(dir, &["push", "-q", "origin", "main"]);
    ok(handle(Req::Fetch { repo: r(), flags: vec!["--prune".into()], remote: Some("origin".into()) }));
    err(handle(Req::Fetch { repo: r(), flags: vec![], remote: Some("nope".into()) }));
    err(handle(Req::Fetch { repo: r(), flags: vec![], remote: Some("--upload-pack=touch x".into()) }));

    // ---- reset --keep: moves the branch, refuses when a local change would be lost
    let c2 = commit(dir, "a.txt", "one\ntwo\nthree\nfour\n", "second");
    ok(handle(Req::Reset { repo: r(), rev: c1.clone(), mode: ResetMode::Keep }));
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), c1);
    git(dir, &["reset", "-q", "--hard", &c2]);
    std::fs::write(dir.join("a.txt"), "local edit\n").unwrap();
    err(handle(Req::Reset { repo: r(), rev: c1.clone(), mode: ResetMode::Keep }));
    assert_eq!(read(dir, "a.txt"), "local edit\n", "--keep never overwrites");
    git(dir, &["checkout", "--", "a.txt"]);

    // ---- a commit's file patch: forward into the worktree (cherry-pick file), reverse (revert file)
    let Resp::Diff(p) = handle(Req::Diff { repo: r(), oid: c2.clone(), path: "a.txt".into(), old_path: None, context: 3, ignore_ws: false, from: None })
    else { panic!() };
    ok(handle(Req::Apply { repo: r(), patch: p.text.clone(), mode: ApplyMode::Discard }));
    assert_eq!(read(dir, "a.txt"), "one\ntwo\nthree\n", "reverted in the worktree");
    assert_eq!(git(dir, &["diff", "--cached", "--name-only"]), "", "the index is untouched");
    ok(handle(Req::Apply { repo: r(), patch: p.text.clone(), mode: ApplyMode::Worktree }));
    assert_eq!(read(dir, "a.txt"), "one\ntwo\nthree\nfour\n", "applied again");
    err(handle(Req::Apply { repo: r(), patch: p.text, mode: ApplyMode::Worktree })); // already there: does not apply

    // ---- submodules: one listed path, anything else refused
    let sub_src = t.path().join("sub");
    git(t.path(), &["init", "-q", "-b", "main", sub_src.to_str().unwrap()]);
    commit(&sub_src, "s.txt", "s\n", "sub");
    git(dir, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub_src.to_str().unwrap(), "libs/sub"]);
    git(dir, &["commit", "-q", "-m", "add sub"]);
    ok(handle(Req::UpdateSubmodules { repo: r(), init: true, path: Some("libs/sub".into()) }));
    ok(handle(Req::SyncSubmodules { repo: r(), path: Some("libs/sub".into()) }));
    for bad in ["libs", "a.txt", "--init", "libs/sub/.."] {
        err(handle(Req::UpdateSubmodules { repo: r(), init: false, path: Some(bad.into()) }));
        err(handle(Req::SyncSubmodules { repo: r(), path: Some(bad.into()) }));
    }

    // ---- branch: only commits reachable from that branch (rows in the full list's order)
    git(dir, &["checkout", "-q", "-b", "side", &c1]);
    let side = commit(dir, "s.txt", "side\n", "side only");
    git(dir, &["checkout", "-q", "main"]);
    let search = |branch: &str, text: &str| handle(Req::Search {
        repo: r(),
        query: SearchQuery { branch: vec![branch.into()], text: if text.is_empty() { vec![] } else { vec![text.into()] }, ..Default::default() },
        hidden: vec![],
        limit: 100,
    });
    let order = git(dir, &["rev-list", "--topo-order", "--exclude=refs/stash", "--glob=refs/*", "HEAD"]);
    let row = |oid: &str| order.lines().position(|l| l == oid).unwrap() as u32;
    let Resp::Search(found) = search("side", "") else { panic!() };
    let mut want = vec![row(&side), row(&c1)];
    want.sort();
    assert_eq!(found.rows, want);
    let Resp::Search(found) = search("main", "side") else { panic!() };
    assert!(found.rows.is_empty(), "side's commit is not on main");
    let Resp::Search(found) = search("origin/main", "first") else { panic!() };
    assert_eq!(found.rows, vec![row(&c1)]);
    err(search("nope", ""));
    err(search("--all", ""));
    err(handle(Req::Search { repo: r(), query: SearchQuery { branch: vec!["main".into(), "side".into()], ..Default::default() }, hidden: vec![], limit: 10 }));
}

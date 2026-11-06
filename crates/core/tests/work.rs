//! Working-copy operations against real git. Single test: it sets process env to isolate from the user's git config.
use commitkiwi_core::handle;
use commitkiwi_protocol::*;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn call(req: Req) -> Resp {
    handle(req)
}

fn status(repo: &str) -> Vec<(String, char, char, WorkKind)> {
    let Resp::Status(s) = call(Req::Status { repo: repo.into() }) else { panic!() };
    s.files.into_iter().map(|f| (f.path, f.index, f.worktree, f.kind)).collect()
}
fn find(st: &[(String, char, char, WorkKind)], p: &str) -> Option<(char, char, WorkKind)> {
    st.iter().find(|f| f.0 == p).map(|f| (f.1, f.2, f.3))
}
fn diff(repo: &str, path: &str, staged: bool, untracked: bool) -> String {
    let Resp::Diff(p) = call(Req::WorkDiff { repo: repo.into(), path: path.into(), old_path: None, staged, untracked, conflicted: false, context: 3, ignore_ws: false }) else { panic!() };
    p.text
}
fn ok(r: Resp) {
    assert!(matches!(r, Resp::Done), "{r:?}");
}

#[test]
fn working_copy() {
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
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path().join("repo");
    std::fs::create_dir(&d).unwrap();
    let repo = d.to_str().unwrap();
    git(&d, &["init", "-q", "-b", "main"]);
    let write = |name: &str, text: &str| std::fs::write(d.join(name), text).unwrap();
    let read = |name: &str| std::fs::read_to_string(d.join(name)).unwrap();

    // identity comes from git's own resolution
    assert!(matches!(call(Req::Identity { repo: repo.into() }), Resp::Identity(i) if i == "Tester <t@example.com>"));

    // ---- no commits yet: stage then unstage must work without a HEAD
    write("first.txt", "hello\n");
    assert_eq!(find(&status(repo), "first.txt"), Some(('.', '?', WorkKind::Untracked)));
    ok(call(Req::Stage { repo: repo.into(), paths: vec!["first.txt".into()] }));
    assert_eq!(find(&status(repo), "first.txt"), Some(('A', '.', WorkKind::Changed)));
    ok(call(Req::Unstage { repo: repo.into(), paths: vec!["first.txt".into()] }));
    assert_eq!(find(&status(repo), "first.txt"), Some(('.', '?', WorkKind::Untracked)));

    // ---- commit rules
    assert!(matches!(call(Req::Commit { repo: repo.into(), message: "  \n".into(), amend: false, signoff: false, no_verify: false }), Resp::Err(m) if m.contains("empty")));
    assert!(matches!(call(Req::Commit { repo: repo.into(), message: "nothing staged".into(), amend: false, signoff: false, no_verify: false }), Resp::Err(_)));
    write("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n");
    ok(call(Req::Stage { repo: repo.into(), paths: vec!["a.txt".into()] }));
    ok(call(Req::Commit { repo: repo.into(), message: "seed".into(), amend: false, signoff: false, no_verify: false }));
    assert_eq!(git(&d, &["log", "-1", "--format=%s"]).trim(), "seed");

    // ---- modify, add, glob-looking names
    write("a.txt", "1\nTWO\n3\n4\n5\n6\nSEVEN\n8\n");
    write("weird[1].txt", "w\n");
    write("weird1.txt", "decoy\n");
    write("sp ace.txt", "s\n");
    let st = status(repo);
    assert_eq!(find(&st, "a.txt"), Some(('.', 'M', WorkKind::Changed)));
    assert_eq!(find(&st, "sp ace.txt").map(|f| f.1), Some('?'));

    // literal pathspecs: staging `weird[1].txt` must NOT also stage `weird1.txt`
    ok(call(Req::Stage { repo: repo.into(), paths: vec!["weird[1].txt".into()] }));
    let st = status(repo);
    assert_eq!(find(&st, "weird[1].txt").map(|f| f.0), Some('A'));
    assert_eq!(find(&st, "weird1.txt").map(|f| f.1), Some('?'));
    assert!(diff(repo, "weird[1].txt", true, false).contains("+w"));

    // untracked diff via --no-index
    let u = diff(repo, "sp ace.txt", false, true);
    assert!(u.contains("new file mode") && u.contains("+s"), "{u}");

    // ---- patch modes with whole-file patches (partial-line patches are covered by the UI's tests)
    let unstaged = diff(repo, "a.txt", false, false);
    assert!(unstaged.contains("-2") && unstaged.contains("+TWO"));
    ok(call(Req::Apply { repo: repo.into(), patch: unstaged.clone(), mode: ApplyMode::Stage }));
    assert_eq!(find(&status(repo), "a.txt"), Some(('M', '.', WorkKind::Changed)));
    let staged = diff(repo, "a.txt", true, false);
    ok(call(Req::Apply { repo: repo.into(), patch: staged, mode: ApplyMode::Unstage }));
    assert_eq!(find(&status(repo), "a.txt"), Some(('.', 'M', WorkKind::Changed)));
    ok(call(Req::Apply { repo: repo.into(), patch: unstaged, mode: ApplyMode::Discard }));
    assert_eq!(read("a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n");
    assert!(find(&status(repo), "a.txt").is_none(), "clean again");
    // the diff options of the Working Directory: a whitespace-ignoring diff hides the trailing-space edit (the UI
    // then offers no line staging: git apply cannot match such context); zero context stages (needs --unidiff-zero)
    write("a.txt", "1\n2\n3\n4\n5\n6\n7\n8 \nEND\n");
    let Resp::Diff(w) = call(Req::WorkDiff { repo: repo.into(), path: "a.txt".into(), old_path: None, staged: false, untracked: false, conflicted: false, context: 3, ignore_ws: true }) else { panic!() };
    assert!(w.text.contains("+END") && !w.text.contains("-8"), "{}", w.text);
    let Resp::Diff(z) = call(Req::WorkDiff { repo: repo.into(), path: "a.txt".into(), old_path: None, staged: false, untracked: false, conflicted: false, context: 0, ignore_ws: false }) else { panic!() };
    assert!(z.text.contains("+END") && !z.text.lines().any(|l| l.starts_with(' ')), "{}", z.text);
    ok(call(Req::Apply { repo: repo.into(), patch: z.text, mode: ApplyMode::Stage }));
    assert!(diff(repo, "a.txt", true, false).contains("+END"));
    git(&d, &["reset", "-q", "--", "a.txt"]);
    git(&d, &["checkout", "--", "a.txt"]);
    // a patch that does not apply is an error, not a silent no-op
    assert!(matches!(call(Req::Apply { repo: repo.into(), patch: "garbage".into(), mode: ApplyMode::Stage }), Resp::Err(_)));

    // ---- discard: tracked is restored, untracked is deleted, glob names are literal
    write("a.txt", "changed\n");
    write("junk.txt", "x\n");
    write("junk1.txt", "keep me\n");
    ok(call(Req::Discard { repo: repo.into(), paths: vec!["a.txt".into(), "junk.txt".into()] }));
    assert_eq!(read("a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n");
    assert!(!d.join("junk.txt").exists() && d.join("junk1.txt").exists());
    ok(call(Req::Discard { repo: repo.into(), paths: vec!["junk1.txt".into()] }));

    // ---- commit with sign-off, then amend
    write("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n");
    ok(call(Req::Stage { repo: repo.into(), paths: vec!["a.txt".into(), "weird[1].txt".into()] }));
    ok(call(Req::Commit { repo: repo.into(), message: "second\n\nthe body".into(), amend: false, signoff: true, no_verify: false }));
    let full = git(&d, &["log", "-1", "--format=%B"]);
    assert!(full.starts_with("second\n\nthe body") && full.contains("Signed-off-by: Tester <t@example.com>"), "{full}");
    assert_eq!(git(&d, &["rev-list", "--count", "HEAD"]).trim(), "2");
    ok(call(Req::Commit { repo: repo.into(), message: "second, reworded".into(), amend: true, signoff: false, no_verify: false }));
    assert_eq!(git(&d, &["rev-list", "--count", "HEAD"]).trim(), "2"); // amended, not added
    assert_eq!(git(&d, &["log", "-1", "--format=%s"]).trim(), "second, reworded");

    // ---- ignore: appended once, escaped, effective
    write("build.log", "l\n");
    ok(call(Req::Ignore { repo: repo.into(), path: "build.log".into() }));
    ok(call(Req::Ignore { repo: repo.into(), path: "build.log".into() })); // idempotent
    ok(call(Req::Ignore { repo: repo.into(), path: "weird2[x].txt".into() }));
    let gi = read(".gitignore");
    assert_eq!(gi.lines().filter(|l| *l == "/build.log").count(), 1, "{gi}");
    assert!(gi.contains("/weird2\\[x\\].txt"), "{gi}");
    assert!(find(&status(repo), "build.log").is_none());
    write("weird2[x].txt", "i\n");
    assert!(find(&status(repo), "weird2[x].txt").is_none(), "escaped entry matches the literal file");
    assert!(matches!(call(Req::Ignore { repo: repo.into(), path: "a\nb".into() }), Resp::Err(_)));

    // ---- stash push (allowlisted flags) and pop
    write("a.txt", "stashed\n");
    assert!(matches!(call(Req::Stash { repo: repo.into(), flags: vec!["--exec=x".into()] }), Resp::Err(m) if m.contains("unsupported flag")));
    ok(call(Req::Stash { repo: repo.into(), flags: vec!["--include-untracked".into()] }));
    assert!(find(&status(repo), "a.txt").is_none());
    let Resp::Refs(r) = call(Req::Refs { repo: repo.into() }) else { panic!() };
    assert_eq!(r.stashes[0].oid, git(&d, &["rev-parse", "stash@{0}"]).trim(), "stash rows carry their commit (the stash view)");
    let Resp::Show(sd) = call(Req::Show { repo: repo.into(), oid: r.stashes[0].oid.clone(), from: None }) else { panic!() };
    assert_eq!(sd.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["a.txt"]);
    assert_eq!((sd.tree.len(), sd.committer.as_str()), (40, "Tester"));
    assert!(sd.commit_time > 0);
    ok(call(Req::PopStash { repo: repo.into() }));
    assert_eq!(read("a.txt"), "stashed\n");
    git(&d, &["checkout", "-q", "--", "a.txt"]);

    // ---- checkout by name; option-looking names are refused
    git(&d, &["branch", "side"]);
    ok(call(Req::Checkout { repo: repo.into(), name: "side".into() }));
    assert_eq!(git(&d, &["branch", "--show-current"]).trim(), "side");
    assert!(matches!(call(Req::Checkout { repo: repo.into(), name: "--orphan".into() }), Resp::Err(_)));
    ok(call(Req::Checkout { repo: repo.into(), name: "main".into() }));

    // ---- push, fetch and pull against a local bare remote
    let bare = tmp.path().join("remote.git");
    git(tmp.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
    git(&d, &["remote", "add", "origin", bare.to_str().unwrap()]);
    git(&d, &["push", "-q", "-u", "origin", "main"]);
    git(&d, &["commit", "-q", "--allow-empty", "-m", "to push"]);
    assert!(matches!(call(Req::Push { repo: repo.into(), flags: vec!["--mirror".into()], remote: None, branch: None }), Resp::Err(_)));
    ok(call(Req::Push { repo: repo.into(), flags: vec!["--no-verify".into()], remote: None, branch: None }));
    assert_eq!(git(&bare, &["log", "-1", "--format=%s", "main"]).trim(), "to push");
    ok(call(Req::Fetch { repo: repo.into(), flags: vec!["--prune".into()], remote: None }));
    ok(call(Req::Pull { repo: repo.into(), flags: vec!["--ff-only".into()] }));

    // ---- conflicts show up as such
    git(&d, &["add", ".gitignore"]);
    git(&d, &["commit", "-q", "-m", "ignore"]);
    git(&d, &["checkout", "-q", "-b", "other"]);
    write("a.txt", "other side\n");
    git(&d, &["commit", "-q", "-am", "other"]);
    git(&d, &["checkout", "-q", "main"]);
    write("a.txt", "main side\n");
    git(&d, &["commit", "-q", "-am", "main"]);
    let merge = Command::new("git").arg("-C").arg(&d).args(["merge", "other"]).output().unwrap();
    assert!(!merge.status.success());
    assert_eq!(find(&status(repo), "a.txt"), Some(('U', 'U', WorkKind::Conflicted)));

    // ---- merge in progress: prepared message, plain diff against HEAD, resolve with one side, abort
    let merge_msg = |repo: &str| {
        let Resp::Status(s) = call(Req::Status { repo: repo.into() }) else { panic!() };
        s.merge
    };
    assert!(merge_msg(repo).is_some_and(|m| m.starts_with("Merge branch 'other'") && m.contains("a.txt")), "{:?}", merge_msg(repo));
    let Resp::Diff(p) = call(Req::WorkDiff { repo: repo.into(), path: "a.txt".into(), old_path: None, staged: false, untracked: false, conflicted: true, context: 3, ignore_ws: false }) else { panic!() };
    assert!(p.text.starts_with("diff --git") && p.text.contains("+<<<<<<< HEAD") && p.text.contains("+other side"), "{}", p.text);
    ok(call(Req::Resolve { repo: repo.into(), path: "a.txt".into(), theirs: true }));
    assert_eq!(read("a.txt"), "other side\n");
    assert_eq!(find(&status(repo), "a.txt").map(|f| f.2), Some(WorkKind::Changed), "resolved and staged");
    ok(call(Req::AbortMerge { repo: repo.into() }));
    assert_eq!(merge_msg(repo), None);
    assert_eq!(read("a.txt"), "main side\n");

    // ---- ReadFile: HEAD, index and worktree versions of one file; paths stay inside the repo
    write("rf.txt", "head\n");
    ok(call(Req::Stage { repo: repo.into(), paths: vec!["rf.txt".into()] }));
    ok(call(Req::Commit { repo: repo.into(), message: "rf".into(), amend: false, signoff: false, no_verify: false }));
    write("rf.txt", "index\n");
    ok(call(Req::Stage { repo: repo.into(), paths: vec!["rf.txt".into()] }));
    write("rf.txt", "worktree\n");
    let rf = |rev: &str, path: &str| match call(Req::ReadFile { repo: repo.into(), rev: rev.into(), path: path.into() }) {
        Resp::Blob(b) => Ok(b.text.unwrap_or_default()),
        Resp::Err(e) => Err(e),
        other => panic!("{other:?}"),
    };
    assert_eq!(rf("HEAD", "rf.txt").unwrap(), "head\n");
    assert_eq!(rf("index", "rf.txt").unwrap(), "index\n");
    assert_eq!(rf("worktree", "rf.txt").unwrap(), "worktree\n");
    for evil in ["../x", "/etc/passwd", "", "a/../../x"] {
        assert!(rf("worktree", evil).is_err(), "{evil}");
    }
    assert!(rf("worktree", "missing.txt").is_err());

    // ---- commit hooks: a failing pre-commit blocks the commit unless --no-verify
    let hook = d.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    write("a.txt", "hooked\n");
    ok(call(Req::Stage { repo: repo.into(), paths: vec!["a.txt".into()] }));
    assert!(matches!(call(Req::Commit { repo: repo.into(), message: "blocked".into(), amend: false, signoff: false, no_verify: false }), Resp::Err(_)));
    ok(call(Req::Commit { repo: repo.into(), message: "unhooked".into(), amend: false, signoff: false, no_verify: true }));
    assert_eq!(git(&d, &["log", "-1", "--format=%s"]).trim(), "unhooked");

    // ---- no identity configured: empty (git must not guess one); set it in the global config
    let global = tmp.path().join("gitconfig");
    // SAFETY: only test in this binary.
    unsafe {
        std::env::remove_var("GIT_AUTHOR_NAME");
        std::env::remove_var("GIT_AUTHOR_EMAIL");
        std::env::set_var("GIT_CONFIG_GLOBAL", &global);
    }
    assert!(matches!(call(Req::Identity { repo: repo.into() }), Resp::Identity(i) if i.is_empty()));
    assert!(matches!(call(Req::SetIdentity { repo: repo.into(), name: "x".into(), email: "a\nb".into() }), Resp::Err(_)));
    ok(call(Req::SetIdentity { repo: repo.into(), name: " New Name ".into(), email: "new@example.com".into() }));
    assert!(matches!(call(Req::Identity { repo: repo.into() }), Resp::Identity(i) if i == "New Name <new@example.com>"));
    assert!(std::fs::read_to_string(&global).unwrap().contains("new@example.com"));
}

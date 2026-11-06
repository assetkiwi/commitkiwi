//! Interactive rebase (`RebasePlan` + `InteractiveRebase`) against real git in temp repos. Every test calls `init`
//! first: it sets process env (once) to isolate from the user's git config.
use commitkiwi_core::{PUBLISHED, handle};
use commitkiwi_protocol::*;
use std::path::Path;
use std::process::Command;
use std::sync::Once;
use std::sync::atomic::{AtomicU64, Ordering};
use TodoAction::*;

fn init() {
    static ONCE: Once = Once::new();
    // SAFETY: set once, before any test of this binary runs git (Once blocks the others until done).
    ONCE.call_once(|| unsafe {
        for (k, v) in [
            ("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_SYSTEM", "/dev/null"),
            ("GIT_AUTHOR_NAME", "Tester"), ("GIT_AUTHOR_EMAIL", "t@example.com"),
            ("GIT_COMMITTER_NAME", "Tester"), ("GIT_COMMITTER_EMAIL", "t@example.com"),
        ] {
            std::env::set_var(k, v);
        }
    });
}
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}
fn commit(dir: &Path, file: &str, text: &str, msg: &str) -> String {
    std::fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", msg]);
    git(dir, &["rev-parse", "HEAD"])
}
#[track_caller]
fn err(r: Resp) -> String {
    let Resp::Err(e) = r else { panic!("expected an error, got {r:?}") };
    e
}
static JOB: AtomicU64 = AtomicU64::new(1);
fn job(req: Req) -> Resp {
    handle(Req::Job { job: JOB.fetch_add(1, Ordering::Relaxed), req: Box::new(req) })
}
#[track_caller]
fn moved(r: Resp) -> Moved {
    match r {
        Resp::Moved(m) => m,
        r => panic!("expected Moved, got {r:?}"),
    }
}
fn repo(t: &tempfile::TempDir) -> (std::path::PathBuf, String) {
    let dir = t.path().join("r");
    git(t.path(), &["init", "-q", "-b", "main", dir.to_str().unwrap()]);
    let s = dir.to_str().unwrap().to_string();
    (dir, s)
}
fn subjects(dir: &Path) -> Vec<String> {
    git(dir, &["log", "--format=%s"]).lines().map(String::from).collect()
}
fn plan(repo: &str, from: Option<&str>) -> Result<RebasePlan, String> {
    match handle(Req::RebasePlan { repo: repo.into(), from: from.map(String::from) }) {
        Resp::RebasePlan(p) => Ok(p),
        Resp::Err(e) => Err(e),
        r => panic!("{r:?}"),
    }
}
fn s(oid: &str, action: TodoAction, message: Option<&str>) -> RebaseStep {
    RebaseStep { oid: oid.into(), action, message: message.map(String::from) }
}
fn run(repo: &str, base: Option<&str>, head: &str, steps: Vec<RebaseStep>, published_ok: bool) -> Resp {
    job(Req::InteractiveRebase { repo: repo.into(), base: base.map(String::from), head: head.into(), steps, published_ok })
}
fn status(repo: &str) -> Status {
    match handle(Req::Status { repo: repo.into() }) {
        Resp::Status(s) => s,
        r => panic!("{r:?}"),
    }
}

#[test]
fn rebase_todo_lists() {
    init();
    let t = tempfile::tempdir().unwrap();
    let (dir, r) = repo(&t);
    let c0 = commit(&dir, "0.txt", "0\n", "zero");
    let c1 = commit(&dir, "1.txt", "1\n", "one");
    let c2 = commit(&dir, "2.txt", "2\n", "two");
    let c3 = commit(&dir, "3.txt", "3\n", "three");
    let c4 = commit(&dir, "4.txt", "4\n", "four");
    let start = git(&dir, &["rev-parse", "HEAD"]);
    let tree = git(&dir, &["rev-parse", "HEAD^{tree}"]);
    let reset = || git(&dir, &["reset", "-q", "--hard", &start]);
    let b = Some(c0.as_str());

    // the plan from c1: base c0, oldest first, full messages, nothing published
    let p = plan(&r, Some(&c1)).unwrap();
    assert_eq!((p.base.as_deref(), p.head.as_str(), p.branch.as_deref()), (b, start.as_str(), Some("main")));
    assert_eq!(p.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["one", "two", "three", "four"]);
    assert!(p.commits.iter().all(|c| !c.published && c.author == "Tester" && c.time > 0));
    // without a start: the unpublished commits (all of them here, root included)
    let all = plan(&r, None).unwrap();
    assert_eq!((all.base, all.commits.len()), (None, 5));

    // reorder: same tree, new order; Undo puts HEAD and the branch back
    let m = moved(run(&r, b, &start, vec![s(&c3, Pick, None), s(&c1, Pick, None), s(&c4, Pick, None), s(&c2, Pick, None)], false));
    assert_eq!(subjects(&dir), ["two", "four", "one", "three", "zero"]);
    assert_eq!(git(&dir, &["rev-parse", "HEAD^{tree}"]), tree);
    let undo = job(Req::Undo { repo: r.clone(), moved: m, redo: false, mode: UndoMode::Keep, check: false });
    assert!(matches!(undo, Resp::Moved(_)), "{undo:?}");
    assert_eq!((git(&dir, &["rev-parse", "HEAD"]), git(&dir, &["rev-parse", "main"])), (start.clone(), start.clone()));
    assert_eq!(git(&dir, &["symbolic-ref", "HEAD"]), "refs/heads/main");

    // drop
    moved(run(&r, b, &start, vec![s(&c1, Pick, None), s(&c2, Drop, None), s(&c3, Pick, None), s(&c4, Drop, None)], false));
    assert_eq!(subjects(&dir), ["three", "one", "zero"]);
    assert!(!dir.join("2.txt").exists());
    reset();

    // squash with a new message, fixup keeping the first one's
    moved(run(&r, b, &start, vec![s(&c1, Pick, Some("one and two\n\nbody")), s(&c2, Squash, None), s(&c3, Pick, None), s(&c4, Fixup, None)], false));
    assert_eq!(subjects(&dir), ["three", "one and two", "zero"]);
    assert_eq!(git(&dir, &["log", "-1", "--format=%b", "HEAD~1"]), "body");
    assert_eq!(git(&dir, &["show", "--format=", "--name-only", "HEAD"]), "3.txt\n4.txt");
    assert_eq!(git(&dir, &["rev-parse", "HEAD^{tree}"]), tree);
    reset();
    // squash without a message: git's combined one, without its comment lines
    moved(run(&r, b, &start, vec![s(&c1, Pick, None), s(&c2, Squash, None), s(&c3, Pick, None), s(&c4, Pick, None)], false));
    let msg = git(&dir, &["log", "-1", "--format=%B", "HEAD~2"]);
    assert!(msg.contains("one") && msg.contains("two") && !msg.contains('#'), "{msg}");
    reset();

    // reword several (a message with a `#` line is kept as typed), then a combo: move + fixup across a drop + reword
    moved(run(&r, b, &start, vec![s(&c1, Reword, Some("ONE")), s(&c2, Pick, None), s(&c3, Reword, Some("THREE\n\n# not a comment")), s(&c4, Pick, None)], false));
    assert_eq!(subjects(&dir), ["four", "THREE", "two", "ONE", "zero"]);
    assert_eq!(git(&dir, &["log", "-1", "--format=%b", "HEAD~1"]), "# not a comment");
    reset();
    moved(run(&r, b, &start, vec![s(&c4, Reword, Some("four+one")), s(&c2, Drop, None), s(&c1, Fixup, None), s(&c3, Pick, None)], false));
    assert_eq!(subjects(&dir), ["three", "four+one", "zero"]);
    assert_eq!(git(&dir, &["show", "--format=", "--name-only", "HEAD~1"]), "1.txt\n4.txt");
    assert_eq!(git(&dir, &["log", "-1", "--format=%an", "HEAD~1"]), "Tester", "author kept");
    reset();

    // from the root: reword it, move another first
    moved(run(&r, None, &start, vec![s(&c1, Pick, None), s(&c0, Reword, Some("root")), s(&c2, Pick, None), s(&c3, Pick, None), s(&c4, Pick, None)], false));
    assert_eq!(subjects(&dir), ["four", "three", "two", "root", "one"]);
    reset();

    // nothing left: every line dropped resets the branch to the base
    moved(run(&r, b, &start, vec![s(&c1, Drop, None), s(&c2, Drop, None), s(&c3, Drop, None), s(&c4, Drop, None)], false));
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), c0);
    reset();
    assert!(!dir.join(".git/commitkiwi-rebase").exists(), "message files cleaned up");

    // refusals, all before anything moves
    let picks = || vec![s(&c1, Pick, None), s(&c2, Pick, None), s(&c3, Pick, None), s(&c4, Pick, None)];
    let refuse = |steps: Vec<RebaseStep>, base: Option<&str>, head: &str| err(run(&r, base, head, steps, false));
    assert!(refuse(picks(), b, &start).contains("Nothing to change"));
    assert!(refuse(vec![s(&c1, Squash, None), s(&c2, Pick, None), s(&c3, Pick, None), s(&c4, Pick, None)], b, &start).contains("first commit"));
    assert!(refuse(vec![s(&c1, Drop, None), s(&c2, Fixup, None), s(&c3, Pick, None), s(&c4, Pick, None)], b, &start).contains("first commit"));
    assert!(refuse(vec![s(&c1, Reword, None), s(&c2, Pick, None), s(&c3, Pick, None), s(&c4, Pick, None)], b, &start).contains("needs the new message"));
    assert!(refuse(vec![s(&c1, Reword, Some(" \n")), s(&c2, Pick, None), s(&c3, Pick, None), s(&c4, Pick, None)], b, &start).contains("empty"));
    assert!(refuse(vec![s(&c1, Pick, None), s(&c2, Squash, Some("x")), s(&c3, Pick, None), s(&c4, Pick, None)], b, &start).contains("only a pick or reword"));
    assert!(refuse(vec![s(&c1, Pick, None), s(&c1, Drop, None), s(&c3, Pick, None), s(&c4, Pick, None)], b, &start).contains("twice"));
    assert!(refuse(vec![s(&c1, Drop, None), s(&c3, Pick, None), s(&c4, Pick, None)], b, &start).contains("does not match"));
    assert!(refuse(vec![s(&c1, Drop, None), s(&c2, Pick, None), s(&c3, Pick, None), s(&c4, Pick, None)], b, &c3).contains("moved"));
    for bad in ["HEAD", "--exec=touch pwned", &c3[..12], "main"] {
        assert!(refuse(vec![s(bad, Drop, None)], b, &start).contains("not a commit id"), "{bad}");
        assert!(refuse(picks(), Some(bad), &start).contains("not a commit id"), "{bad}");
        assert!(plan(&r, Some(bad)).unwrap_err().contains("not a commit id"), "{bad}");
    }
    assert!(!dir.join("pwned").exists());
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), start);

    // dirty tree
    std::fs::write(dir.join("1.txt"), "dirty\n").unwrap();
    assert!(refuse(vec![s(&c1, Drop, None), s(&c2, Pick, None), s(&c3, Pick, None), s(&c4, Pick, None)], b, &start).contains("clean working directory"));
    git(&dir, &["checkout", "--", "1.txt"]);

    // published: the plan marks them, the rewrite asks first; changing only newer commits does not
    git(&dir, &["update-ref", "refs/remotes/origin/main", &c2]);
    let p = plan(&r, Some(&c1)).unwrap();
    assert_eq!(p.commits.iter().map(|c| c.published).collect::<Vec<_>>(), [true, true, false, false]);
    assert_eq!(plan(&r, None).unwrap().commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["three", "four"]);
    let e = refuse(vec![s(&c2, Pick, None), s(&c1, Pick, None), s(&c3, Pick, None), s(&c4, Pick, None)], b, &start);
    assert!(e.starts_with(PUBLISHED) && e.contains("origin/main"), "{e}");
    moved(run(&r, b, &start, vec![s(&c1, Pick, None), s(&c2, Pick, None), s(&c4, Pick, None), s(&c3, Pick, None)], false));
    reset();
    moved(run(&r, b, &start, vec![s(&c2, Pick, None), s(&c1, Pick, None), s(&c3, Pick, None), s(&c4, Pick, None)], true));
    reset();
    git(&dir, &["update-ref", "refs/remotes/origin/main", &start]);
    assert!(plan(&r, None).unwrap_err().contains("on a remote branch already"));
    git(&dir, &["update-ref", "-d", "refs/remotes/origin/main"]);

    // a merge in the range is refused, by the plan and by the rewrite
    git(&dir, &["checkout", "-q", "-b", "side", &c2]);
    commit(&dir, "s.txt", "s\n", "side");
    git(&dir, &["checkout", "-q", "main"]);
    git(&dir, &["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    let head = git(&dir, &["rev-parse", "HEAD"]);
    assert!(plan(&r, Some(&c1)).unwrap_err().contains("merge"));
    assert!(refuse(vec![s(&c1, Drop, None)], b, &head).contains("merge"));
    let after = commit(&dir, "5.txt", "5\n", "five");
    assert_eq!(plan(&r, Some(&after)).unwrap().commits.len(), 1, "after the merge is fine");
}

#[test]
fn rebase_conflict_continue_and_abort() {
    init();
    let t = tempfile::tempdir().unwrap();
    let (dir, r) = repo(&t);
    let c0 = commit(&dir, "f.txt", "a\n", "one");
    let c1 = commit(&dir, "f.txt", "a\nb\n", "two");
    let c2 = commit(&dir, "f.txt", "a\nb\nc\n", "three");
    let c3 = commit(&dir, "g.txt", "g\n", "four");
    let start = git(&dir, &["rev-parse", "HEAD"]);
    // "three" before "two" conflicts; "four" is reworded after the stop
    let steps = || vec![s(&c2, Pick, None), s(&c1, Pick, None), s(&c3, Reword, Some("four, reworded"))];
    let e = err(run(&r, Some(&c0), &start, steps(), false));
    assert!(e.contains("CONFLICT") || e.contains("could not apply"), "{e}");
    let st = status(&r);
    assert_eq!(st.op.as_deref(), Some("rebase"));
    assert!(st.files.iter().any(|f| f.kind == WorkKind::Conflicted && f.path == "f.txt"));
    assert!(err(run(&r, Some(&c0), &start, steps(), false)).contains("in progress"));
    // abort: everything as before
    assert!(matches!(job(Req::Sequence { repo: r.clone(), action: SeqAction::Abort }), Resp::Moved(_)));
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), start);
    assert_eq!(git(&dir, &["symbolic-ref", "HEAD"]), "refs/heads/main");

    // again, resolved and continued (twice: "two" conflicts too): the reword after the stop still applies
    err(run(&r, Some(&c0), &start, steps(), false));
    std::fs::write(dir.join("f.txt"), "a\nc\n").unwrap();
    git(&dir, &["add", "f.txt"]);
    let mut n = 0;
    while status(&r).op.is_some() {
        n += 1;
        assert!(n < 5, "rebase never finished");
        if status(&r).files.iter().any(|f| f.kind == WorkKind::Conflicted) {
            std::fs::write(dir.join("f.txt"), "a\nb\nc\n").unwrap();
            git(&dir, &["add", "f.txt"]);
        }
        let _ = job(Req::Sequence { repo: r.clone(), action: SeqAction::Continue });
    }
    assert_eq!(subjects(&dir), ["four, reworded", "two", "three", "one"]);
}

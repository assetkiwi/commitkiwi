//! M6: the merge tool's conflict stages and save, and commit editing by scripted `git rebase -i`, against real git
//! in temp repos. Every test calls `init` first: it sets process env (once) to isolate from the user's git config.
use commitkiwi_core::{PUBLISHED, handle};
use commitkiwi_protocol::*;
use std::path::Path;
use std::process::Command;
use std::sync::Once;
use std::sync::atomic::{AtomicU64, Ordering};

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
/// git that may fail (a merge that conflicts)
fn git_any(dir: &Path, args: &[&str]) {
    Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
}
fn commit(dir: &Path, file: &str, text: &str, msg: &str) -> String {
    if let Some(p) = Path::new(file).parent() {
        std::fs::create_dir_all(dir.join(p)).unwrap();
    }
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
fn conflict(repo: &str, path: &str) -> ConflictFile {
    match handle(Req::Conflict { repo: repo.into(), path: path.into() }) {
        Resp::Conflict(c) => c,
        r => panic!("expected Conflict, got {r:?}"),
    }
}
fn text(s: &Option<ConflictSide>) -> &str {
    s.as_ref().unwrap().blob.text.as_deref().unwrap()
}
fn unmerged(dir: &Path) -> String {
    git(dir, &["ls-files", "-u"])
}
fn status(repo: &str) -> Status {
    match handle(Req::Status { repo: repo.into() }) {
        Resp::Status(s) => s,
        r => panic!("{r:?}"),
    }
}
/// subjects of the branch, newest first
fn subjects(dir: &Path) -> Vec<String> {
    git(dir, &["log", "--format=%s"]).lines().map(String::from).collect()
}
fn rewrite(repo: &str, action: RewriteAction, commits: &[&String], message: Option<&str>) -> Resp {
    job(Req::Rewrite { repo: repo.into(), action, commits: commits.iter().map(|c| c.to_string()).collect(), message: message.map(String::from), published_ok: false })
}

/// A merge with a content conflict in `f.txt` (executable on both sides), a delete/modify one in `gone.txt`, a
/// binary one in `b.bin`, and one in `sub/s.txt`.
fn merge_conflicts(dir: &Path) {
    commit(dir, "f.txt", "a\nb\nc\n", "base");
    std::fs::write(dir.join("gone.txt"), "keep me\n").unwrap();
    std::fs::write(dir.join("b.bin"), b"\0base").unwrap();
    commit(dir, "sub/s.txt", "s\n", "more");
    std::fs::set_permissions(dir.join("f.txt"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    git(dir, &["add", "f.txt"]);
    git(dir, &["commit", "-q", "-m", "exec"]);
    git(dir, &["checkout", "-q", "-b", "other"]);
    std::fs::write(dir.join("f.txt"), "a\nTHEIRS\nc\n").unwrap();
    std::fs::write(dir.join("gone.txt"), "changed\n").unwrap();
    std::fs::write(dir.join("b.bin"), b"\0theirs").unwrap();
    commit(dir, "sub/s.txt", "theirs\n", "theirs");
    git(dir, &["checkout", "-q", "main"]);
    std::fs::write(dir.join("f.txt"), "a\nOURS\nc\n").unwrap();
    std::fs::remove_file(dir.join("gone.txt")).unwrap();
    std::fs::write(dir.join("b.bin"), b"\0ours").unwrap();
    commit(dir, "sub/s.txt", "ours\n", "ours");
    git_any(dir, &["merge", "-q", "other"]);
}

#[test]
fn conflict_stages() {
    init();
    let t = tempfile::tempdir().unwrap();
    let (dir, r) = repo(&t);
    merge_conflicts(&dir);
    let c = conflict(&r, "f.txt");
    assert_eq!((text(&c.base), text(&c.ours), text(&c.theirs)), ("a\nb\nc\n", "a\nOURS\nc\n", "a\nTHEIRS\nc\n"));
    assert_eq!(c.ours.as_ref().unwrap().mode, "100755");
    assert!(c.merged.unwrap().text.unwrap().contains("<<<<<<<"));
    assert_eq!(c.ours_commit.unwrap(), git(&dir, &["rev-parse", "HEAD"]));
    assert_eq!(c.theirs_commit.unwrap(), git(&dir, &["rev-parse", "other"]));
    // delete/modify: no stage 2, the working tree keeps theirs
    let g = conflict(&r, "gone.txt");
    assert!(g.ours.is_none() && g.base.is_some() && text(&g.theirs) == "changed\n");
    // binary
    let b = conflict(&r, "b.bin");
    assert!(b.ours.unwrap().blob.binary && b.theirs.unwrap().blob.binary);
    // not unmerged, outside the repo, hostile
    assert!(err(handle(Req::Conflict { repo: r.clone(), path: "sub".into() })).contains("no merge conflict"));
    for bad in ["../x", "/etc/passwd", "", "a/../f.txt"] {
        assert!(err(handle(Req::Conflict { repo: r.clone(), path: bad.into() })).contains("bad path"), "{bad}");
    }

    // resolve with the side that deleted it: the file goes
    assert!(matches!(job(Req::Resolve { repo: r.clone(), path: "gone.txt".into(), theirs: false }), Resp::Done));
    assert!(!dir.join("gone.txt").exists() && !unmerged(&dir).contains("gone.txt"));
    // a whole side for the binary file
    assert!(matches!(job(Req::Resolve { repo: r.clone(), path: "b.bin".into(), theirs: true }), Resp::Done));
    assert_eq!(std::fs::read(dir.join("b.bin")).unwrap(), b"\0theirs");
}

#[test]
fn save_merge() {
    use std::os::unix::fs::PermissionsExt;
    init();
    let t = tempfile::tempdir().unwrap();
    let (dir, r) = repo(&t);
    merge_conflicts(&dir);
    let save = |path: &str, text: &str, stage: bool| job(Req::SaveMerge { repo: r.clone(), path: path.into(), text: text.into(), stage });
    // save without staging: still unmerged; mode kept
    assert!(matches!(save("f.txt", "a\nOURS\nTHEIRS\nc\n", false), Resp::Done));
    assert_eq!(std::fs::read_to_string(dir.join("f.txt")).unwrap(), "a\nOURS\nTHEIRS\nc\n");
    assert!(unmerged(&dir).contains("f.txt"));
    assert_eq!(std::fs::metadata(dir.join("f.txt")).unwrap().permissions().mode() & 0o777, 0o755);
    // save and stage: resolved
    assert!(matches!(save("f.txt", "merged\n", true), Resp::Done));
    assert!(!unmerged(&dir).contains("f.txt"));
    assert_eq!(git(&dir, &["show", ":f.txt"]), "merged");
    assert!(std::fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")), "no temp file left");
    // refused: no conflict there (any more), outside the repo
    assert!(err(save("f.txt", "x", false)).contains("no merge conflict"));
    assert!(err(save("../escape.txt", "x", false)).contains("bad path"));
    // a symlinked folder or file on the way: never written through
    let outside = t.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("s.txt"), "precious\n").unwrap();
    std::fs::remove_dir_all(dir.join("sub")).unwrap();
    std::os::unix::fs::symlink(&outside, dir.join("sub")).unwrap();
    assert!(err(save("sub/s.txt", "pwned\n", true)).contains("symlink"));
    assert_eq!(std::fs::read_to_string(outside.join("s.txt")).unwrap(), "precious\n");
    std::fs::remove_file(dir.join("gone.txt")).unwrap();
    std::os::unix::fs::symlink(outside.join("s.txt"), dir.join("gone.txt")).unwrap();
    assert!(err(save("gone.txt", "pwned\n", true)).contains("symlink"));
    assert_eq!(std::fs::read_to_string(outside.join("s.txt")).unwrap(), "precious\n");
    // deleted on our side, missing in the worktree: saving recreates it
    std::fs::remove_file(dir.join("gone.txt")).unwrap();
    assert!(matches!(save("gone.txt", "both\n", true), Resp::Done));
    assert_eq!(std::fs::read_to_string(dir.join("gone.txt")).unwrap(), "both\n");
}

#[test]
fn rewrite_commits() {
    init();
    let t = tempfile::tempdir().unwrap();
    let (dir, r) = repo(&t);
    let c1 = commit(&dir, "1.txt", "1\n", "one");
    let c2 = commit(&dir, "2.txt", "2\n", "two");
    let c3 = commit(&dir, "3.txt", "3\n", "three");
    let c4 = commit(&dir, "4.txt", "4\n", "four");
    let c5 = commit(&dir, "5.txt", "5\n", "five");
    let tree = git(&dir, &["rev-parse", "HEAD^{tree}"]);
    let start = git(&dir, &["rev-parse", "HEAD"]);

    // reword: message replaced, tree the same; Undo (keep) puts the branch back
    let m = moved(rewrite(&r, RewriteAction::Reword, &[&c3], Some("three, better\n\nwith a body")));
    assert_eq!(subjects(&dir), ["five", "four", "three, better", "two", "one"]);
    assert_eq!(git(&dir, &["log", "-1", "--format=%b", "HEAD~2"]), "with a body");
    assert_eq!(git(&dir, &["rev-parse", "HEAD^{tree}"]), tree);
    assert_eq!((m.head_before.oid.as_deref(), m.head_after.branch.as_deref()), (Some(start.as_str()), Some("refs/heads/main")));
    let undo = job(Req::Undo { repo: r.clone(), moved: m, redo: false, mode: UndoMode::Keep, check: false });
    assert!(matches!(undo, Resp::Moved(_)), "{undo:?}");
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), start);

    // squash with parent: one commit with both messages, no comment lines
    moved(rewrite(&r, RewriteAction::Squash, &[&c3], None));
    assert_eq!(subjects(&dir), ["five", "four", "two", "one"]);
    let msg = git(&dir, &["log", "-1", "--format=%B", "HEAD~2"]);
    assert!(msg.contains("two") && msg.contains("three") && !msg.contains('#'), "{msg}");
    git(&dir, &["reset", "-q", "--hard", &start]);

    // squash selected (not adjacent): the newer one moves onto the oldest; fixup keeps the oldest's message only
    moved(rewrite(&r, RewriteAction::Squash, &[&c4, &c2], None));
    assert_eq!(subjects(&dir).len(), 4);
    assert!(git(&dir, &["log", "-1", "--format=%B", "HEAD~2"]).contains("four"));
    assert_eq!(git(&dir, &["rev-parse", "HEAD^{tree}"]), tree);
    git(&dir, &["reset", "-q", "--hard", &start]);
    moved(rewrite(&r, RewriteAction::Fixup, &[&c2, &c4], None));
    assert_eq!(subjects(&dir), ["five", "three", "two", "one"]);
    assert_eq!(git(&dir, &["show", "--format=", "--name-only", "HEAD~2"]), "2.txt\n4.txt");
    git(&dir, &["reset", "-q", "--hard", &start]);

    // drop
    moved(rewrite(&r, RewriteAction::Drop, &[&c3, &c5], None));
    assert_eq!(subjects(&dir), ["four", "two", "one"]);
    assert!(!dir.join("3.txt").exists());
    git(&dir, &["reset", "-q", "--hard", &start]);

    // move up / down
    moved(rewrite(&r, RewriteAction::MoveUp, &[&c2], None));
    assert_eq!(subjects(&dir), ["five", "four", "two", "three", "one"]);
    git(&dir, &["reset", "-q", "--hard", &start]);
    moved(rewrite(&r, RewriteAction::MoveDown, &[&c2], None));
    assert_eq!(subjects(&dir), ["five", "four", "three", "one", "two"], "past the root: rebase --root");
    git(&dir, &["reset", "-q", "--hard", &start]);

    // reword the root commit
    moved(rewrite(&r, RewriteAction::Reword, &[&c1], Some("root")));
    assert_eq!(subjects(&dir).last().unwrap(), "root");
    git(&dir, &["reset", "-q", "--hard", &start]);

    // edit: stops at the commit; amend by staging + continue
    moved(rewrite(&r, RewriteAction::Edit, &[&c3], None));
    let st = status(&r);
    assert_eq!((st.op.as_deref(), st.edit.as_deref()), (Some("rebase"), Some(c3.as_str())));
    std::fs::write(dir.join("3.txt"), "3 edited\n").unwrap();
    git(&dir, &["add", "3.txt"]);
    assert!(matches!(job(Req::Sequence { repo: r.clone(), action: SeqAction::Continue }), Resp::Moved(_)));
    let st = status(&r);
    assert_eq!((st.op, st.edit), (None, None));
    assert_eq!(git(&dir, &["show", "HEAD~2:3.txt"]), "3 edited");
    assert_eq!(subjects(&dir), ["five", "four", "three", "two", "one"]);
    git(&dir, &["reset", "-q", "--hard", &start]);

    // refusals: hostile or unknown ids, one-commit actions with several, ends of the branch, empty message
    for bad in ["HEAD", "--exec=touch pwned", &c3[..12], "main", "zz"] {
        assert!(err(rewrite(&r, RewriteAction::Drop, &[&bad.to_string()], None)).contains("not a commit id"), "{bad}");
    }
    assert!(!dir.join("pwned").exists());
    assert!(err(rewrite(&r, RewriteAction::Drop, &[&c3, &c3], None)).contains("twice"));
    assert!(err(rewrite(&r, RewriteAction::Reword, &[&c3], Some("  \n"))).contains("empty"));
    assert!(err(rewrite(&r, RewriteAction::Edit, &[&c3, &c4], None)).contains("exactly one"));
    assert!(err(rewrite(&r, RewriteAction::MoveUp, &[&c5], None)).contains("newest"));
    assert!(err(rewrite(&r, RewriteAction::MoveDown, &[&c1], None)).contains("first commit"));
    assert!(err(rewrite(&r, RewriteAction::Squash, &[&c1], None)).contains("no parent"));
    git(&dir, &["branch", "side", &c2]);
    git(&dir, &["checkout", "-q", "side"]);
    let s1 = commit(&dir, "s.txt", "s\n", "side");
    git(&dir, &["checkout", "-q", "main"]);
    assert!(err(rewrite(&r, RewriteAction::Drop, &[&s1], None)).contains("not on the current branch"));
    // dirty tree
    std::fs::write(dir.join("1.txt"), "dirty\n").unwrap();
    assert!(err(rewrite(&r, RewriteAction::Drop, &[&c3], None)).contains("clean working directory"));
    git(&dir, &["checkout", "--", "1.txt"]);
    // published: refused with PUBLISHED, then allowed when confirmed
    git(&dir, &["update-ref", "refs/remotes/origin/main", &c4]);
    let e = err(rewrite(&r, RewriteAction::Drop, &[&c3], None));
    assert!(e.starts_with(PUBLISHED) && e.contains("origin/main"), "{e}");
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), start, "refused before touching anything");
    let ok = job(Req::Rewrite { repo: r.clone(), action: RewriteAction::Drop, commits: vec![c3.clone()], message: None, published_ok: true });
    assert!(matches!(ok, Resp::Moved(_)), "{ok:?}");
    git(&dir, &["reset", "-q", "--hard", &start]);
    // only c5 is past origin/main: not published
    assert!(matches!(rewrite(&r, RewriteAction::Reword, &[&c5], Some("5")), Resp::Moved(_)));
    git(&dir, &["reset", "-q", "--hard", &start]);
    git(&dir, &["update-ref", "-d", "refs/remotes/origin/main"]);
    // a merge in the range
    git(&dir, &["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    let c6 = commit(&dir, "6.txt", "6\n", "six");
    assert!(err(rewrite(&r, RewriteAction::Drop, &[&c3], None)).contains("merge"));
    assert!(matches!(rewrite(&r, RewriteAction::Reword, &[&c6], Some("6")), Resp::Moved(_)), "after the merge is fine");
}

#[test]
fn rewrite_conflict() {
    init();
    let t = tempfile::tempdir().unwrap();
    let (dir, r) = repo(&t);
    commit(&dir, "f.txt", "a\n", "one");
    let c2 = commit(&dir, "f.txt", "a\nb\n", "two");
    commit(&dir, "f.txt", "a\nb\nc\n", "three");
    let start = git(&dir, &["rev-parse", "HEAD"]);
    // moving "two" above "three" replays three without two's line: a conflict, the rebase stops
    let e = err(rewrite(&r, RewriteAction::MoveUp, &[&c2], None));
    assert!(e.contains("CONFLICT") || e.contains("could not apply"), "{e}");
    let st = status(&r);
    assert_eq!((st.op.as_deref(), st.edit.as_deref()), (Some("rebase"), None));
    assert!(st.files.iter().any(|f| f.kind == WorkKind::Conflicted && f.path == "f.txt"));
    // the merge tool sees it; a second rewrite is refused while it runs
    let c = conflict(&r, "f.txt");
    assert!(c.ours.is_some() && c.theirs.is_some() && c.theirs_commit.is_some());
    assert!(err(rewrite(&r, RewriteAction::Drop, &[&c2], None)).contains("in progress"));
    assert!(matches!(job(Req::Sequence { repo: r.clone(), action: SeqAction::Abort }), Resp::Moved(_)));
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), start);
}

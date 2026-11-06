//! End-to-end check of `handle` against a real repo built with the git CLI.
//! Single test on purpose: it sets process env (isolating from the developer's git config).
use commitkiwi_core::handle;
use commitkiwi_protocol::*;
use std::process::Command;

fn sh(dir: &std::path::Path, args: &[&str]) {
    let s = Command::new("git").arg("-C").arg(dir).args(args).status().unwrap();
    assert!(s.success(), "git {args:?} failed");
}

fn commit(dir: &std::path::Path, file: &str, msg: &str) {
    std::fs::write(dir.join(file), msg).unwrap();
    sh(dir, &["add", "."]);
    sh(dir, &["commit", "-q", "-m", msg]);
}

fn log(repo: &str, skip: u32, limit: u32) -> Vec<Commit> {
    match handle(Req::Log { repo: repo.into(), skip, limit, hidden: vec![] }) {
        Resp::Log(c) => c,
        other => panic!("{other:?}"),
    }
}

#[test]
fn fixture_repo() {
    // SAFETY: only test in this binary, so nothing else reads env concurrently.
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
    let d = tmp.path().join("repo");
    std::fs::create_dir(&d).unwrap();
    let repo = d.to_str().unwrap();

    // empty repo
    sh(&d, &["init", "-q", "-b", "main"]);
    let Resp::Repo(info) = handle(Req::Open { path: repo.into() }) else { panic!() };
    assert_eq!((info.oid.is_none(), info.branch.as_deref()), (true, Some("main")));
    assert!(matches!(handle(Req::Count { repo: repo.into(), hidden: vec![] }), Resp::Count(0)));
    assert!(log(repo, 0, 10).is_empty());

    // history: a, b(2 files) on main; c on feature; d on main; merge; tags; stash; upstream + 1 ahead
    commit(&d, "a.txt", "a");
    std::fs::write(d.join("b1.txt"), "1").unwrap();
    std::fs::write(d.join("b2.txt"), "2").unwrap();
    sh(&d, &["add", "."]);
    sh(&d, &["commit", "-q", "-m", "b"]);
    sh(&d, &["checkout", "-q", "-b", "feature"]);
    commit(&d, "c.txt", "c");
    sh(&d, &["checkout", "-q", "main"]);
    commit(&d, "d.txt", "d");
    sh(&d, &["merge", "-q", "--no-ff", "-m", "merge", "feature"]);
    sh(&d, &["tag", "v1"]);
    sh(&d, &["tag", "-a", "v2", "-m", "annotated"]);
    sh(&d, &["remote", "add", "origin", repo]);
    sh(&d, &["fetch", "-q", "origin"]);
    sh(&d, &["branch", "-q", "-u", "origin/main"]);
    commit(&d, "e.txt", "e");
    std::fs::write(d.join("a.txt"), "dirty").unwrap();
    sh(&d, &["stash", "push", "-q", "-m", "wip"]);

    let Resp::Repo(info) = handle(Req::Open { path: repo.into() }) else { panic!() };
    assert_eq!((info.name.as_str(), info.ahead, info.behind), ("repo", 1, 0));
    assert!(matches!(handle(Req::Count { repo: repo.into(), hidden: vec![] }), Resp::Count(6)));

    let all = log(repo, 0, 100);
    assert_eq!(all.len(), 6);
    assert_eq!(all[0].subject, "e");
    assert!(all[0].labels.iter().any(|l| l.name == "main" && l.head));
    assert!(all.iter().all(|c| c.files.is_none()));
    let merge = all.iter().find(|c| c.subject == "merge").unwrap();
    assert_eq!(merge.parents.len(), 2);
    assert!(merge.labels.iter().any(|l| l.name == "origin/main" && l.kind == RefKind::Remote));
    // stats arrive separately: e=1 file, b=2 files, merge=0
    let ids: Vec<String> = all.iter().map(|c| c.oid.clone()).collect();
    let Resp::Stats(st) = handle(Req::Stats { repo: repo.into(), oids: ids }) else { panic!() };
    let files = |subject: &str| {
        let oid = &all.iter().find(|c| c.subject == subject).unwrap().oid;
        st.iter().find(|(o, _)| o == oid).unwrap().1
    };
    assert_eq!((st.len(), files("e"), files("b"), files("merge")), (6, 1, 2, 0));

    // paging is consistent with the full list
    let page: Vec<_> = log(repo, 2, 2).into_iter().map(|c| c.oid).collect();
    assert_eq!(page, all[2..4].iter().map(|c| c.oid.clone()).collect::<Vec<_>>());
    assert!(log(repo, 100, 10).is_empty());


    // ---- M2 on the 6-commit history: graph, locate, show, tree, blob, diff
    let rq = |req: Req| handle(req);
    let Resp::Graph(GraphData { parents: g, tips }) = rq(Req::Graph { repo: repo.into(), hidden: vec![] }) else { panic!() };
    assert!(tips.contains(&0), "HEAD's row is a tip");
    let c_row = all.iter().position(|c| c.subject == "c").unwrap() as u32;
    assert!(tips.contains(&c_row), "the merged `feature` branch still points at c");
    assert_eq!(g.len(), 6);
    for (i, parents) in g.iter().enumerate() {
        assert_eq!(parents.len(), all[i].parents.len());
        for (k, &row) in parents.iter().enumerate() {
            assert!(row as usize > i, "parents come after children (topo order)");
            assert_eq!(all[row as usize].oid, all[i].parents[k]);
        }
    }
    let m_row = all.iter().position(|c| c.subject == "merge").unwrap();
    assert_eq!(g[m_row].len(), 2);

    assert!(matches!(rq(Req::Locate { repo: repo.into(), oid: all[3].oid.clone(), hidden: vec![] }), Resp::Locate(Some(3))));
    assert!(matches!(rq(Req::Locate { repo: repo.into(), oid: "0".repeat(40), hidden: vec![] }), Resp::Locate(None)));

    let show = |oid: &str| match rq(Req::Show { repo: repo.into(), oid: oid.into(), from: None }) {
        Resp::Show(d) => d,
        other => panic!("{other:?}"),
    };
    let sm = show(&merge.oid);
    assert_eq!((sm.parents.len(), sm.subject.as_str()), (2, "merge"));
    assert_eq!(sm.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect::<Vec<_>>(), [("c.txt", "A")]);
    let sb = show(&all.iter().find(|c| c.subject == "b").unwrap().oid);
    assert_eq!(sb.files.len(), 2);
    assert!(sb.files.iter().all(|f| f.status == "A" && f.adds == Some(1) && f.dels == Some(0)));
    let root = show(&all.last().unwrap().oid); // empty-tree base for the root commit
    assert_eq!((root.parents.len(), root.files[0].path.as_str()), (0, "a.txt"));

    let Resp::Tree(t) = rq(Req::Tree { repo: repo.into(), oid: all[0].oid.clone(), path: "".into() }) else { panic!() };
    assert!(t.iter().any(|e| e.name == "a.txt" && e.kind == TreeKind::Blob && e.size == Some(1)));
    assert!(matches!(rq(Req::Tree { repo: repo.into(), oid: all[0].oid.clone(), path: "nope".into() }), Resp::Err(_)));
    let Resp::Blob(b) = rq(Req::Blob { repo: repo.into(), oid: all[0].oid.clone(), path: "a.txt".into() }) else { panic!() };
    assert_eq!((b.text.as_deref(), b.size, b.binary, b.truncated), (Some("a"), 1, false, false));

    let bcommit = all.iter().find(|c| c.subject == "b").unwrap().oid.clone();
    let Resp::Diff(p) = rq(Req::Diff { repo: repo.into(), oid: bcommit, path: "b1.txt".into(), old_path: None, context: 3, ignore_ws: false, from: None }) else { panic!() };
    assert!(p.text.contains("new file mode") && p.text.contains("+1") && !p.truncated, "{}", p.text);

    let Resp::Refs(r) = handle(Req::Refs { repo: repo.into() }) else { panic!() };
    let has = |n: &str, k: RefKind| r.refs.iter().any(|x| x.name == n && x.kind == k);
    assert!(has("main", RefKind::Branch) && has("feature", RefKind::Branch));
    assert!(has("origin/main", RefKind::Remote) && has("v1", RefKind::Tag) && has("v2", RefKind::Tag));
    assert!(!r.refs.iter().any(|x| x.name.ends_with("/HEAD")));
    assert!(r.refs.iter().any(|x| x.name == "main" && x.head));
    assert_eq!((r.stashes.len(), r.stashes[0].message.contains("wip")), (1, true));
    // annotated tag resolves to the commit, not the tag object
    let v2 = r.refs.iter().find(|x| x.name == "v2").unwrap();
    assert_eq!(v2.oid, merge.oid);

    // ---- M2 on new commits: blame, file history across a rename, binary blobs, hostile ids
    let write = |name: &str, bytes: &[u8]| std::fs::write(d.join(name), bytes).unwrap();
    write("lines.txt", b"one\ntwo\n");
    sh(&d, &["add", "."]);
    sh(&d, &["commit", "-q", "-m", "l1"]);
    write("lines.txt", b"one\nTWO\n");
    sh(&d, &["add", "."]);
    sh(&d, &["commit", "-q", "-m", "l2"]);
    write("bin.dat", &[0, 1, 2, 3]);
    sh(&d, &["add", "."]);
    sh(&d, &["commit", "-q", "-m", "bin"]);
    sh(&d, &["mv", "b1.txt", "renamed.txt"]);
    sh(&d, &["commit", "-q", "-m", "rename"]);
    let head = log(repo, 0, 10);
    let by = |subject: &str| head.iter().find(|c| c.subject == subject).unwrap().oid.clone();

    let Resp::Blame(bl) = rq(Req::Blame { repo: repo.into(), oid: head[0].oid.clone(), path: "lines.txt".into() }) else { panic!() };
    assert_eq!(bl.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["one", "TWO"]);
    assert_eq!((bl[0].oid.clone(), bl[1].oid.clone()), (by("l1"), by("l2")));
    assert!(bl.iter().all(|l| l.author == "Tester" && l.time > 0));

    let Resp::Log(fl) = rq(Req::FileLog { repo: repo.into(), oid: head[0].oid.clone(), path: "renamed.txt".into(), skip: 0, limit: 10 }) else { panic!() };
    assert_eq!(fl.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["rename", "b"]); // followed past the rename

    let rn = show(&by("rename"));
    assert_eq!((rn.files[0].status.as_str(), rn.files[0].path.as_str(), rn.files[0].old_path.as_deref()), ("R", "renamed.txt", Some("b1.txt")));
    let Resp::Diff(p) = rq(Req::Diff { repo: repo.into(), oid: by("rename"), path: "renamed.txt".into(), old_path: Some("b1.txt".into()), context: 3, ignore_ws: false, from: None }) else { panic!() };
    assert!(p.text.contains("rename from b1.txt"), "{}", p.text);
    let Resp::Diff(p) = rq(Req::Diff { repo: repo.into(), oid: by("l2"), path: "lines.txt".into(), old_path: None, context: 3, ignore_ws: false, from: None }) else { panic!() };
    assert!(p.text.contains("-two") && p.text.contains("+TWO"), "{}", p.text);

    let bin = show(&by("bin"));
    assert_eq!((bin.files[0].path.as_str(), bin.files[0].adds, bin.files[0].dels), ("bin.dat", None, None)); // binary: no line counts
    let Resp::Blob(b) = rq(Req::Blob { repo: repo.into(), oid: by("bin"), path: "bin.dat".into() }) else { panic!() };
    assert_eq!((b.binary, b.text.is_none(), b.size), (true, true, 4));

    // ---- M4: context lines, whitespace, line history, images
    write("ws.txt", b"x y\n");
    sh(&d, &["add", "."]);
    sh(&d, &["commit", "-q", "-m", "ws1"]);
    write("ws.txt", b"x   y\n");
    sh(&d, &["add", "."]);
    sh(&d, &["commit", "-q", "-m", "ws2"]);
    let png: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];
    write("pic.png", &png);
    sh(&d, &["add", "."]);
    sh(&d, &["commit", "-q", "-m", "pic"]);
    let head2 = log(repo, 0, 30);
    let by2 = |subject: &str| head2.iter().find(|c| c.subject == subject).unwrap().oid.clone();
    let dff = |oid: String, path: &str, context: u32, ignore_ws: bool| match rq(Req::Diff { repo: repo.into(), oid, path: path.into(), old_path: None, context, ignore_ws, from: None }) {
        Resp::Diff(p) => p.text,
        other => panic!("{other:?}"),
    };
    let ctx_lines = |t: &str| t.lines().skip_while(|l| !l.starts_with("@@")).skip(1).filter(|l| l.starts_with(' ')).count();
    assert_eq!(ctx_lines(&dff(by2("l2"), "lines.txt", 3, false)), 1); // "one"
    assert_eq!(ctx_lines(&dff(by2("l2"), "lines.txt", 0, false)), 0); // no context at all
    assert!(dff(by2("ws2"), "ws.txt", 3, false).contains("@@"));
    assert!(!dff(by2("ws2"), "ws.txt", 3, true).contains("@@"), "whitespace-only change disappears with ignore_ws");
    assert!(dff(by2("l2"), "lines.txt", 3, true).contains("+TWO"), "real changes stay with ignore_ws");
    assert!(dff(by2("l2"), "lines.txt", 100_000, false).contains("+TWO"), "absurd context is clamped, not an error");

    // hunk history: line 2 of lines.txt was created by l1 and rewritten by l2
    let ll = |start: u32, end: u32| rq(Req::LineLog { repo: repo.into(), oid: head2[0].oid.clone(), path: "lines.txt".into(), start, end, limit: 10 });
    let Resp::Log(h) = ll(2, 2) else { panic!() };
    assert_eq!(h.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["l2", "l1"]);
    let Resp::Log(h) = ll(1, 1) else { panic!() };
    assert_eq!(h.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["l1"]); // line 1 never changed after l1
    assert!(matches!(ll(0, 3), Resp::Err(_)) && matches!(ll(5, 2), Resp::Err(_)));

    let img = |path: &str| rq(Req::Image { repo: repo.into(), rev: by2("pic"), path: path.into() });
    let Resp::Image(i) = img("pic.png") else { panic!() };
    assert_eq!((i.mime.as_str(), i.size), ("image/png", 12));
    assert!(i.base64.starts_with("iVBORw0KGgo"), "{}", i.base64);
    assert!(matches!(img("lines.txt"), Resp::Err(m) if m.contains("not an image")));
    assert!(matches!(img("missing.png"), Resp::Err(_)));

    // every new request refuses non-hex ids (they become git arguments)
    for evil in ["--output=/tmp/pwn", "HEAD", "abc"] {
        let (repo, oid) = (repo.to_string(), evil.to_string());
        for req in [
            Req::Locate { repo: repo.clone(), oid: oid.clone(), hidden: vec![] },
            Req::Show { repo: repo.clone(), oid: oid.clone(), from: None },
            Req::Diff { repo: repo.clone(), oid: oid.clone(), path: "a.txt".into(), old_path: None, context: 3, ignore_ws: false, from: None },
            Req::Tree { repo: repo.clone(), oid: oid.clone(), path: "".into() },
            Req::Blob { repo: repo.clone(), oid: oid.clone(), path: "a.txt".into() },
            Req::FileLog { repo: repo.clone(), oid: oid.clone(), path: "a.txt".into(), skip: 0, limit: 1 },
            Req::Blame { repo: repo.clone(), oid: oid.clone(), path: "a.txt".into() },
            Req::LineLog { repo: repo.clone(), oid: oid.clone(), path: "a.txt".into(), start: 1, end: 2, limit: 5 },
        ] {
            assert!(matches!(handle(req.clone()), Resp::Err(_)), "{req:?}");
        }
    }
    // revs also accept HEAD/index/worktree, but nothing else
    for evil in ["--output=/tmp/pwn", "abc", "HEAD~1"] {
        assert!(matches!(rq(Req::Image { repo: repo.into(), rev: evil.into(), path: "pic.png".into() }), Resp::Err(_)));
        assert!(matches!(rq(Req::ReadFile { repo: repo.into(), rev: evil.into(), path: "a.txt".into() }), Resp::Err(_)));
    }
    let Resp::Image(i) = rq(Req::Image { repo: repo.into(), rev: "HEAD".into(), path: "pic.png".into() }) else { panic!() };
    assert_eq!(i.size, 12);

    // ---- F3: file list, range diff, worktrees, hidden refs, submodule/worktree arguments
    let Resp::Files(fl) = rq(Req::Files { repo: repo.into(), oid: all[0].oid.clone() }) else { panic!() };
    assert_eq!(fl, ["a.txt", "b1.txt", "b2.txt", "c.txt", "d.txt", "e.txt"]);
    let Resp::Show(range) = rq(Req::Show { repo: repo.into(), oid: all[0].oid.clone(), from: Some(merge.oid.clone()) }) else { panic!() };
    assert_eq!(range.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["c.txt", "e.txt"], "merge + e against d");
    let Resp::Diff(p) = rq(Req::Diff { repo: repo.into(), oid: all[0].oid.clone(), path: "c.txt".into(), old_path: None, context: 3, ignore_ws: false, from: Some(merge.oid.clone()) }) else { panic!() };
    assert!(p.text.contains("+c"), "{}", p.text);

    let wt = tmp.path().join("wt");
    assert!(matches!(rq(Req::AddWorktree { repo: repo.into(), path: wt.to_str().unwrap().into(), branch: None }), Resp::Done));
    commit(&wt, "w.txt", "w");
    let Resp::Refs(r) = rq(Req::Refs { repo: repo.into() }) else { panic!() };
    assert_eq!(r.worktrees.len(), 2);
    assert!(r.worktrees.iter().any(|w| w.current && w.branch.as_deref() == Some("main")), "{:?}", r.worktrees);
    let w = r.worktrees.iter().find(|w| !w.current).unwrap();
    assert_eq!(w.branch.as_deref(), Some("wt"));
    let count = |hidden: Vec<String>| match rq(Req::Count { repo: repo.into(), hidden }) { Resp::Count(n) => n, other => panic!("{other:?}") };
    let n = count(vec![]);
    assert_eq!(count(vec!["refs/heads/wt".into()]), n - 1, "hiding a branch drops its own commits");
    assert_eq!(count(vec!["refs/heads/feature".into()]), n, "merged commits stay reachable");
    assert!(matches!(rq(Req::Locate { repo: repo.into(), oid: w.oid.clone(), hidden: vec!["refs/heads/wt".into()] }), Resp::Locate(None)));
    let Resp::Log(l) = rq(Req::Log { repo: repo.into(), skip: 0, limit: 100, hidden: vec!["refs/heads/wt".into()] }) else { panic!() };
    assert!(l.iter().all(|c| c.oid != w.oid));
    for bad in ["--all", "heads/x", "refs/heads/*"] {
        assert!(matches!(rq(Req::Count { repo: repo.into(), hidden: vec![bad.into()] }), Resp::Err(_)), "{bad}");
    }
    assert!(matches!(rq(Req::AddWorktree { repo: repo.into(), path: "--detach".into(), branch: None }), Resp::Err(_)));
    assert!(matches!(rq(Req::AddSubmodule { repo: repo.into(), url: "--evil".into(), path: None }), Resp::Err(_)));
    assert!(matches!(rq(Req::UpdateSubmodules { repo: repo.into(), init: true, path: None }), Resp::Done));
    assert!(matches!(rq(Req::SyncSubmodules { repo: repo.into(), path: None }), Resp::Done));

    // errors: not a repo
    let none = tmp.path().join("nope");
    std::fs::create_dir(&none).unwrap();
    assert!(matches!(handle(Req::Open { path: none.to_str().unwrap().into() }), Resp::Err(_)));
}

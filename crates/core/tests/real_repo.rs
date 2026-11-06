//! Timing and sanity check of the M2 operations on a real repo. Opt-in:
//!   COMMITKIWI_REAL_REPO=~/projects/some-repo cargo test -p commitkiwi-core --test real_repo -- --ignored --nocapture
use commitkiwi_core::handle;
use commitkiwi_protocol::*;
use std::time::{Duration, Instant};

fn timed<T>(name: &str, budget_ms: u64, f: impl FnOnce() -> T) -> T {
    let t = Instant::now();
    let out = f();
    let took = t.elapsed();
    eprintln!("{name:<34} {:>7.1} ms (budget {budget_ms})", took.as_secs_f64() * 1000.0);
    assert!(took < Duration::from_millis(budget_ms), "{name} too slow: {took:?}");
    out
}

#[test]
#[ignore = "set COMMITKIWI_REAL_REPO"]
fn real_repo_budgets() {
    let repo = std::env::var("COMMITKIWI_REAL_REPO").expect("COMMITKIWI_REAL_REPO");
    let repo = repo.as_str();
    let rq = |req: Req| handle(req);

    // read-only: the UI polls this, so it must stay cheap
    let Resp::Status(st) = timed("status (polled by the UI)", 1500, || rq(Req::Status { repo: repo.into() })) else { panic!() };
    eprintln!("   {} changed/untracked files (truncated={})", st.files.len(), st.truncated);
    if let Some(f) = st.files.iter().find(|f| f.kind == WorkKind::Changed) {
        let staged = f.index != '.';
        let Resp::Diff(p) = timed("work diff", 800, || {
            rq(Req::WorkDiff { repo: repo.into(), path: f.path.clone(), old_path: f.old_path.clone(), staged, untracked: false, conflicted: false, context: 3, ignore_ws: false })
        }) else { panic!() };
        eprintln!("   {} ({} bytes)", f.path, p.text.len());
    }
    assert!(matches!(rq(Req::Identity { repo: repo.into() }), Resp::Identity(i) if i.contains('<')));

    let Resp::Count(total) = rq(Req::Count { repo: repo.into(), hidden: vec![] }) else { panic!() };
    let Resp::Graph(GraphData { parents: g, .. }) = timed("graph (all commits)", 1500, || rq(Req::Graph { repo: repo.into(), hidden: vec![] })) else { panic!() };
    assert_eq!(g.len(), total as usize);
    assert!(g.iter().enumerate().all(|(i, ps)| ps.iter().all(|&p| p as usize > i)), "topo order");
    let merges = g.iter().filter(|p| p.len() > 1).count();
    eprintln!("   {total} commits, {merges} merges");

    let Resp::Log(page) = rq(Req::Log { repo: repo.into(), skip: 0, limit: 500, hidden: vec![] }) else { panic!() };
    // locate agrees with log order
    let probe = page[200].oid.clone();
    let Resp::Locate(row) = timed("locate", 1500, || rq(Req::Locate { repo: repo.into(), oid: probe, hidden: vec![] })) else { panic!() };
    assert_eq!(row, Some(200));

    // the commit with the most files among the first 100
    let mut best: Option<Detail> = None;
    for c in page.iter().take(100) {
        let Resp::Show(d) = rq(Req::Show { repo: repo.into(), oid: c.oid.clone(), from: None }) else { panic!() };
        if best.as_ref().is_none_or(|b| d.files.len() > b.files.len()) {
            best = Some(d);
        }
    }
    let big = best.unwrap();
    let Resp::Show(_) = timed(&format!("show ({} files)", big.files.len()), 800, || rq(Req::Show { repo: repo.into(), oid: big.oid.clone(), from: None })) else { panic!() };
    let widest = big.files.iter().max_by_key(|f| f.adds.unwrap_or(0) + f.dels.unwrap_or(0)).unwrap().clone();
    let Resp::Diff(p) = timed(&format!("diff ({} +/- lines)", widest.adds.unwrap_or(0) + widest.dels.unwrap_or(0)), 800, || {
        rq(Req::Diff { repo: repo.into(), oid: big.oid.clone(), path: widest.path.clone(), old_path: widest.old_path.clone(), context: 3, ignore_ws: false, from: None })
    }) else { panic!() };
    eprintln!("   patch {} KB, truncated={}", p.text.len() / 1024, p.truncated);

    // M4: whitespace-insensitive wide-context diff, and the history of a line range
    let Resp::Diff(p) = timed("diff, 25 lines context, -w", 800, || {
        rq(Req::Diff { repo: repo.into(), oid: big.oid.clone(), path: widest.path.clone(), old_path: widest.old_path.clone(), context: 25, ignore_ws: true, from: None })
    }) else { panic!() };
    eprintln!("   patch {} KB", p.text.len() / 1024);
    let head = page[0].oid.clone();
    let Resp::Log(ll) = timed("hunk history (git log -L)", 3000, || {
        rq(Req::LineLog { repo: repo.into(), oid: head.clone(), path: "composer.json".into(), start: 1, end: 40, limit: 50 })
    }) else { panic!() };
    eprintln!("   {} commits touched composer.json lines 1-40", ll.len());
    let Resp::Tree(root) = timed("tree (root)", 500, || rq(Req::Tree { repo: repo.into(), oid: head.clone(), path: "".into() })) else { panic!() };
    let file = root.iter().find(|e| e.kind == TreeKind::Blob).expect("a file at the root").name.clone();
    let Resp::Blob(b) = timed("blob", 500, || rq(Req::Blob { repo: repo.into(), oid: head.clone(), path: file.clone() })) else { panic!() };
    eprintln!("   {file}: {} bytes, binary={}", b.size, b.binary);
    let Resp::Log(h) = timed("file history (100)", 1500, || {
        rq(Req::FileLog { repo: repo.into(), oid: head.clone(), path: file.clone(), skip: 0, limit: 100 })
    }) else { panic!() };
    eprintln!("   {} commits touched it", h.len());
    if !b.binary {
        let Resp::Blame(bl) = timed("blame", 2000, || rq(Req::Blame { repo: repo.into(), oid: head, path: file })) else { panic!() };
        assert!(bl.iter().all(|l| l.oid.len() == 40));
        eprintln!("   {} blamed lines", bl.len());
    }
}

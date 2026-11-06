//! M8 large repos: timings of the list/graph requests on a generated 100k-commit temp repo (with merges).
//! `cargo test -p commitkiwi-core --release --test large_repo -- --ignored --nocapture`
use commitkiwi_protocol::{Req, Resp};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Instant;

#[test]
#[ignore = "measurement: builds a 100k-commit repo (~10 s)"]
fn hundred_thousand_commits() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    assert!(Command::new("git").arg("-C").arg(p).args(["init", "-q", "-b", "main"]).status().unwrap().success());
    let t = Instant::now();
    let mut fi = Command::new("git").arg("-C").arg(p).args(["fast-import", "--quiet"]).stdin(Stdio::piped()).spawn().unwrap();
    {
        let mut w = std::io::BufWriter::new(fi.stdin.take().unwrap());
        let n = 100_000;
        for i in 1..=n {
            // every 50th commit merges a one-commit side branch
            let (r, msg) = if i % 50 == 25 { ("refs/heads/side", format!("side {i}")) } else { ("refs/heads/main", format!("commit {i}")) };
            write!(w, "commit {r}\nmark :{i}\ncommitter T <t@x> {} +0000\ndata {}\n{msg}\n", 1_600_000_000 + i, msg.len()).unwrap();
            if i % 50 == 25 {
                writeln!(w, "from :{}", i - 1).unwrap();
            } else if i % 50 == 26 {
                write!(w, "from :{}\nmerge :{}\n", i - 2, i - 1).unwrap();
            }
            write!(w, "M 644 inline f{}\ndata {}\n{i}\n\n", i % 100, i.to_string().len() + 1).unwrap();
        }
    }
    assert!(fi.wait().unwrap().success());
    println!("generated 100k commits in {:?}", t.elapsed());
    let repo = p.to_str().unwrap().to_string();
    let time = |what: &str, req: Req| {
        let t = Instant::now();
        let r = commitkiwi_core::handle(req);
        println!("{what:28} {:>9.1?}", t.elapsed());
        assert!(!matches!(r, Resp::Err(_)), "{what}: {r:?}");
        r
    };
    let Resp::Count(n) = time("Count", Req::Count { repo: repo.clone(), hidden: vec![] }) else { panic!() };
    assert_eq!(n, 100_000);
    time("Log first page (0..500)", Req::Log { repo: repo.clone(), skip: 0, limit: 500, hidden: vec![] });
    time("Log last page (99500..)", Req::Log { repo: repo.clone(), skip: 99_500, limit: 500, hidden: vec![] });
    let Resp::Graph(g) = time("Graph (all parents)", Req::Graph { repo: repo.clone(), hidden: vec![] }) else { panic!() };
    assert_eq!(g.parents.len(), 100_000);
    let bytes = rmp_size(&Resp::Graph(g.clone()));
    println!("{:28} {:>7} KiB", "Graph reply (msgpack)", bytes / 1024);
    let Resp::Log(last) = commitkiwi_core::handle(Req::Log { repo: repo.clone(), skip: 99_999, limit: 1, hidden: vec![] }) else { panic!() };
    time("Locate (oldest commit)", Req::Locate { repo: repo.clone(), oid: last[0].oid.clone(), hidden: vec![] });
    time("Refs", Req::Refs { repo: repo.clone() });
    time("Status", Req::Status { repo: repo.clone() });
}

fn rmp_size(r: &Resp) -> usize {
    commitkiwi_protocol::encode(&commitkiwi_protocol::Msg { id: 1, body: r.clone(), ms: None }).len()
}

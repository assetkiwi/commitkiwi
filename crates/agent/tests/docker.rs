//! Runs the *Linux* agent build inside Alpine, over the real protocol, against a repo created there.
//! Opt-in: `scripts/build-agents.sh aarch64 && docker pull alpine && cargo test -p commitkiwi-agent --test docker -- --ignored`
//! (use `x86_64` on an Intel host). Installing git prints to stdout before the agent starts,
//! which doubles as a test of skipping shell noise.
use commitkiwi_protocol::{Req, Resp, WorkKind};
use commitkiwi_runner::{Remote, Runner};
use std::process::Stdio;
use tokio::process::Command;

async fn next(rx: &mut tokio::sync::mpsc::UnboundedReceiver<commitkiwi_protocol::Change>, ms: u64) -> Option<commitkiwi_protocol::Change> {
    tokio::time::timeout(std::time::Duration::from_millis(ms), rx.recv()).await.ok().flatten()
}

#[tokio::test]
#[ignore = "needs docker + agents/linux-<arch> (scripts/build-agents.sh)"]
async fn linux_agent_in_docker() {
    let arch = if std::env::consts::ARCH == "aarch64" { "aarch64" } else { "x86_64" };
    let dir = format!("{}/../../agents/linux-{arch}", env!("CARGO_MANIFEST_DIR"));
    let script = "apk add git; export GIT_AUTHOR_NAME=T GIT_AUTHOR_EMAIL=t@x GIT_COMMITTER_NAME=T GIT_COMMITTER_EMAIL=t@x; \
        git init -q -b main /tmp/r && cd /tmp/r && for i in 1 2 3; do echo $i > f; git add f; git commit -qm \"c$i\"; done; \
        mkdir -p .git/info build && echo build/ > .git/info/exclude; \
        echo fresh > new.txt; mkdir -p /tmp/node_modules/x/.git; echo 'motd: welcome to the box'; exec /a/commitkiwi-agent --stdio";
    let name = format!("commitkiwi-agent-test-{}", std::process::id());
    let child = Command::new("docker")
        .args(["run", "-i", "--rm", "--name", &name, "-v", &format!("{dir}:/a:ro"), "alpine", "sh", "-c", script])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true)
        .spawn().unwrap();
    let remote = Runner::Remote(Box::new(Remote::from_child(child).await.expect("handshake with linux agent")));

    let Resp::Repo(info) = remote.call(Req::Open { path: "/tmp/r".into() }).await.unwrap() else { panic!() };
    assert_eq!((info.root.as_str(), info.branch.as_deref()), ("/tmp/r", Some("main")));
    assert!(matches!(remote.call(Req::Count { repo: "/tmp/r".into(), hidden: vec![] }).await.unwrap(), Resp::Count(3)));
    let Resp::Log(log) = remote.call(Req::Log { repo: "/tmp/r".into(), skip: 0, limit: 10, hidden: vec![] }).await.unwrap() else { panic!() };
    assert_eq!(log.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["c3", "c2", "c1"]);
    let oids = log.iter().map(|c| c.oid.clone()).collect();
    let Resp::Stats(st) = remote.call(Req::Stats { repo: "/tmp/r".into(), oids }).await.unwrap() else { panic!() };
    assert!(st.iter().all(|(_, n)| *n == 1));
    // M2 requests on the Linux build
    let Resp::Graph(g) = remote.call(Req::Graph { repo: "/tmp/r".into(), hidden: vec![] }).await.unwrap() else { panic!() };
    assert_eq!(g.parents, vec![vec![1], vec![2], vec![]]);
    let head = log[0].oid.clone();
    let Resp::Show(d) = remote.call(Req::Show { repo: "/tmp/r".into(), oid: head.clone(), from: None }).await.unwrap() else { panic!() };
    assert_eq!((d.subject.as_str(), d.files.len()), ("c3", 1));
    let Resp::Blame(bl) = remote.call(Req::Blame { repo: "/tmp/r".into(), oid: head, path: "f".into() }).await.unwrap() else { panic!() };
    assert_eq!((bl.len(), bl[0].text.as_str(), bl[0].author.as_str()), (1, "3", "T"));
    // M3 on the Linux build: see an untracked file, stage it, commit with sign-off
    let Resp::Status(st) = remote.call(Req::Status { repo: "/tmp/r".into() }).await.unwrap() else { panic!() };
    assert_eq!(st.files.len(), 1);
    assert_eq!((st.files[0].path.as_str(), st.files[0].kind), ("new.txt", WorkKind::Untracked));
    // the dashboard's read: branch, one changed file, no upstream, last commit
    let Resp::Overview(o) = remote.call(Req::Overview { repo: "/tmp/r".into() }).await.unwrap() else { panic!() };
    assert_eq!((o.branch.as_deref(), o.upstream, o.changed, o.subject.as_deref()), (Some("main"), None, 1, Some("c3")));
    let done = |r: Resp| assert!(matches!(r, Resp::Done), "{r:?}");
    done(remote.call(Req::Stage { repo: "/tmp/r".into(), paths: vec!["new.txt".into()] }).await.unwrap());
    // F7: the commit as a console job: its output streams back, the reply records main moving
    let out = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let o = out.clone();
    let sink: commitkiwi_runner::Sink = std::sync::Arc::new(move |t: &str| o.lock().unwrap().push_str(t));
    let commit = Req::Commit { repo: "/tmp/r".into(), message: "c4".into(), amend: false, signoff: true, no_verify: false };
    let Resp::Moved(m) = remote.call_with(Req::Job { job: 1, req: Box::new(commit) }, Some(sink)).await.unwrap() else { panic!() };
    assert_eq!((m.refs.len(), m.refs[0].name.as_str(), m.head_after.branch.as_deref()), (1, "refs/heads/main", Some("refs/heads/main")));
    assert!(out.lock().unwrap().contains("c4"), "{:?}", out.lock().unwrap());
    assert!(matches!(remote.call(Req::Count { repo: "/tmp/r".into(), hidden: vec![] }).await.unwrap(), Resp::Count(4)));
    let Resp::Status(st) = remote.call(Req::Status { repo: "/tmp/r".into() }).await.unwrap() else { panic!() };
    assert!(st.files.is_empty());
    // M4 on the Linux build: context/whitespace diff options and hunk history
    let Resp::Diff(p) = remote.call(Req::Diff { repo: "/tmp/r".into(), oid: log[0].oid.clone(), path: "f".into(), old_path: None, context: 0, ignore_ws: true, from: None }).await.unwrap() else { panic!() };
    assert!(p.text.contains("+3") && !p.text.lines().skip_while(|l| !l.starts_with("@@")).skip(1).any(|l| l.starts_with(' ')), "{}", p.text);
    let Resp::Log(h) = remote.call(Req::LineLog { repo: "/tmp/r".into(), oid: log[0].oid.clone(), path: "f".into(), start: 1, end: 1, limit: 10 }).await.unwrap() else { panic!() };
    assert_eq!(h.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["c3", "c2", "c1"]); // the one line was rewritten every commit
    // bulk add: scanning a folder on the remote host finds the repo, skips node_modules
    let Resp::Scan(sc) = remote.call(Req::ScanRepos { root: "/tmp".into(), depth: 2 }).await.unwrap() else { panic!() };
    assert_eq!((sc.paths, sc.truncated), (vec!["/tmp/r".to_string()], false));
    // M8 on Linux (inotify): file events from the agent, new folders picked up, ignored ones quiet, refs moves
    let sh = |cmd: &str| assert!(std::process::Command::new("docker").args(["exec", &name, "sh", "-c", cmd]).status().unwrap().success(), "{cmd}");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let on: commitkiwi_runner::ChangeFn = std::sync::Arc::new(move |c| { let _ = tx.send(c); });
    assert_eq!(remote.watch("/tmp/r", on).await.unwrap(), None, "inotify watcher");
    sh("echo x > /tmp/r/edited.txt");
    let c = next(&mut rx, 2000).await.expect("worktree event");
    assert!(c.work && !c.refs && c.polling.is_none(), "{c:?}");
    sh("mkdir -p /tmp/r/nd/sub && echo a > /tmp/r/nd/sub/a.txt");
    assert!(next(&mut rx, 2000).await.is_some(), "new folder");
    while next(&mut rx, 500).await.is_some() {}
    sh("echo b > /tmp/r/nd/sub/a.txt");
    assert!(next(&mut rx, 2000).await.is_some(), "edit in a folder created after the watch started");
    while next(&mut rx, 500).await.is_some() {}
    sh("echo o > /tmp/r/build/out.o; mkdir -p /tmp/r/node_modules/y && echo i > /tmp/r/node_modules/y/i.js");
    assert!(next(&mut rx, 1200).await.is_none(), "ignored folders are not watched");
    sh("cd /tmp/r && git branch -q feature/x");
    let c = next(&mut rx, 2000).await.expect("refs event");
    assert!(c.refs, "{c:?}");
    remote.unwatch("/tmp/r").await.unwrap();
    // LFS: a repo that uses it on a host without git-lfs gets the warning (Alpine's git has no git-lfs)
    sh("echo '*.bin filter=lfs diff=lfs merge=lfs -text' > /tmp/r/.gitattributes");
    let Resp::Repo(info) = remote.call(Req::Open { path: "/tmp/r".into() }).await.unwrap() else { panic!() };
    assert!(info.lfs_warning.as_deref().is_some_and(|w| w.contains("git-lfs is not installed")), "{:?}", info.lfs_warning);
    // forge probe on a box without gh: it says so (the UI then opens the browser page on the Mac)
    sh("cd /tmp/r && git remote add origin https://github.com/o/r.git && git update-ref refs/remotes/origin/main HEAD");
    let probe = Req::ForgeProbe {
        repo: "/tmp/r".into(), remote: "origin".into(), source: None, target: None,
        forge: Some(commitkiwi_protocol::Forge::Github), host: Some("github.com".into()), cli_path: None,
    };
    let Resp::Forge(f) = remote.call(probe).await.unwrap() else { panic!() };
    assert_eq!((f.default_branch.as_deref(), f.source.as_deref(), f.ahead), (Some("main"), Some("main"), Some(0)));
    assert!(f.cli.as_ref().is_some_and(|c| !c.installed && !c.authenticated), "{:?}", f.cli);
    // errors cross the wire too
    assert!(matches!(remote.call(Req::Open { path: "/nope".into() }).await.unwrap(), Resp::Err(_)));
}

//! The real agent binary, driven through `Remote` (no ssh), must answer exactly like the in-process runner.
use commitkiwi_protocol::{Req, Resp};
use commitkiwi_runner::{Remote, Runner};
use std::process::Stdio;
use tokio::process::Command;

fn agent() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_commitkiwi-agent"));
    c.arg("--stdio").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    c
}

#[tokio::test]
async fn agent_matches_local() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().to_str().unwrap().to_string();
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git")
            .arg("-C").arg(&p).args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "T").env("GIT_AUTHOR_EMAIL", "t@x")
            .env("GIT_COMMITTER_NAME", "T").env("GIT_COMMITTER_EMAIL", "t@x")
            .status().unwrap().success();
        assert!(ok, "git {args:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    for i in 0..5 {
        std::fs::write(d.path().join("f"), i.to_string()).unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", &format!("c{i}")]);
    }

    let remote = Runner::Remote(Box::new(Remote::from_child(agent().spawn().unwrap()).await.expect("handshake")));
    let local = Runner::Local;
    assert!(remote.alive());

    let reqs = [
        Req::Open { path: p.clone() },
        Req::Count { repo: p.clone(), hidden: vec![] },
        Req::Refs { repo: p.clone() },
        Req::Log { repo: p.clone(), skip: 1, limit: 3, hidden: vec![] },
        Req::Open { path: "/definitely/not/here".into() },
    ];
    for req in reqs {
        let (a, b) = (remote.call(req.clone()).await.unwrap(), local.call(req.clone()).await.unwrap());
        assert_eq!(format!("{a:?}"), format!("{b:?}"), "{req:?}");
    }

    // 20 requests in flight on one connection must each get their own reply
    let remote = std::sync::Arc::new(remote);
    let tasks: Vec<_> = (0..20u32)
        .map(|i| {
            let (r, p) = (remote.clone(), p.clone());
            tokio::spawn(async move { (i, r.call(Req::Log { repo: p, skip: i % 5, limit: 1, hidden: vec![] }).await.unwrap()) })
        })
        .collect();
    for t in tasks {
        let (i, resp) = t.await.unwrap();
        let Resp::Log(c) = resp else { panic!("{resp:?}") };
        assert_eq!(c[0].subject, format!("c{}", 4 - i % 5));
    }
}

#[tokio::test]
async fn dead_agent_reports_connection_lost() {
    let mut c = Command::new("sh");
    // prints the marker, then exits: handshake gets no reply and must fail fast instead of hanging
    c.arg("-c").arg("printf '\\0commitkiwi-agent/1\\n'; echo boom >&2")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let err = match Remote::from_child(c.spawn().unwrap()).await {
        Err(e) => e,
        Ok(_) => panic!("handshake must fail"),
    };
    assert!(err.contains("connection lost"), "{err}");
}

/// F7 over the wire: a job's output arrives as events before its reply, and a Cancel sent while the agent is
/// busy with a hanging job kills it (the agent keeps reading frames while requests run).
#[tokio::test]
async fn agent_jobs_stream_and_cancel() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().to_str().unwrap().to_string();
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git").arg("-C").arg(&p).args(args).status().unwrap().success();
        assert!(ok, "git {args:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["-c", "user.name=T", "-c", "user.email=t@x", "commit", "-q", "--allow-empty", "-m", "c0"]);
    let started = d.path().join("started");
    let hook = d.path().join(".git/hooks/pre-commit");
    std::fs::write(&hook, format!("#!/bin/sh\necho hook says hi\ntouch '{}'\nsleep 30\n", started.display())).unwrap();
    std::process::Command::new("chmod").arg("755").arg(&hook).status().unwrap();

    // isolated from the user's git config (a global core.hooksPath would skip our hook)
    let mut cmd = agent();
    for (k, v) in [("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_SYSTEM", "/dev/null"), ("GIT_AUTHOR_NAME", "T"), ("GIT_AUTHOR_EMAIL", "t@x"), ("GIT_COMMITTER_NAME", "T"), ("GIT_COMMITTER_EMAIL", "t@x")] {
        cmd.env(k, v);
    }
    let remote = std::sync::Arc::new(Runner::Remote(Box::new(Remote::from_child(cmd.spawn().unwrap()).await.expect("handshake"))));
    let out = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let o = out.clone();
    let sink: commitkiwi_runner::Sink = std::sync::Arc::new(move |t: &str| o.lock().unwrap().push_str(t));
    let commit = Req::Commit { repo: p.clone(), message: "slow".into(), amend: false, signoff: false, no_verify: false };
    let (r, req) = (remote.clone(), Req::Job { job: 41, req: Box::new(commit) });
    let running = tokio::spawn(async move { r.call_with(req, Some(sink)).await.unwrap() });
    let t = std::time::Instant::now();
    while !started.exists() {
        assert!(t.elapsed() < std::time::Duration::from_secs(10), "hook never started");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    // reads still answer while the job hangs
    assert!(matches!(remote.call(Req::Count { repo: p.clone(), hidden: vec![] }).await.unwrap(), Resp::Count(1)));
    assert!(matches!(remote.call(Req::Cancel { job: 41 }).await.unwrap(), Resp::Done));
    let resp = tokio::time::timeout(std::time::Duration::from_secs(10), running).await.expect("cancel must end the job").unwrap();
    assert!(matches!(&resp, Resp::Err(e) if e == commitkiwi_core::CANCELLED), "{resp:?}");
    assert!(out.lock().unwrap().contains("hook says hi"), "hook output streamed: {:?}", out.lock().unwrap());
    assert!(matches!(remote.call(Req::Count { repo: p.clone(), hidden: vec![] }).await.unwrap(), Resp::Count(1)), "nothing committed");
}

fn temp_repo() -> (tempfile::TempDir, String) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().to_str().unwrap().to_string();
    for args in [&["init", "-q", "-b", "main"][..], &["-c", "user.name=T", "-c", "user.email=t@x", "commit", "-q", "--allow-empty", "-m", "c0"]] {
        assert!(std::process::Command::new("git").arg("-C").arg(&p).args(args).status().unwrap().success());
    }
    (d, p)
}

/// M8: the agent's watcher pushes `Changed` frames (id 0) that reach the callback; Unwatch stops them.
#[tokio::test]
async fn agent_pushes_change_events() {
    let (d, p) = temp_repo();
    let remote = Runner::Remote(Box::new(Remote::from_child(agent().spawn().unwrap()).await.expect("handshake")));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let on: commitkiwi_runner::ChangeFn = std::sync::Arc::new(move |c| { let _ = tx.send(c); });
    assert_eq!(remote.watch(&p, on).await.unwrap(), None, "file events, not polling");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    std::fs::write(d.path().join("new.txt"), "x").unwrap();
    let c = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await.expect("event within 2 s").unwrap();
    assert_eq!((c.repo.as_str(), c.work, c.polling), (p.as_str(), true, None));
    // requests still work alongside events
    assert!(matches!(remote.call(Req::Count { repo: p.clone(), hidden: vec![] }).await.unwrap(), Resp::Count(1)));
    remote.unwatch(&p).await.unwrap();
    while rx.try_recv().is_ok() {}
    std::fs::write(d.path().join("new2.txt"), "y").unwrap();
    assert!(tokio::time::timeout(std::time::Duration::from_millis(800), rx.recv()).await.is_err(), "unwatched");
    // a path that is not a repo: polling, with the reason
    let plain = tempfile::tempdir().unwrap();
    let r = remote.watch(plain.path().to_str().unwrap(), std::sync::Arc::new(|_| {})).await.unwrap();
    assert!(r.is_some(), "{r:?}");
}

/// M8: killing the agent drops the link: in-flight calls fail "connection lost", calls meanwhile fail fast with
/// "Disconnected, reconnecting…", then the link reconnects (new agent), re-subscribes the watcher, reports Up.
#[tokio::test]
async fn link_reconnects_after_the_agent_dies() {
    use commitkiwi_runner::link::{Link, LinkEvent};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    let (d, p) = temp_repo();
    let pid = Arc::new(Mutex::new(None::<u32>));
    let (fail, starts) = (Arc::new(std::sync::atomic::AtomicBool::new(false)), Arc::new(std::sync::atomic::AtomicU32::new(0)));
    let (pid2, fail2, starts2) = (pid.clone(), fail.clone(), starts.clone());
    let connect: commitkiwi_runner::link::Connect = Arc::new(move || {
        let (pid, fail, starts) = (pid2.clone(), fail2.clone(), starts2.clone());
        Box::pin(async move {
            starts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if fail.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("host unreachable".to_string());
            }
            // same isolation as above: no global git config, and an identity so the commit reaches its hook (CI has none)
            let mut cmd = agent();
            for (k, v) in [("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_SYSTEM", "/dev/null"), ("GIT_AUTHOR_NAME", "T"), ("GIT_AUTHOR_EMAIL", "t@x"), ("GIT_COMMITTER_NAME", "T"), ("GIT_COMMITTER_EMAIL", "t@x")] {
                cmd.env(k, v);
            }
            let child = cmd.spawn().unwrap();
            *pid.lock().unwrap() = child.id();
            Ok(Runner::Remote(Box::new(Remote::from_child(child).await?)))
        })
    });
    let (ctx, mut changes) = tokio::sync::mpsc::unbounded_channel();
    let (stx, mut states) = tokio::sync::mpsc::unbounded_channel();
    let link = Link::with_backoff(
        connect,
        Arc::new(move |c| { let _ = ctx.send(c); }),
        Arc::new(move |s| { let _ = stx.send(s); }),
        Duration::from_millis(100),
        Duration::from_millis(400),
    );
    assert_eq!(link.watch(&p).await.unwrap(), None);
    let first = pid.lock().unwrap().unwrap();

    // a slow job in flight when the link drops fails; it is not re-run on the new connection
    let hook = d.path().join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nsleep 5\n").unwrap();
    std::process::Command::new("chmod").arg("755").arg(&hook).status().unwrap();
    let r = link.runner().await.unwrap();
    let commit = Req::Commit { repo: p.clone(), message: "m".into(), amend: false, signoff: false, no_verify: false };
    let inflight = tokio::spawn(async move { r.call(Req::Job { job: 7, req: Box::new(commit) }).await });
    tokio::time::sleep(Duration::from_millis(300)).await;

    fail.store(true, std::sync::atomic::Ordering::SeqCst); // first reconnect attempts fail: backoff
    std::process::Command::new("kill").arg("-9").arg(first.to_string()).status().unwrap();
    let err = tokio::time::timeout(Duration::from_secs(5), inflight).await.expect("in-flight call ends").unwrap().unwrap_err();
    assert!(err.contains("connection lost"), "{err}");
    let s = tokio::time::timeout(Duration::from_secs(5), states.recv()).await.expect("Lost event").unwrap();
    assert!(matches!(&s, LinkEvent::Lost(_)), "{s:?}");
    let e = link.runner().await.err().expect("down");
    assert!(e.starts_with("Disconnected, reconnecting…"), "{e}");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(starts.load(std::sync::atomic::Ordering::SeqCst) >= 3, "retried with backoff");

    fail.store(false, std::sync::atomic::Ordering::SeqCst);
    let up = loop {
        let s = tokio::time::timeout(Duration::from_secs(5), states.recv()).await.expect("Up event").unwrap();
        if s == LinkEvent::Up { break s; }
    };
    assert_eq!(up, LinkEvent::Up);
    assert_ne!(pid.lock().unwrap().unwrap(), first, "a new agent");
    assert!(matches!(link.runner().await.unwrap().call(Req::Count { repo: p.clone(), hidden: vec![] }).await.unwrap(), Resp::Count(1)), "job never re-ran");

    // the watcher was re-subscribed on the new agent
    tokio::time::sleep(Duration::from_millis(300)).await;
    while changes.try_recv().is_ok() {}
    std::fs::write(d.path().join("after.txt"), "z").unwrap();
    let c = tokio::time::timeout(Duration::from_secs(2), changes.recv()).await.expect("event from the new agent").unwrap();
    assert!(c.work && c.polling.is_none(), "{c:?}");

    // nothing watched there any more: a drop is not reconnected (the next call connects inline)
    link.unwatch(&p).await.unwrap();
    let second = pid.lock().unwrap().unwrap();
    std::process::Command::new("kill").arg("-9").arg(second.to_string()).status().unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(800), states.recv()).await.is_err(), "no Lost without watched repos");
    assert!(link.runner().await.is_ok(), "reconnects on demand");
}

/// Forge requests run inside the agent: the probe finds the CLI on the agent's PATH (a fake `gh` here, never the
/// real one), and a ForgeCreate job streams the CLI's output and replies `Created` with the URL.
#[tokio::test]
async fn agent_forge_probe_and_create() {
    let (d, p) = temp_repo();
    let git = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(&p).args(args).status().unwrap().success());
    git(&["remote", "add", "origin", "https://github.com/o/r.git"]);
    git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(&["checkout", "-q", "-b", "topic"]);
    let bin = d.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let gh = bin.join("gh");
    let script = "#!/bin/sh\n[ \"$1\" = auth ] && exit 0\necho 'Creating pull request' >&2\necho https://github.com/o/r/pull/9\n";
    std::fs::write(&gh, script).unwrap();
    std::process::Command::new("chmod").arg("755").arg(&gh).status().unwrap();
    let mut c = agent();
    c.env("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()));
    let remote = Runner::Remote(Box::new(Remote::from_child(c.spawn().unwrap()).await.expect("handshake")));
    let probe = Req::ForgeProbe {
        repo: p.clone(), remote: "origin".into(), source: None, target: None,
        forge: Some(commitkiwi_protocol::Forge::Github), host: Some("github.com".into()), cli_path: None,
    };
    let Resp::Forge(f) = remote.call(probe).await.unwrap() else { panic!() };
    assert_eq!((f.source.as_deref(), f.default_branch.as_deref(), f.ahead), (Some("topic"), Some("main"), None));
    let cli = f.cli.unwrap();
    assert!(cli.installed && cli.authenticated, "{cli:?}");
    assert_eq!(cli.path.as_deref(), Some(gh.to_str().unwrap()));
    let req = commitkiwi_protocol::ForgeRequest {
        repo: p.clone(), forge: commitkiwi_protocol::Forge::Github, host: "github.com".into(), project: "o/r".into(), cli_path: None,
        source: "topic".into(), target: "main".into(), title: "T".into(), body: "B".into(), draft: false, remove_source_branch: false,
        squash: false, reviewers: vec![], labels: vec![], assignees: vec![],
    };
    let out = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let o2 = out.clone();
    let sink: commitkiwi_runner::Sink = std::sync::Arc::new(move |t: &str| o2.lock().unwrap().push_str(t));
    let r = remote.call_with(Req::Job { job: 5, req: Box::new(Req::ForgeCreate(req)) }, Some(sink)).await.unwrap();
    assert!(matches!(&r, Resp::Created { url: Some(u), .. } if u == "https://github.com/o/r/pull/9"), "{r:?}");
    assert!(out.lock().unwrap().contains("Creating pull request"));
}

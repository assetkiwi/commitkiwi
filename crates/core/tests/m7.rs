//! M7b: New Repository (`Init`), Clone (incl. hostile input and Cancel), user `git` commands (`GitCustom`).
//! Single test: it sets process env (isolated git config, a fake slow remote helper on PATH).
use commitkiwi_core::{CANCELLED, cancel, handle};
use commitkiwi_protocol::*;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn err(r: Resp) -> String {
    match r {
        Resp::Err(e) => e,
        other => panic!("expected an error, got {other:?}"),
    }
}

fn text(r: Resp) -> String {
    match r {
        Resp::Text(t) => t,
        other => panic!("expected Text, got {other:?}"),
    }
}

#[test]
fn m7() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().canonicalize().unwrap();
    let bin = root.join("bin");
    std::fs::create_dir(&bin).unwrap();
    // `slow::x` URLs run this remote helper: it hangs, so a clone can be cancelled mid-way
    let helper = bin.join("git-remote-slow");
    std::fs::write(&helper, "#!/bin/sh\nsleep 30\n").unwrap();
    Command::new("chmod").arg("755").arg(&helper).status().unwrap();
    // SAFETY: only test in this binary; set before any thread starts.
    unsafe {
        for (k, v) in [
            ("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_SYSTEM", "/dev/null"),
            ("GIT_AUTHOR_NAME", "Tester"), ("GIT_AUTHOR_EMAIL", "t@example.com"),
            ("GIT_COMMITTER_NAME", "Tester"), ("GIT_COMMITTER_EMAIL", "t@example.com"),
        ] {
            std::env::set_var(k, v);
        }
        std::env::set_var("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()));
    }
    let s = |p: &Path| p.to_str().unwrap().to_string();

    // ---- Init: creates the folder, refuses a second time, refuses relative/option-like/multi-line paths
    let fresh = root.join("new/sub");
    assert_eq!(text(handle(Req::Init { path: s(&fresh) })), s(&fresh));
    assert!(fresh.join(".git").is_dir());
    assert!(err(handle(Req::Init { path: s(&fresh) })).contains("already a git repository"));
    for bad in ["relative/dir", "-x", "", "/tmp/a\nb"] {
        assert!(matches!(handle(Req::Init { path: bad.into() }), Resp::Err(_)), "{bad:?}");
    }

    // ---- Clone from a local bare repo
    let src = root.join("src");
    std::fs::create_dir(&src).unwrap();
    git(&src, &["init", "-q", "-b", "main"]);
    std::fs::write(src.join("a.txt"), "one\n").unwrap();
    git(&src, &["add", "."]);
    git(&src, &["commit", "-q", "-m", "first"]);
    let bare = root.join("origin.git");
    git(&root, &["clone", "-q", "--bare", &s(&src), &s(&bare)]);
    let dest = root.join("dest");
    std::fs::create_dir(&dest).unwrap();
    let out = text(handle(Req::Clone { url: s(&bare), parent: s(&dest), name: None }));
    assert_eq!(out, s(&dest.join("origin")), "name from the URL, .git stripped");
    assert_eq!(std::fs::read_to_string(dest.join("origin/a.txt")).unwrap(), "one\n");
    let out = text(handle(Req::Clone { url: format!("{}/", s(&bare)), parent: s(&dest), name: Some("mine".into()) }));
    assert!(out.ends_with("/dest/mine") && dest.join("mine/.git").is_dir());
    assert!(err(handle(Req::Clone { url: s(&bare), parent: s(&dest), name: Some("mine".into()) })).contains("already exists"));

    // hostile URLs, names and destinations never reach git (no marker, no folder)
    let marker = root.join("pwned");
    let m = s(&marker);
    for url in [
        format!("--upload-pack=touch {m}"), format!("-u touch {m}"), format!("ext::sh -c touch% {m}"), format!("EXT::sh -c touch% {m}"),
        "fd::3".into(), format!("{}\n--upload-pack=touch {m}", s(&bare)), String::new(),
    ] {
        let e = err(handle(Req::Clone { url: url.clone(), parent: s(&dest), name: Some("h".into()) }));
        assert!(e.contains("not a valid repository URL"), "{url:?}: {e}");
    }
    for name in ["..", ".", "-x", "a/b", "../escape", "x\ny"] {
        assert!(err(handle(Req::Clone { url: s(&bare), parent: s(&dest), name: Some(name.into()) })).contains("not a valid folder name"), "{name:?}");
    }
    for parent in ["relative", "-x", &s(&root.join("missing"))] {
        assert!(matches!(handle(Req::Clone { url: s(&bare), parent: parent.into(), name: None }), Resp::Err(_)), "{parent:?}");
    }
    assert!(!marker.exists() && !dest.join("h").exists() && !root.join("escape").exists());

    // ---- Cancel a running clone: Cancelled, and git leaves no half-made folder
    let t = std::thread::spawn({
        let dest = s(&dest);
        move || handle(Req::Job { job: 71, req: Box::new(Req::Clone { url: "slow::x".into(), parent: dest, name: Some("slow".into()) }) })
    });
    let start = Instant::now();
    while !dest.join("slow").exists() {
        assert!(start.elapsed() < Duration::from_secs(10), "clone never started");
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(200));
    cancel(71);
    assert_eq!(err(t.join().unwrap()), CANCELLED);
    assert!(start.elapsed() < Duration::from_secs(10), "cancel must not wait for the helper");
    let gone = Instant::now();
    while dest.join("slow").exists() && gone.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!dest.join("slow").exists(), "git clone removes its folder when killed");

    // ---- GitCustom: a normal write job (ref moves recorded), no shell, hostile argv refused
    let repo = s(&dest.join("origin"));
    let r = handle(Req::Job { job: 72, req: Box::new(Req::GitCustom { repo: repo.clone(), argv: vec!["commit".into(), "--allow-empty".into(), "-m".into(), format!("$(touch {m}); `touch {m}`")] }) });
    let Resp::Moved(mv) = r else { panic!("a custom command job reports moves: {r:?}") };
    assert_eq!(mv.refs.len(), 1);
    assert_eq!(git(&dest.join("origin"), &["log", "-1", "--format=%s"]), format!("$(touch {m}); `touch {m}`"));
    git(&dest.join("origin"), &["config", "alias.evil", &format!("!touch {m}")]);
    git(&dest.join("origin"), &["config", "alias.co", "checkout"]);
    for argv in [
        vec![], vec!["evil"], vec!["co", "main"], vec!["-c", &format!("core.pager=touch {m}"), "log"], vec!["--exec-path=/tmp", "log"],
        vec!["-C", "/", "status"], vec!["!touch"], vec!["Log"], vec!["log", "a\0b"], vec!["log", "a\rb"], vec!["no-such-command"],
    ] {
        let argv: Vec<String> = argv.into_iter().map(String::from).collect();
        let e = err(handle(Req::GitCustom { repo: repo.clone(), argv: argv.clone() }));
        assert!(e.contains("not a git command") || e.contains("bad argument") || e.contains("needs an argv"), "{argv:?}: {e}");
    }
    let many = vec!["status".to_string(); 300];
    assert!(err(handle(Req::GitCustom { repo: repo.clone(), argv: many })).contains("too long"));
    // arguments are passed as they are: a multi-line message is fine, a hostile path is just a path
    assert!(matches!(handle(Req::GitCustom { repo: repo.clone(), argv: vec!["commit".into(), "--allow-empty".into(), "-m".into(), "a\n\nb".into()] }), Resp::Done));
    let e = err(handle(Req::GitCustom { repo: repo.clone(), argv: vec!["rm".into(), "--".into(), format!("; touch {m}")] }));
    assert!(e.contains("did not match"), "{e}");
    assert!(!marker.exists(), "nothing ran through a shell or an alias");
}

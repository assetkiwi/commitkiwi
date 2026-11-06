//! A repo's own config must not run code on reads (fsmonitor hook, textconv, external diff); writes keep hooks;
//! filter drivers (except stock git-lfs) are blanked on reads; config is re-read per call;
//! the Ignore action never writes through a symlinked .gitignore.
//! Single test: it sets process env to isolate from the user's git config.
use commitkiwi_core::handle;
use commitkiwi_protocol::*;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn script(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn ok(r: Resp) -> Resp {
    assert!(!matches!(r, Resp::Err(_)), "{r:?}");
    r
}

#[test]
fn hardening() {
    // SAFETY: only test in this binary; set before any thread starts.
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
    let repo = d.to_str().unwrap().to_string();
    let marker = tmp.path().join("ran");
    let ran = || {
        let r = marker.exists();
        let _ = std::fs::remove_file(&marker);
        r
    };
    git(&d, &["init", "-q", "-b", "main"]);
    std::fs::write(d.join("a.txt"), "one\n").unwrap();
    std::fs::write(d.join("b.txt"), "same\n").unwrap();
    std::fs::write(d.join(".gitattributes"), "*.txt diff=evil\n").unwrap();
    git(&d, &["add", "."]);
    git(&d, &["commit", "-q", "-m", "first"]);
    std::fs::write(d.join("a.txt"), "two\n").unwrap();
    git(&d, &["commit", "-q", "-am", "second"]);
    let head = git(&d, &["rev-parse", "HEAD"]);
    std::fs::write(d.join("a.txt"), "three\n").unwrap(); // a working-copy change for status/WorkDiff

    // first open with a clean config: everything below is added afterwards and must be caught on the next call
    ok(handle(Req::Status { repo: repo.clone() }));

    // the repo's own config wires up three code-running hooks, all touching `marker`
    let m = marker.display();
    script(&tmp.path().join("fsmonitor.sh"), &format!("touch '{m}'"));
    script(&tmp.path().join("textconv.sh"), &format!("touch '{m}'; cat \"$1\""));
    script(&tmp.path().join("extdiff.sh"), &format!("touch '{m}'"));
    git(&d, &["config", "core.fsmonitor", tmp.path().join("fsmonitor.sh").to_str().unwrap()]);
    git(&d, &["config", "diff.evil.textconv", tmp.path().join("textconv.sh").to_str().unwrap()]);

    // sanity: plain git does run them, so the assertions below mean something
    git(&d, &["status"]);
    assert!(ran(), "plain git status runs the fsmonitor hook");
    git(&d, &["-c", "core.fsmonitor=false", "log", "-p", "-1"]);
    assert!(ran(), "plain git log -p runs textconv");

    let reads = [
        Req::Status { repo: repo.clone() },
        Req::Overview { repo: repo.clone() },
        Req::Log { repo: repo.clone(), skip: 0, limit: 10, hidden: vec![] },
        Req::Show { repo: repo.clone(), oid: head.clone(), from: None },
        Req::Diff { repo: repo.clone(), oid: head.clone(), path: "a.txt".into(), old_path: None, context: 3, ignore_ws: false, from: None },
        Req::WorkDiff { repo: repo.clone(), path: "a.txt".into(), old_path: None, staged: false, untracked: false, conflicted: false, context: 3, ignore_ws: false },
        Req::Blame { repo: repo.clone(), oid: head.clone(), path: "a.txt".into() },
        Req::LineLog { repo: repo.clone(), oid: head.clone(), path: "a.txt".into(), start: 1, end: 1, limit: 10 },
        Req::FileLog { repo: repo.clone(), oid: head.clone(), path: "a.txt".into(), skip: 0, limit: 10 },
        Req::Search { repo: repo.clone(), query: SearchQuery { content: vec!["two".into()], ..Default::default() }, hidden: vec![], limit: 10 },
    ];
    for req in reads.clone() {
        let name = format!("{req:?}");
        ok(handle(req));
        assert!(!ran(), "{name} ran repo-configured code");
    }

    // an external diff driver too (it takes precedence over textconv in plain git)
    git(&d, &["config", "diff.evil.command", tmp.path().join("extdiff.sh").to_str().unwrap()]);
    git(&d, &["-c", "core.fsmonitor=false", "show", &head]);
    assert!(ran(), "plain git show runs the external diff");
    for req in reads.clone() {
        let name = format!("{req:?}");
        ok(handle(req));
        assert!(!ran(), "{name} ran repo-configured code");
    }

    // filter drivers: b.txt is rewritten unchanged so it is stat-dirty and status must run the clean filter to
    // compare it (our reads never refresh the index, plain git below doesn't either)
    std::fs::write(d.join(".gitattributes"), "*.txt diff=evil filter=evil\n").unwrap();
    let plain_status = || {
        std::fs::write(d.join("b.txt"), "same\n").unwrap();
        Command::new("git").arg("-C").arg(&d).args(["-c", "core.fsmonitor=false", "--no-optional-locks", "status"]).output().unwrap();
    };
    script(&tmp.path().join("clean.sh"), &format!("touch '{m}'; cat"));
    script(&tmp.path().join("process.sh"), &format!("touch '{m}'; exit 1"));
    for (key, file) in [("filter.evil.clean", "clean.sh"), ("filter.evil.smudge", "clean.sh"), ("filter.evil.process", "process.sh")] {
        git(&d, &["config", key, tmp.path().join(file).to_str().unwrap()]);
        if key.ends_with("smudge") {
            continue;
        }
        plain_status();
        assert!(ran(), "plain git status runs {key}");
        for req in [&reads[0], &reads[3], &reads[4]] {
            let name = format!("{req:?}");
            std::fs::write(d.join("b.txt"), "same\n").unwrap();
            ok(handle(req.clone()));
            assert!(!ran(), "{name} ran {key}");
        }
    }
    git(&d, &["config", "--unset", "filter.evil.process"]);
    git(&d, &["config", "filter.evil.required", "true"]); // blanked too: required + empty would be a hard error
    for req in [&reads[0], &reads[3], &reads[4]] {
        std::fs::write(d.join("b.txt"), "same\n").unwrap();
        ok(handle(req.clone()));
        assert!(!ran(), "{req:?} ran filter.evil with required=true");
    }

    // a non-UTF-8 driver name cannot be named exactly in `-c`: reads are refused, the driver never runs
    let cfg = d.join(".git/config");
    let saved = std::fs::read(&cfg).unwrap();
    let clean = format!("\"]\n\tclean = {}\n", tmp.path().join("clean.sh").display());
    std::fs::write(&cfg, [&saved[..], b"[filter \"ev\xffil", clean.as_bytes()].concat()).unwrap();
    std::fs::write(d.join(".gitattributes"), b"*.txt filter=ev\xffil\n").unwrap();
    plain_status();
    assert!(ran(), "plain git status runs the non-UTF-8 named driver");
    for req in [&reads[0], &reads[3], &reads[4]] {
        std::fs::write(d.join("b.txt"), "same\n").unwrap();
        let r = handle(req.clone());
        assert!(matches!(&r, Resp::Err(e) if e.contains("unable to parse command-line config")), "{r:?}");
        assert!(!ran(), "{req:?} ran the non-UTF-8 named driver");
    }
    std::fs::write(&cfg, saved).unwrap();
    std::fs::write(d.join(".gitattributes"), "*.txt diff=evil filter=evil\n").unwrap();

    // writes keep the user's hooks and filters (but still never the fsmonitor hook)
    script(&d.join(".git/hooks/pre-commit"), &format!("touch '{m}'"));
    ok(handle(Req::Stage { repo: repo.clone(), paths: vec!["a.txt".into()] }));
    assert!(ran(), "stage runs the user's clean filter");
    ok(handle(Req::Commit { repo: repo.clone(), message: "third".into(), amend: false, signoff: false, no_verify: false }));
    assert!(ran(), "commit runs the pre-commit hook");

    // Ignore: a symlinked .gitignore pointing outside the repo is refused, its target untouched
    let outside = tmp.path().join("outside.txt");
    std::fs::write(&outside, "keep me\n").unwrap();
    std::os::unix::fs::symlink(&outside, d.join(".gitignore")).unwrap();
    let r = handle(Req::Ignore { repo: repo.clone(), path: "junk.log".into() });
    assert!(matches!(&r, Resp::Err(e) if e.contains("not a regular file")), "{r:?}");
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep me\n");
    assert!(std::fs::symlink_metadata(d.join(".gitignore")).unwrap().file_type().is_symlink());

    // a regular .gitignore: content kept, a newline added before the entry, no temp file left behind
    std::fs::remove_file(d.join(".gitignore")).unwrap();
    std::fs::write(d.join(".gitignore"), "existing").unwrap();
    ok(handle(Req::Ignore { repo: repo.clone(), path: "junk.log".into() }));
    ok(handle(Req::Ignore { repo: repo.clone(), path: "junk.log".into() }));
    assert_eq!(std::fs::read_to_string(d.join(".gitignore")).unwrap(), "existing\n/junk.log\n");
    assert!(std::fs::read_dir(&d).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")));
}

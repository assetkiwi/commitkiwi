//! Measurement (not a pass/fail test): Status and WorkDiff latency on a temp repo with 5000 tracked files, 1000 of
//! them modified, plus 1000 untracked; and how much of it the per-call `git config` takes.
//! `cargo test -p commitkiwi-core --release --test status_bench -- --ignored --nocapture`
use commitkiwi_protocol::{Req, Resp};
use std::process::Command;
use std::time::Instant;

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn ms(n: u32, f: impl Fn()) -> f64 {
    f();
    let t = Instant::now();
    for _ in 0..n {
        f();
    }
    t.elapsed().as_secs_f64() * 1000.0 / n as f64
}

#[test]
#[ignore = "measurement; run with --ignored --nocapture"]
fn status_latency() {
    unsafe {
        for (k, v) in [("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_SYSTEM", "/dev/null"), ("GIT_AUTHOR_NAME", "T"), ("GIT_AUTHOR_EMAIL", "t@x"), ("GIT_COMMITTER_NAME", "T"), ("GIT_COMMITTER_EMAIL", "t@x")] {
            std::env::set_var(k, v);
        }
    }
    let d = tempfile::tempdir().unwrap();
    let r = d.path();
    git(r, &["init", "-q", "."]);
    for i in 0..5000 {
        let sub = r.join(format!("d{}", i / 100));
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join(format!("f{i}.txt")), format!("line {i}\n")).unwrap();
    }
    git(r, &["add", "-A"]);
    git(r, &["commit", "-qm", "init"]);
    for i in 0..1000 {
        std::fs::write(r.join(format!("d{}/f{i}.txt", i / 100)), format!("line {i}\nchanged\n")).unwrap();
        std::fs::write(r.join(format!("d{}/u{i}.txt", i / 100)), "new\n").unwrap();
    }
    let repo = r.to_string_lossy().into_owned();
    let status = || match commitkiwi_core::handle(Req::Status { repo: repo.clone() }) {
        Resp::Status(s) => assert_eq!(s.files.len(), 2000),
        other => panic!("{other:?}"),
    };
    let work_diff = || match commitkiwi_core::handle(Req::WorkDiff {
        repo: repo.clone(), path: "d0/f1.txt".into(), old_path: None, staged: false, untracked: false, conflicted: false, context: 3, ignore_ws: false,
    }) {
        Resp::Diff(_) => {}
        other => panic!("{other:?}"),
    };
    let config = || {
        Command::new("git").arg("-C").arg(&repo).args(["config", "--includes", "--null", "--get-regexp", r"^(core\.fsmonitor|filter\..+\.(clean|smudge|process))$"]).output().unwrap();
    };
    let plain = || {
        Command::new("git").arg("-C").arg(&repo).env("GIT_OPTIONAL_LOCKS", "0").args(["status", "--porcelain=v2", "-z", "--untracked-files=all"]).output().unwrap();
    };
    println!(
        "Status {:.1} ms | WorkDiff {:.1} ms | one `git config` {:.1} ms | plain `git status` {:.1} ms",
        ms(20, status), ms(20, work_diff), ms(20, config), ms(20, plain)
    );
}

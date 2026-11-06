//! M8 measurement (not a pass/fail test): watcher vs 3 s status polling on a generated temp repo with many files.
//! `cargo test -p commitkiwi-core --release --test watch_bench -- --ignored --nocapture`
use commitkiwi_protocol::{Req, Resp};
use std::process::Command;
use std::time::{Duration, Instant};

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// (cpu seconds of this process, of reaped children, idle wakeups of this process (macOS; 0 elsewhere))
fn usage() -> (f64, f64, u64) {
    let cpu = |who| {
        let mut r: libc::rusage = unsafe { std::mem::zeroed() };
        unsafe { libc::getrusage(who, &mut r) };
        let t = |v: libc::timeval| v.tv_sec as f64 + v.tv_usec as f64 / 1e6;
        t(r.ru_utime) + t(r.ru_stime)
    };
    #[cfg(target_os = "macos")]
    let wake = {
        let mut ri: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
        let p = &mut ri as *mut _ as *mut libc::rusage_info_t;
        unsafe { libc::proc_pid_rusage(std::process::id() as i32, libc::RUSAGE_INFO_V2, p) };
        ri.ri_pkg_idle_wkups + ri.ri_interrupt_wkups
    };
    #[cfg(not(target_os = "macos"))]
    let wake = 0;
    (cpu(libc::RUSAGE_SELF), cpu(libc::RUSAGE_CHILDREN), wake)
}

#[test]
#[ignore = "measurement; run with --ignored --nocapture"]
fn watcher_vs_polling() {
    unsafe {
        for (k, v) in [("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_SYSTEM", "/dev/null"), ("GIT_AUTHOR_NAME", "T"), ("GIT_AUTHOR_EMAIL", "t@x"), ("GIT_COMMITTER_NAME", "T"), ("GIT_COMMITTER_EMAIL", "t@x")] {
            std::env::set_var(k, v);
        }
    }
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    let (dirs, per) = (3000, 10);
    for i in 0..dirs {
        let dir = p.join(format!("src/m{}/d{i}", i % 50));
        std::fs::create_dir_all(&dir).unwrap();
        for j in 0..per {
            std::fs::write(dir.join(format!("f{j}.txt")), format!("{i} {j}\n")).unwrap();
        }
    }
    for i in 0..2000 {
        std::fs::create_dir_all(p.join(format!("node_modules/pkg{i}/lib"))).unwrap();
        std::fs::write(p.join(format!("node_modules/pkg{i}/lib/index.js")), "x").unwrap();
    }
    std::fs::write(p.join(".gitignore"), "node_modules/\n").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "big"]);
    let repo = p.to_str().unwrap().to_string();
    println!("repo: {} tracked files in {} folders (+2000 ignored node_modules folders)", dirs * per, dirs + 51);

    let t = Instant::now();
    let (tx, rx) = std::sync::mpsc::channel();
    let w = commitkiwi_core::watch::watch(&repo, Box::new(move |c| { let _ = tx.send(c); })).expect("watch");
    println!("watcher start: {:?}", t.elapsed());
    std::thread::sleep(Duration::from_millis(500));

    let idle = Duration::from_secs(10);
    let (c0, k0, w0) = usage();
    let got = rx.recv_timeout(idle).ok();
    let (c1, k1, w1) = usage();
    println!("watcher idle {idle:?}: events {}, cpu self {:.4} s, children {:.4} s, idle+interrupt wakeups {}", got.is_some() as u8, c1 - c0, k1 - k0, w1 - w0);

    let t = Instant::now();
    std::fs::write(p.join("src/m1/d1/f1.txt"), "edit").unwrap();
    rx.recv_timeout(Duration::from_secs(2)).expect("event");
    println!("edit -> event: {:?}", t.elapsed());
    drop(w);

    // what 3 s polling costs over the same 10 s (4 polls, like the UI: t = 0, 3, 6, 9)
    let (c0, k0, _) = usage();
    let t = Instant::now();
    for _ in 0..4 {
        let s = Instant::now();
        assert!(matches!(commitkiwi_core::handle(Req::Status { repo: repo.clone() }), Resp::Status(_)));
        println!("  status poll: {:?}", s.elapsed());
    }
    let busy = t.elapsed();
    let (c1, k1, _) = usage();
    println!("polling 10 s (4 status calls): busy {busy:?}, cpu self {:.4} s, git children {:.4} s", c1 - c0, k1 - k0);
}

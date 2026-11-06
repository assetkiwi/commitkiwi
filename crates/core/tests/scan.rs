//! ScanRepos over a fake tree (repos are just `.git` dirs/files; the scan never runs git).
use commitkiwi_core::handle;
use commitkiwi_protocol::*;
use std::fs;

#[test]
fn scan_repos() {
    let tmp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(tmp.path()).unwrap(); // macOS: /var -> /private/var, the scan reports real paths
    let mk = |p: &str| fs::create_dir_all(root.join(p)).unwrap();
    mk("a/.git");
    mk("a/inner/.git"); // inside a found repo: not reported
    mk("group/b/.git");
    mk("group/wt");
    fs::write(root.join("group/wt/.git"), "gitdir: /elsewhere/.git/worktrees/wt\n").unwrap(); // worktree
    mk("node_modules/pkg/.git");
    mk("vendor/lib/.git");
    mk(".cache/c/.git");
    mk("x/y/z/deep/.git"); // depth 4
    mk("x/y/three/.git"); // depth 3
    mk("plain/dir");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&root, root.join("plain/loop")).unwrap(); // a loop back to the root
        std::os::unix::fs::symlink(root.join("a"), root.join("link-to-a")).unwrap();
    }

    let scan = |depth| {
        let Resp::Scan(s) = handle(Req::ScanRepos { root: root.to_string_lossy().into(), depth }) else { panic!() };
        s
    };
    let rel = |s: &Scan| s.paths.iter().map(|p| p.strip_prefix(&*root.to_string_lossy()).unwrap().to_string()).collect::<Vec<_>>();
    let s = scan(3);
    assert!(!s.truncated);
    assert_eq!(rel(&s), ["/a", "/group/b", "/group/wt", "/x/y/three"]);
    assert_eq!(rel(&scan(4)), ["/a", "/group/b", "/group/wt", "/x/y/three", "/x/y/z/deep"]);
    assert_eq!(rel(&scan(1)), ["/a"]);
    // the root itself being a repo
    let Resp::Scan(s) = handle(Req::ScanRepos { root: root.join("a").to_string_lossy().into(), depth: 3 }) else { panic!() };
    assert_eq!(s.paths.len(), 1);
    assert!(matches!(handle(Req::ScanRepos { root: root.join("nope").to_string_lossy().into(), depth: 3 }), Resp::Err(_)));
}

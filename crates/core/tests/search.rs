//! `Search` against a temp repo: every filter, hidden refs, the limit, and hostile-looking values.
//! Single test on purpose: it sets process env (isolating from the developer's git config).
use commitkiwi_core::handle;
use commitkiwi_protocol::*;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str], date: &str) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).env("GIT_AUTHOR_DATE", date).env("GIT_COMMITTER_DATE", date).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(dir: &Path, file: &str, body: &str, msg: &str, author: &str, date: &str) -> String {
    std::fs::write(dir.join(file), body).unwrap();
    git(dir, &["add", "."], date);
    git(dir, &["commit", "-q", "--author", author, "-m", msg], date);
    git(dir, &["rev-parse", "HEAD"], date)
}

fn rows(repo: &str, query: SearchQuery, hidden: &[&str], limit: u32) -> Result<SearchResult, String> {
    match handle(Req::Search { repo: repo.into(), query, hidden: hidden.iter().map(|s| s.to_string()).collect(), limit }) {
        Resp::Search(r) => Ok(r),
        Resp::Err(e) => Err(e),
        other => panic!("{other:?}"),
    }
}

/// Subjects of the matching rows, via `Log` (proves the rows index the commit list).
fn subjects(repo: &str, q: SearchQuery) -> Vec<String> {
    let r = rows(repo, q, &[], 1000).unwrap();
    let Resp::Log(all) = handle(Req::Log { repo: repo.into(), skip: 0, limit: 100, hidden: vec![] }) else { panic!() };
    r.rows.iter().map(|&i| all[i as usize].subject.clone()).collect()
}

#[test]
fn search_filters() {
    // SAFETY: only test in this binary, so nothing else reads env concurrently.
    unsafe {
        for (k, v) in [("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_SYSTEM", "/dev/null"), ("GIT_COMMITTER_NAME", "C"), ("GIT_COMMITTER_EMAIL", "c@x")] {
            std::env::set_var(k, v);
        }
    }
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path().join("repo");
    std::fs::create_dir(&d).unwrap();
    let repo = d.to_str().unwrap();
    git(&d, &["init", "-q", "-b", "main"], "2020-01-01T00:00:00Z");
    let a = commit(&d, "a.txt", "hello world", "Add greeting", "Ann Smith <ann@example.com>", "2020-01-10T12:00:00Z");
    std::fs::create_dir(d.join("src")).unwrap();
    commit(&d, "src/lib.rs", "fn main() {}", "[T-1]: Add lib\n\nLonger body mentions Redis", "Bob Jones <bob@example.com>", "2021-06-01T12:00:00Z");
    commit(&d, "--output=x", "weird name", "Weird file", "Ann Smith <ann@example.com>", "2022-03-01T12:00:00Z");
    git(&d, &["checkout", "-q", "-b", "side"], "2022-03-02T00:00:00Z");
    commit(&d, "a.txt", "goodbye world", "Side change", "Bob Jones <bob@example.com>", "2023-01-01T12:00:00Z");
    git(&d, &["checkout", "-q", "main"], "2023-01-02T00:00:00Z");
    let q = SearchQuery::default;

    // free text: message (subject and body), author, email, hash prefix; case-insensitive
    assert_eq!(subjects(repo, SearchQuery { text: vec!["GREETING".into()], ..q() }), ["Add greeting"]);
    assert_eq!(subjects(repo, SearchQuery { text: vec!["redis".into()], ..q() }), ["[T-1]: Add lib"]);
    assert_eq!(subjects(repo, SearchQuery { text: vec!["bob@".into()], ..q() }), ["Side change", "[T-1]: Add lib"]);
    assert_eq!(subjects(repo, SearchQuery { text: vec![a[..7].into()], ..q() }), ["Add greeting"]);
    // several terms: all must match
    assert_eq!(subjects(repo, SearchQuery { text: vec!["add".into(), "ann".into()], ..q() }), ["Add greeting"]);
    // keywords
    assert_eq!(subjects(repo, SearchQuery { message: vec!["add".into()], ..q() }), ["[T-1]: Add lib", "Add greeting"]);
    assert!(subjects(repo, SearchQuery { message: vec!["ann".into()], ..q() }).is_empty()); // author is not the message
    assert_eq!(subjects(repo, SearchQuery { author: vec!["ann".into()], ..q() }), ["Weird file", "Add greeting"]);
    assert_eq!(subjects(repo, SearchQuery { commit: vec![a[..10].to_uppercase()], ..q() }), ["Add greeting"]);
    assert_eq!(subjects(repo, SearchQuery { file: vec!["a.txt".into()], ..q() }), ["Side change", "Add greeting"]);
    assert_eq!(subjects(repo, SearchQuery { file: vec!["src".into()], ..q() }), ["[T-1]: Add lib"]); // a folder
    assert_eq!(subjects(repo, SearchQuery { content: vec!["goodbye".into()], ..q() }), ["Side change"]);
    assert_eq!(subjects(repo, SearchQuery { after: Some("2021-01-01".into()), ..q() }), ["Side change", "Weird file", "[T-1]: Add lib"]);
    assert_eq!(subjects(repo, SearchQuery { before: Some("2021-01-01".into()), ..q() }), ["Add greeting"]);
    assert_eq!(
        subjects(repo, SearchQuery { after: Some("2021-01-01".into()), before: Some("2022-12-31".into()), author: vec!["bob".into()], ..q() }),
        ["[T-1]: Add lib"]
    );

    // hostile values are data, never options: a file literally called `--output=x`, -S of `--output=x`, odd dates
    assert_eq!(subjects(repo, SearchQuery { file: vec!["--output=x".into()], ..q() }), ["Weird file"]);
    assert!(subjects(repo, SearchQuery { content: vec!["--output=x".into()], ..q() }).is_empty());
    assert!(subjects(repo, SearchQuery { text: vec!["--output=x".into()], ..q() }).is_empty());
    let _ = rows(repo, SearchQuery { after: Some("--output=x".into()), ..q() }, &[], 10); // git may accept or refuse; it must not write
    assert!(subjects(repo, SearchQuery { file: vec!["*.txt".into()], ..q() }).is_empty()); // literal pathspec, not a glob
    assert!(!d.join("x").exists() && !Path::new("x").exists());
    assert!(rows(repo, SearchQuery { commit: vec!["--output=x".into()], ..q() }, &[], 10).is_err());
    assert!(rows(repo, SearchQuery { commit: vec!["xyz".into()], ..q() }, &[], 10).is_err());
    assert!(rows(repo, SearchQuery { content: vec!["a".into(), "b".into()], ..q() }, &[], 10).is_err());
    assert!(rows(repo, SearchQuery { text: vec!["a\0b".into()], ..q() }, &[], 10).is_err());
    assert!(rows(repo, q(), &[], 10).is_err()); // nothing to search for
    assert!(rows(repo, SearchQuery { text: vec!["a".into()], ..q() }, &["--output=x"], 10).is_err()); // bad hidden ref

    // hidden refs are respected; the limit truncates
    let r = rows(repo, SearchQuery { text: vec!["side".into()], ..q() }, &["refs/heads/side"], 10).unwrap();
    assert!(r.rows.is_empty());
    let r = rows(repo, SearchQuery { author: vec!["example.com".into()], ..q() }, &[], 2).unwrap();
    assert_eq!((r.rows.len(), r.truncated), (2, true));
    let r = rows(repo, SearchQuery { author: vec!["example.com".into()], ..q() }, &[], 4).unwrap();
    assert_eq!((r.rows, r.truncated), (vec![0, 1, 2, 3], false));
}

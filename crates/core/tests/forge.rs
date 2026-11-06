//! Pull/merge requests: `ForgeProbe` and `ForgeCreate` against FAKE `gh`/`glab` scripts first on a temp PATH (they
//! record their argv, stdin and env). Remotes are github/gitlab URLs that are never contacted (nothing fetches).
//! Single test: it sets process env (isolated git config, PATH).
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

fn commit(dir: &Path, file: &str, msg: &str) -> String {
    std::fs::write(dir.join(file), msg).unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", msg]);
    git(dir, &["rev-parse", "HEAD"])
}

fn probe(repo: &str, source: Option<&str>, target: Option<&str>, forge: Option<Forge>, cli_path: Option<&str>) -> ForgeInfo {
    let req = Req::ForgeProbe {
        repo: repo.into(),
        remote: "origin".into(),
        source: source.map(Into::into),
        target: target.map(Into::into),
        forge,
        host: forge.map(|_| "github.com".into()),
        cli_path: cli_path.map(Into::into),
    };
    match handle(req) {
        Resp::Forge(f) => f,
        other => panic!("{other:?}"),
    }
}

fn err(r: Resp) -> String {
    match r {
        Resp::Err(e) => e,
        other => panic!("expected an error, got {other:?}"),
    }
}

/// What the fake CLI got as argv (NUL-separated, so newlines in values survive).
fn argv(log: &Path) -> Vec<String> {
    let raw = std::fs::read_to_string(log.join("argv")).unwrap();
    raw.split('\0').filter(|s| !s.is_empty()).map(String::from).collect()
}

/// A fake `gh`/`glab`: `auth` answers from the `logged-in` marker; `create` records argv/stdin/env, then prints a
/// URL, fails (`fail` marker) or hangs (`hang` marker).
fn fake_cli(bin: &Path, log: &Path, name: &str, url: &str) {
    let l = log.display();
    let script = format!(
        r#"#!/bin/sh
if [ "$1" = auth ]; then
  printf '%s\0' "$@" > {l}/auth-argv
  if [ -f {l}/logged-in ]; then echo "Logged in to github.com account me"; exit 0; fi
  echo "You are not logged into any hosts. To log in, run: {name} auth login" >&2; exit 1
fi
printf '%s\0' "$@" > {l}/argv
if read -r line; then echo "stdin:$line" > {l}/stdin; else echo eof > {l}/stdin; fi
echo "$GH_PROMPT_DISABLED $NO_COLOR $GH_NO_UPDATE_NOTIFIER $GLAB_SEND_TELEMETRY" > {l}/env
[ -f {l}/hang ] && sleep 30
if [ -f {l}/fail ]; then echo "pull request create failed: No commits between main and feature" >&2; exit 1; fi
echo "Creating request in o/r" >&2
echo "{url}"
"#
    );
    let p = bin.join(name);
    std::fs::write(&p, script).unwrap();
    Command::new("chmod").arg("755").arg(&p).status().unwrap();
}

fn request(repo: &str, forge: Forge) -> ForgeRequest {
    ForgeRequest {
        repo: repo.into(),
        forge,
        host: if forge == Forge::Github { "github.com".into() } else { "gitlab.example.com".into() },
        project: if forge == Forge::Github { "o/r".into() } else { "group/sub/proj".into() },
        cli_path: None,
        source: "feature".into(),
        target: "main".into(),
        title: "Add feature".into(),
        body: "Body".into(),
        draft: false,
        remove_source_branch: false,
        squash: false,
        reviewers: vec![],
        labels: vec![],
        assignees: vec![],
    }
}

#[test]
fn forge() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().canonicalize().unwrap();
    let (bin, log, repo_dir) = (root.join("bin"), root.join("log"), root.join("repo"));
    for p in [&bin, &log, &repo_dir] {
        std::fs::create_dir(p).unwrap();
    }
    fake_cli(&bin, &log, "gh", "https://github.com/o/r/pull/7");
    fake_cli(&bin, &log, "glab", "https://gitlab.example.com/group/sub/proj/-/merge_requests/3");
    // SAFETY: only test in this binary; set before any thread starts.
    unsafe {
        for (k, v) in [
            ("GIT_CONFIG_GLOBAL", "/dev/null"),
            ("GIT_CONFIG_SYSTEM", "/dev/null"),
            ("GIT_AUTHOR_NAME", "Tester"),
            ("GIT_AUTHOR_EMAIL", "t@example.com"),
            ("GIT_COMMITTER_NAME", "Tester"),
            ("GIT_COMMITTER_EMAIL", "t@example.com"),
        ] {
            std::env::set_var(k, v);
        }
        std::env::set_var("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()));
    }
    let r = &repo_dir;
    let repo = r.to_str().unwrap();
    git(r, &["init", "-q", "-b", "main"]);
    let base = commit(r, "a.txt", "base");
    git(r, &["remote", "add", "origin", "https://github.com/o/r.git"]);
    // remote-tracking refs as a fetch would leave them (nothing is ever fetched)
    git(r, &["update-ref", "refs/remotes/origin/main", &base]);
    git(r, &["update-ref", "refs/remotes/origin/develop", &base]);
    git(r, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
    git(r, &["checkout", "-q", "-b", "feature"]);
    let one = commit(r, "b.txt", "Add the b file");
    git(r, &["update-ref", "refs/remotes/origin/feature", &one]);
    git(r, &["branch", "-q", "--set-upstream-to=origin/feature"]);
    std::fs::write(r.join("c.txt"), "c").unwrap();
    git(r, &["add", "."]);
    git(r, &["commit", "-q", "-m", "Add c\n\nWhy c matters.\nSecond line."]);

    // ---- probe: default branch from origin/HEAD, upstream, ahead, the commits, no CLI asked
    let p = probe(repo, None, None, None, None);
    assert_eq!(p.remote_url, "https://github.com/o/r.git");
    assert_eq!((p.default_branch.as_deref(), p.current_branch.as_deref(), p.source.as_deref()), (Some("develop"), Some("feature"), Some("feature")));
    assert_eq!((p.upstream.as_deref(), p.ahead), (Some("refs/remotes/origin/feature"), Some(1)));
    assert_eq!(p.remote_branches, ["develop", "feature", "main"]);
    let subjects: Vec<_> = p.commits.iter().map(|c| (c.subject.as_str(), c.body.as_str())).collect();
    assert_eq!(subjects, [("Add c", "Why c matters.\nSecond line."), ("Add the b file", "")]);
    assert_eq!(p.cli, None);
    // no origin/HEAD: main (on the remote) wins; an explicit target narrows the commits
    git(r, &["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    let p = probe(repo, None, Some("feature"), None, None);
    assert_eq!(p.default_branch.as_deref(), Some("main"));
    assert_eq!(p.commits.len(), 1);
    // a branch the remote does not have: no upstream, ahead unknown (push first)
    git(r, &["branch", "-q", "local-only"]);
    let p = probe(repo, Some("local-only"), None, None, None);
    assert_eq!((p.upstream, p.ahead, p.commits.len()), (None, None, 2));
    assert!(err(handle(Req::ForgeProbe { repo: repo.into(), remote: "nope".into(), source: None, target: None, forge: None, host: None, cli_path: None })).contains("no remote"));
    assert!(err(handle(Req::ForgeProbe { repo: repo.into(), remote: "origin".into(), source: Some("--web".into()), target: None, forge: None, host: None, cli_path: None })).contains("not a valid name"));

    // ---- the CLI: missing (an override that is not there), installed but not logged in, logged in
    let cli = probe(repo, None, None, Some(Forge::Github), Some("/nonexistent/gh")).cli.unwrap();
    assert_eq!((cli.installed, cli.authenticated, cli.path), (false, false, None));
    let cli = probe(repo, None, None, Some(Forge::Github), None).cli.unwrap();
    assert_eq!((cli.name.as_str(), cli.installed, cli.authenticated), ("gh", true, false));
    assert_eq!(cli.path.as_deref(), Some(bin.join("gh").to_str().unwrap()));
    assert!(cli.detail.contains("gh auth login"), "{}", cli.detail);
    let auth_argv = std::fs::read_to_string(log.join("auth-argv")).unwrap();
    assert_eq!(auth_argv, "auth\0status\0--hostname=github.com\0");
    std::fs::write(log.join("logged-in"), "").unwrap();
    assert!(probe(repo, None, None, Some(Forge::Github), None).cli.unwrap().authenticated);
    let bad_host = Req::ForgeProbe { repo: repo.into(), remote: "origin".into(), source: None, target: None, forge: Some(Forge::Github), host: Some("-oX".into()), cli_path: None };
    assert!(err(handle(bad_host)).contains("not a host"));

    // ---- create via gh: exact argv, `--flag=value` forms, stdin closed, quiet env, the URL back
    let mut q = request(repo, Forge::Github);
    q.title = "--web".into();
    q.body = "$(touch pwned)\n; touch pwned\n`touch pwned`\n-x".into();
    q.draft = true;
    q.reviewers = vec!["alice".into(), "org/team".into()];
    q.labels = vec!["bug".into()];
    q.assignees = vec!["@me".into()];
    match handle(Req::ForgeCreate(q.clone())) {
        Resp::Created { url, output } => {
            assert_eq!(url.as_deref(), Some("https://github.com/o/r/pull/7"));
            assert!(output.contains("pull/7"));
        }
        other => panic!("{other:?}"),
    }
    let want = [
        "pr", "create", "--repo=github.com/o/r", "--head=feature", "--base=main", "--title=--web",
        "--body=$(touch pwned)\n; touch pwned\n`touch pwned`\n-x", "--draft", "--reviewer=alice,org/team", "--label=bug", "--assignee=@me",
    ];
    assert_eq!(argv(&log), want);
    assert_eq!(std::fs::read_to_string(log.join("stdin")).unwrap().trim(), "eof");
    assert_eq!(std::fs::read_to_string(log.join("env")).unwrap().trim(), "1 1 1 0");
    for dir in [r.as_path(), root.as_path(), log.as_path()] {
        assert!(!dir.join("pwned").exists(), "something ran through a shell in {}", dir.display());
    }
    // a branch name git accepts but a shell would split
    let mut q2 = request(repo, Forge::Github);
    q2.source = "b;id".into();
    assert!(matches!(handle(Req::ForgeCreate(q2)), Resp::Created { .. }));
    assert_eq!(argv(&log)[3], "--head=b;id");

    // ---- create via glab: host:port and nested groups as a full URL, GitLab extras, --yes/--push=false
    let mut g = request(repo, Forge::Gitlab);
    g.host = "gitlab.example.com:8443".into();
    (g.remove_source_branch, g.squash, g.draft) = (true, true, true);
    match handle(Req::ForgeCreate(g)) {
        Resp::Created { url, .. } => assert_eq!(url.as_deref(), Some("https://gitlab.example.com/group/sub/proj/-/merge_requests/3")),
        other => panic!("{other:?}"),
    }
    let want = [
        "mr", "create", "--repo=https://gitlab.example.com:8443/group/sub/proj", "--source-branch=feature", "--target-branch=main", "--title=Add feature",
        "--description=Body", "--draft", "--remove-source-branch", "--squash-before-merge", "--yes", "--push=false",
    ];
    assert_eq!(argv(&log), want);

    // ---- refused before anything runs
    std::fs::remove_file(log.join("argv")).unwrap();
    let refuse = |f: &dyn Fn(&mut ForgeRequest)| {
        let mut q = request(repo, Forge::Github);
        f(&mut q);
        err(handle(Req::ForgeCreate(q)))
    };
    refuse(&|q| q.source = "--web".into());
    refuse(&|q| q.target = "has space".into());
    refuse(&|q| q.target = "feature".into()); // same as the source
    refuse(&|q| q.title = "a\0b".into());
    refuse(&|q| q.title = "two\nlines".into());
    refuse(&|q| q.title = "t".repeat(257));
    refuse(&|q| q.body = "nul\0".into());
    refuse(&|q| q.body = "b".repeat(60_001));
    refuse(&|q| q.reviewers = vec!["--web".into()]);
    refuse(&|q| q.labels = vec!["a b".into()]);
    refuse(&|q| q.assignees = vec!["$(id)".into()]);
    refuse(&|q| q.project = "o/r;id".into());
    refuse(&|q| q.squash = true); // gh has no squash option
    assert!(refuse(&|q| q.cli_path = Some("/nonexistent/gh".into())).contains("not installed"));
    assert!(!log.join("argv").exists(), "a refused request ran the CLI");

    // ---- the CLI fails: its stderr is the error
    std::fs::write(log.join("fail"), "").unwrap();
    assert!(err(handle(Req::ForgeCreate(request(repo, Forge::Github)))).contains("No commits between"));
    std::fs::remove_file(log.join("fail")).unwrap();

    // ---- as a console job: output streams, Cancel kills a hanging CLI
    let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let s2 = seen.clone();
    let sink: commitkiwi_core::Sink = std::sync::Arc::new(move |t: &str| s2.lock().unwrap().push_str(t));
    let job = Req::Job { job: 77, req: Box::new(Req::ForgeCreate(request(repo, Forge::Github))) };
    assert!(matches!(commitkiwi_core::handle_with(job, Some(sink)), Resp::Created { .. }));
    assert!(seen.lock().unwrap().contains("Creating request"), "{}", seen.lock().unwrap());
    std::fs::write(log.join("hang"), "").unwrap();
    let started = Instant::now();
    let t = std::thread::spawn(move || commitkiwi_core::handle_with(Req::Job { job: 78, req: Box::new(Req::ForgeCreate(request(repo_dir.to_str().unwrap(), Forge::Github))) }, None));
    std::thread::sleep(Duration::from_millis(400));
    cancel(78);
    assert_eq!(err(t.join().unwrap()), CANCELLED);
    assert!(started.elapsed() < Duration::from_secs(10));
}

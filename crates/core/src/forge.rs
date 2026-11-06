//! Pull/merge requests through the user's own `gh` (GitHub) and `glab` (GitLab): they hold the login, we store no
//! tokens and call no API ourselves. Runs where the repo lives (the agent on a remote box), argv only, no shell,
//! stdin closed, prompts and update checks off.
use super::{exists, expand, git, local_branch, ref_name, remote_name, run_step};
use commitkiwi_protocol::{CommitText, Forge, ForgeCli, ForgeInfo, ForgeRequest, Resp};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Where CLIs usually are when a GUI app's PATH leaves them out (searched after PATH).
const CLI_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin", "/usr/bin", "~/bin"];
const AUTH_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_COMMITS: usize = 50;
const MAX_TITLE: usize = 256;
const MAX_BODY: usize = 60_000;
const MAX_LIST: usize = 20;

/// Each CLI's command and flag names (a renamed flag is a one-line fix here). Valued flags are passed as
/// `--flag=value`, so a value starting with `-` can never become an option.
struct Flags {
    program: &'static str,
    command: [&'static str; 2],
    repo: &'static str,
    source: &'static str,
    target: &'static str,
    title: &'static str,
    body: &'static str,
    draft: &'static str,
    reviewer: &'static str,
    label: &'static str,
    assignee: &'static str,
    /// GitLab only (None: the CLI has no such option).
    remove_source_branch: Option<&'static str>,
    squash: Option<&'static str>,
    /// Always passed: never ask, never push on its own.
    always: &'static [&'static str],
}

const GH: Flags = Flags {
    program: "gh",
    command: ["pr", "create"],
    repo: "--repo",
    source: "--head",
    target: "--base",
    title: "--title",
    body: "--body",
    draft: "--draft",
    reviewer: "--reviewer",
    label: "--label",
    assignee: "--assignee",
    remove_source_branch: None,
    squash: None,
    always: &[],
};

const GLAB: Flags = Flags {
    program: "glab",
    command: ["mr", "create"],
    repo: "--repo",
    source: "--source-branch",
    target: "--target-branch",
    title: "--title",
    body: "--description",
    draft: "--draft",
    reviewer: "--reviewer",
    label: "--label",
    assignee: "--assignee",
    remove_source_branch: Some("--remove-source-branch"),
    squash: Some("--squash-before-merge"),
    always: &["--yes", "--push=false"],
};

fn flags(forge: Forge) -> &'static Flags {
    match forge {
        Forge::Github => &GH,
        Forge::Gitlab => &GLAB,
    }
}

fn executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The CLI: the user's path when set (absolute; missing = not installed, no search), else the first executable
/// `program` on PATH, then in `CLI_DIRS`.
fn find_cli(program: &str, over: Option<&str>) -> Result<Option<PathBuf>, String> {
    if let Some(p) = over.map(str::trim).filter(|p| !p.is_empty()) {
        let p = expand(p);
        if !p.starts_with('/') || p.chars().any(char::is_control) {
            return Err(format!("the {program} path must be absolute: {p:?}"));
        }
        return Ok(executable(Path::new(&p)).then(|| p.into()));
    }
    let path = std::env::var("PATH").unwrap_or_default();
    let dirs = path.split(':').filter(|d| d.starts_with('/')).map(String::from).chain(CLI_DIRS.iter().map(|d| expand(d)));
    Ok(dirs.map(|d| Path::new(&d).join(program)).find(|p| executable(p)))
}

/// The CLI without a shell, in the repo, stdin closed, nothing that could make it prompt, page or phone home.
fn cli_cmd(cli: &Path, repo: &str) -> Command {
    let mut c = Command::new(cli);
    c.current_dir(expand(repo))
        .stdin(Stdio::null())
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_PAGER", "cat")
        .env("NO_COLOR", "1")
        .env("NO_PROMPT", "true")
        .env("GLAB_SEND_TELEMETRY", "0")
        .env("GLAB_CHECK_UPDATE", "false")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("PAGER", "cat");
    c
}

/// `github.com`, `gitlab.example.com:8443`: what `--hostname` and `--repo` get.
fn check_host(host: &str) -> Result<&str, String> {
    let (name, port) = host.split_once(':').unwrap_or((host, "0"));
    let ok = !name.is_empty()
        && !name.starts_with(['-', '.'])
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        && !port.is_empty()
        && port.len() <= 5
        && port.bytes().all(|b| b.is_ascii_digit());
    if ok { Ok(host) } else { Err(format!("not a host name: {host:?}")) }
}

/// Logged in to `host`? `<cli> auth status --hostname=<host>` (read-only), killed after `AUTH_TIMEOUT`.
/// Returns the verdict and the CLI's message (trimmed, capped).
fn auth(cli: &Path, repo: &str, host: &str) -> (bool, String) {
    let name = host.split(':').next().unwrap_or(host);
    let mut c = cli_cmd(cli, repo);
    c.args(["auth", "status", &format!("--hostname={name}")]).stdout(Stdio::piped()).stderr(Stdio::piped());
    let Ok(mut child) = c.spawn() else { return (false, "could not run the auth check".into()) };
    let start = Instant::now();
    let ok = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s.success()),
            Ok(None) if start.elapsed() < AUTH_TIMEOUT => std::thread::sleep(Duration::from_millis(30)),
            _ => {
                let _ = child.kill();
                break None;
            }
        }
    };
    let out = child.wait_with_output().map(|o| format!("{}{}", String::from_utf8_lossy(&o.stderr), String::from_utf8_lossy(&o.stdout))).unwrap_or_default();
    let detail: String = out.trim().chars().take(600).collect();
    match ok {
        Some(ok) => (ok, detail),
        None => (false, "the auth check timed out".into()),
    }
}

pub(crate) fn probe(repo: &str, remote: &str, (source, target): (Option<&str>, Option<&str>), cli: Option<(Forge, &str)>, cli_path: Option<&str>) -> Result<ForgeInfo, String> {
    let remote = remote_name(repo, remote)?;
    let remote_url = git(repo, &["remote", "get-url", "--", remote])?.trim().to_string();
    let line = |args: &[&str]| git(repo, args).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let current_branch = line(&["symbolic-ref", "-q", "--short", "HEAD"]);
    let prefix = format!("refs/remotes/{remote}/");
    let remote_branches: Vec<String> = git(repo, &["for-each-ref", "--format=%(refname)", &prefix])?
        .lines()
        .filter_map(|l| l.strip_prefix(prefix.as_str()))
        .filter(|b| *b != "HEAD")
        .map(String::from)
        .collect();
    let default_branch = line(&["symbolic-ref", "-q", &format!("{prefix}HEAD")])
        .and_then(|s| s.strip_prefix(prefix.as_str()).map(String::from))
        .or_else(|| ["main", "master"].into_iter().find(|b| remote_branches.iter().any(|r| r == b) || exists(repo, &format!("refs/heads/{b}"))).map(String::from));
    let source = match source {
        Some(s) => Some(local_branch(repo, s)?.to_string()),
        None => current_branch.clone(),
    };
    let (mut upstream, mut ahead, mut commits) = (None, None, Vec::new());
    if let Some(s) = &source {
        let head = format!("refs/heads/{s}");
        upstream = line(&["for-each-ref", "--format=%(upstream)", &head]);
        // the source's branch on this remote: its upstream when that is there, else the same name
        let on_remote = upstream.clone().filter(|u| u.starts_with(&prefix)).unwrap_or_else(|| format!("{prefix}{s}"));
        if exists(repo, &on_remote) {
            let n = git(repo, &["rev-list", "--count", &format!("{on_remote}..{head}"), "--"])?;
            ahead = Some(n.trim().parse().map_err(|e| format!("bad count: {e}"))?);
        }
        let target = target.map(str::to_string).or_else(|| default_branch.clone());
        if let Some(t) = target {
            let t = ref_name(repo, "refs/heads/", &t)?;
            let base = [format!("{prefix}{t}"), format!("refs/heads/{t}")].into_iter().find(|r| exists(repo, r));
            if let Some(base) = base {
                let n = MAX_COMMITS.to_string();
                let out = git(repo, &["log", "--no-merges", "--no-ext-diff", "--no-textconv", "-n", &n, "--format=%s%x1f%b%x1e", &format!("{base}..{head}"), "--"])?;
                commits = out
                    .split('\x1e')
                    .filter_map(|r| r.trim_start_matches('\n').split_once('\x1f'))
                    .map(|(s, b)| CommitText { subject: s.to_string(), body: b.trim_end().to_string() })
                    .collect();
            }
        }
    }
    let cli = match cli {
        None => None,
        Some((forge, host)) => {
            let host = check_host(host)?;
            let program = flags(forge).program;
            let path = find_cli(program, cli_path)?;
            let (authenticated, detail) = match &path {
                Some(p) => auth(p, repo, host),
                None => (false, format!("{program} is not installed here")),
            };
            Some(ForgeCli { name: program.into(), installed: path.is_some(), path: path.map(|p| p.to_string_lossy().into_owned()), authenticated, detail })
        }
    };
    Ok(ForgeInfo { remote_url, default_branch, current_branch, source, upstream, ahead, remote_branches, commits, cli })
}

/// `owner/name` (GitHub: exactly two parts) or `group/sub/project`: plain path parts only.
fn check_project(forge: Forge, project: &str) -> Result<&str, String> {
    let parts: Vec<&str> = project.split('/').collect();
    let part = |p: &&str| !p.is_empty() && !p.starts_with(['-', '.']) && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b));
    let count = if forge == Forge::Github { parts.len() == 2 } else { parts.len() >= 2 };
    if count && parts.iter().all(part) { Ok(project) } else { Err(format!("not a project path: {project:?}")) }
}

/// Reviewers, labels, assignees: plain names (`@me`, `org/team`), joined with commas into one `--flag=a,b`.
fn check_list(what: &str, list: &[String]) -> Result<Option<String>, String> {
    if list.len() > MAX_LIST {
        return Err(format!("too many {what}"));
    }
    for v in list {
        let ok = !v.is_empty() && v.len() <= 100 && !v.starts_with('-') && v.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.@/-".contains(&b));
        if !ok {
            return Err(format!("not a valid name in {what}: {v:?}"));
        }
    }
    Ok((!list.is_empty()).then(|| list.join(",")))
}

/// The CLI's argv (after the program) for a checked request.
fn argv(r: &ForgeRequest) -> Result<Vec<String>, String> {
    let f = flags(r.forge);
    let host = check_host(&r.host)?;
    let project = check_project(r.forge, &r.project)?;
    let title = r.title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE || title.chars().any(char::is_control) {
        return Err(format!("The title must be one line of 1 to {MAX_TITLE} characters."));
    }
    if r.body.len() > MAX_BODY || r.body.contains('\0') {
        return Err(format!("The description must be at most {MAX_BODY} bytes, without NUL characters."));
    }
    if r.body.trim() == "-" {
        // glab reads `--description=-` as "open an editor"
        return Err("The description cannot be just \"-\".".into());
    }
    let repo = match r.forge {
        Forge::Github => format!("{host}/{project}"),
        // glab reads a 3-part `a/b/c` as group/sub/project on its default host: the full URL is unambiguous
        Forge::Gitlab => format!("https://{host}/{project}"),
    };
    let kv = |k: &str, v: &str| format!("{k}={v}");
    let mut a: Vec<String> = f.command.iter().map(|s| s.to_string()).collect();
    a.extend([kv(f.repo, &repo), kv(f.source, &r.source), kv(f.target, &r.target), kv(f.title, title), kv(f.body, &r.body)]);
    if r.draft {
        a.push(f.draft.into());
    }
    for (on, flag) in [(r.remove_source_branch, f.remove_source_branch), (r.squash, f.squash)] {
        match (on, flag) {
            (true, Some(flag)) => a.push(flag.into()),
            (true, None) => return Err(format!("{} has no such option", f.program)),
            _ => {}
        }
    }
    for (what, list, flag) in [("reviewers", &r.reviewers, f.reviewer), ("labels", &r.labels, f.label), ("assignees", &r.assignees, f.assignee)] {
        if let Some(v) = check_list(what, list)? {
            a.push(kv(flag, &v));
        }
    }
    a.extend(f.always.iter().map(|s| s.to_string()));
    Ok(a)
}

/// The first `https://` URL in the CLI's output (the created request).
fn created_url(out: &str) -> Option<String> {
    let i = out.find("https://")?;
    let url: String = out[i..].chars().take_while(|c| !c.is_whitespace() && !c.is_control()).collect();
    Some(url)
}

pub(crate) fn create(r: &ForgeRequest) -> Result<Resp, String> {
    let (source, target) = (ref_name(&r.repo, "refs/heads/", &r.source)?, ref_name(&r.repo, "refs/heads/", &r.target)?);
    if source == target {
        return Err("The source and target branch are the same.".into());
    }
    let argv = argv(r)?;
    let program = flags(r.forge).program;
    let cli = find_cli(program, r.cli_path.as_deref())?.ok_or_else(|| format!("{program} is not installed where this repository is"))?;
    let mut cmd = cli_cmd(&cli, &r.repo);
    cmd.args(&argv);
    let output = run_step(cmd, program, None)?;
    Ok(Resp::Created { url: created_url(&output), output })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(forge: Forge) -> ForgeRequest {
        ForgeRequest {
            repo: "/r".into(),
            forge,
            host: if forge == Forge::Github { "github.com".into() } else { "gitlab.example.com:8443".into() },
            project: if forge == Forge::Github { "o/r".into() } else { "g/sub/p".into() },
            cli_path: None,
            source: "feature/x".into(),
            target: "main".into(),
            title: "--web".into(),
            body: "line 1\n$(touch pwned)\n; rm -rf /".into(),
            draft: true,
            remove_source_branch: false,
            squash: false,
            reviewers: vec!["a".into(), "org/team".into()],
            labels: vec![],
            assignees: vec!["@me".into()],
        }
    }

    #[test]
    fn gh_argv() {
        let a = argv(&req(Forge::Github)).unwrap();
        let want = ["pr", "create", "--repo=github.com/o/r", "--head=feature/x", "--base=main", "--title=--web", "--body=line 1\n$(touch pwned)\n; rm -rf /", "--draft", "--reviewer=a,org/team", "--assignee=@me"];
        assert_eq!(a, want);
    }

    #[test]
    fn glab_argv() {
        let mut r = req(Forge::Gitlab);
        (r.remove_source_branch, r.squash, r.draft, r.labels) = (true, true, false, vec!["bug".into(), "ui".into()]);
        let a = argv(&r).unwrap();
        let want = [
            "mr", "create", "--repo=https://gitlab.example.com:8443/g/sub/p", "--source-branch=feature/x", "--target-branch=main", "--title=--web",
            "--description=line 1\n$(touch pwned)\n; rm -rf /", "--remove-source-branch", "--squash-before-merge", "--reviewer=a,org/team", "--label=bug,ui",
            "--assignee=@me", "--yes", "--push=false",
        ];
        assert_eq!(a, want);
    }

    #[test]
    fn refusals() {
        let bad = |f: &dyn Fn(&mut ForgeRequest)| {
            let mut r = req(Forge::Github);
            f(&mut r);
            argv(&r).unwrap_err()
        };
        bad(&|r| r.title = "a\nb".into());
        bad(&|r| r.title = " ".into());
        bad(&|r| r.title = "x".repeat(257));
        bad(&|r| r.body = "a\0b".into());
        bad(&|r| r.body = "x".repeat(60_001));
        bad(&|r| r.body = " - ".into());
        bad(&|r| r.reviewers = vec!["a b".into()]);
        bad(&|r| r.reviewers = vec!["-x".into()]);
        bad(&|r| r.labels = vec!["a,b".into()]);
        bad(&|r| r.assignees = vec!["$(id)".into()]);
        bad(&|r| r.project = "o/r/x".into());
        bad(&|r| r.project = "-o/r".into());
        bad(&|r| r.host = "-oProxy".into());
        bad(&|r| r.host = "a b".into());
        bad(&|r| r.squash = true);
        let mut r = req(Forge::Github);
        r.title = "x".repeat(256);
        assert!(argv(&r).is_ok());
    }

    #[test]
    fn url_from_output() {
        assert_eq!(created_url("Creating...\nhttps://github.com/o/r/pull/7\n").as_deref(), Some("https://github.com/o/r/pull/7"));
        assert_eq!(created_url("!3 title (b)\n https://gitlab.com/g/p/-/merge_requests/3\n").as_deref(), Some("https://gitlab.com/g/p/-/merge_requests/3"));
        assert_eq!(created_url("nothing"), None);
    }
}

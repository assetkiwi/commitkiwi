//! Branch cleanup assistant: local and remote-tracking branches that are probably safe to delete (merged into the
//! default branch or HEAD, no commit for N days, upstream gone), and their bulk delete. The list is a read (`git()`);
//! the deletes are write steps (`git_out`), one queued job for the local side and one for the remote side.
use super::{FIELD, exists, git, git_out, local_branch, parse_worktrees, remote_branch, remotes};
use commitkiwi_protocol::{Cleanup, CleanupBranch};
use std::collections::{BTreeMap, HashSet};

/// Candidates listed at most (each costs one `rev-list` for ahead/behind).
const MAX_CANDIDATES: usize = 1000;
/// Branches one delete request may name.
const MAX_DELETE: usize = 1000;
const MAX_PROTECTED: usize = 200;
/// Names tried when no remote says which branch is its default.
const DEFAULT_NAMES: [&str; 4] = ["main", "master", "trunk", "develop"];

/// `*` matches any run of characters (also `/`); everything else literally.
fn glob(pat: &str, s: &str) -> bool {
    let mut parts = pat.split('*');
    let first = parts.next().unwrap_or("");
    let Some(mut rest) = s.strip_prefix(first) else { return false };
    let parts: Vec<&str> = parts.collect();
    let Some((last, middle)) = parts.split_last() else { return rest.is_empty() };
    for p in middle {
        match rest.find(p) {
            Some(i) => rest = &rest[i + p.len()..],
            None => return false,
        }
    }
    rest.len() >= last.len() && rest.ends_with(last)
}

fn line(repo: &str, args: &[&str]) -> Option<String> {
    git(repo, args).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Remotes with origin first.
fn remote_list(repo: &str) -> Vec<String> {
    let mut rs = remotes(repo);
    rs.sort_by_key(|r| r != "origin");
    rs
}

/// Each remote's default branch (`refs/remotes/<r>/HEAD`) as a full ref that exists, and the short name of the
/// default branch: origin's, else another remote's, else the first of `DEFAULT_NAMES` that exists here.
fn defaults(repo: &str, remotes: &[String]) -> (Option<String>, Vec<(String, String)>) {
    let mut name = None;
    let mut per_remote = Vec::new();
    for r in remotes {
        let prefix = format!("refs/remotes/{r}/");
        let target = line(repo, &["symbolic-ref", "-q", &format!("{prefix}HEAD")]).filter(|t| t.starts_with(&prefix) && exists(repo, t));
        if let Some(t) = target {
            name.get_or_insert_with(|| t[prefix.len()..].to_string());
            per_remote.push((r.clone(), t));
        }
    }
    let name = name.or_else(|| {
        DEFAULT_NAMES.into_iter().find(|n| exists(repo, &format!("refs/heads/{n}")) || remotes.iter().any(|r| exists(repo, &format!("refs/remotes/{r}/{n}")))).map(String::from)
    });
    // a remote without a HEAD ref: its branch of that name counts as its default
    if let Some(n) = &name {
        for r in remotes {
            let full = format!("refs/remotes/{r}/{n}");
            if !per_remote.iter().any(|(x, _)| x == r) && exists(repo, &full) {
                per_remote.push((r.clone(), full));
            }
        }
    }
    (name, per_remote)
}

/// Full ref names under `prefix` reachable from `base`.
fn merged_into(repo: &str, base: &str, prefix: &str) -> HashSet<String> {
    git(repo, &["for-each-ref", "--format=%(refname)", &format!("--merged={base}"), prefix])
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect()
}

fn is_ancestor(repo: &str, rev: &str, of: &str) -> bool {
    git(repo, &["merge-base", "--is-ancestor", rev, of]).is_ok()
}

/// (ahead, behind) of `rev` against `base`.
fn ahead_behind(repo: &str, base: &str, rev: &str) -> (u32, u32) {
    let out = git(repo, &["rev-list", "--left-right", "--count", &format!("{base}...{rev}"), "--"]).unwrap_or_default();
    let mut it = out.split_whitespace().map(|n| n.parse().unwrap_or(0));
    let behind = it.next().unwrap_or(0);
    (it.next().unwrap_or(0), behind)
}

pub(crate) fn candidates(repo: &str, stale_days: u32, protected: &[String], now: i64) -> Result<Cleanup, String> {
    if protected.len() > MAX_PROTECTED || protected.iter().any(|p| p.is_empty() || p.chars().any(char::is_control)) {
        return Err("bad protected branch pattern".into());
    }
    let remotes = remote_list(repo);
    let (default_branch, remote_defaults) = defaults(repo, &remotes);
    let local_default = default_branch.as_ref().map(|n| format!("refs/heads/{n}")).filter(|r| exists(repo, r));
    let head_ref = line(repo, &["symbolic-ref", "-q", "HEAD"]);
    let has_head = line(repo, &["rev-parse", "-q", "--verify", "HEAD"]).is_some();

    // never offered: the current branch, the default branch (here and on every remote), worktree checkouts
    let mut keep: HashSet<String> = head_ref.iter().cloned().collect();
    if let Some(n) = &default_branch {
        keep.insert(format!("refs/heads/{n}"));
        keep.extend(remotes.iter().map(|r| format!("refs/remotes/{r}/{n}")));
    }
    keep.extend(remote_defaults.iter().map(|(_, t)| t.clone()));
    let root = git(repo, &["rev-parse", "--show-toplevel"]).unwrap_or_default();
    let trees = parse_worktrees(&git(repo, &["worktree", "list", "--porcelain"]).unwrap_or_default(), root.trim());
    keep.extend(trees.into_iter().filter_map(|w| w.branch).map(|b| format!("refs/heads/{b}")));

    // merged: local ones into the default branch (local or any remote's) or HEAD; remote ones into their remote's default
    let mut merged_local = HashSet::new();
    let bases = local_default.iter().cloned().chain(remote_defaults.iter().map(|(_, t)| t.clone())).chain(has_head.then(|| "HEAD".to_string()));
    for base in bases {
        merged_local.extend(merged_into(repo, &base, "refs/heads/"));
    }
    let mut merged_remote = HashSet::new();
    for (r, t) in &remote_defaults {
        merged_remote.extend(merged_into(repo, t, &format!("refs/remotes/{r}/")));
    }

    let fmt = format!("--format=%(refname){FIELD}%(objectname){FIELD}%(committerdate:unix){FIELD}%(authorname){FIELD}%(upstream:track){FIELD}%(subject)");
    let list = git(repo, &["for-each-ref", &fmt, "refs/heads/", "refs/remotes/"])?;
    let cutoff = (stale_days > 0).then(|| now - i64::from(stale_days) * 86_400);
    let mut out = Cleanup { default_branch: default_branch.clone(), ..Default::default() };
    for l in list.lines() {
        let f: Vec<&str> = l.splitn(6, FIELD).collect();
        let [name, oid, time, author, track, subject] = f[..] else { continue };
        if keep.contains(name) || name.ends_with("/HEAD") {
            continue;
        }
        let remote = name.strip_prefix("refs/remotes/").and_then(|rest| {
            remotes.iter().filter(|r| rest.strip_prefix(r.as_str()).is_some_and(|b| b.len() > 1 && b.starts_with('/'))).max_by_key(|r| r.len()).cloned()
        });
        let short = match &remote {
            Some(r) => &name[("refs/remotes/".len() + r.len() + 1)..],
            None => match name.strip_prefix("refs/heads/") {
                Some(n) => n,
                None => continue, // a remote-tracking ref of a remote that no longer exists
            },
        };
        if protected.iter().any(|p| glob(p, short)) {
            continue;
        }
        let time: i64 = time.parse().unwrap_or(0);
        let merged = if remote.is_some() { merged_remote.contains(name) } else { merged_local.contains(name) };
        let stale = cutoff.is_some_and(|c| time < c);
        let gone = remote.is_none() && track.contains("gone");
        if !(merged || stale || gone) {
            continue;
        }
        if out.branches.len() == MAX_CANDIDATES {
            out.truncated = true;
            break;
        }
        // against the branch's own remote's default for remote branches, else the local default (or origin's)
        let base = match &remote {
            Some(r) => remote_defaults.iter().find(|(x, _)| x == r).map(|(_, t)| t.clone()),
            None => local_default.clone().or_else(|| remote_defaults.first().map(|(_, t)| t.clone())),
        };
        let (ahead, behind) = base.map_or((0, 0), |b| ahead_behind(repo, &b, name));
        out.branches.push(CleanupBranch {
            name: name.into(), remote, oid: oid.into(), time, author: author.into(), subject: subject.into(), ahead, behind, merged, stale, gone,
        });
    }
    Ok(out)
}

/// The ref `git branch -d` checks a branch against: its upstream when that still exists, else HEAD.
fn d_reference(repo: &str, branch: &str) -> String {
    line(repo, &["for-each-ref", "--format=%(upstream)", &format!("refs/heads/{branch}")]).filter(|u| exists(repo, u)).unwrap_or_else(|| "HEAD".into())
}

pub(crate) fn delete_local(repo: &str, merged: &[String], unmerged: &[String]) -> Result<(), String> {
    if merged.len() + unmerged.len() > MAX_DELETE {
        return Err(format!("at most {MAX_DELETE} branches at a time"));
    }
    let mut seen = HashSet::new();
    for b in merged.iter().chain(unmerged) {
        local_branch(repo, b)?;
        if !seen.insert(b.as_str()) {
            return Err(format!("{b} is listed twice"));
        }
    }
    // checked again here (the list may be old): merged into the default branch or HEAD, before anything is deleted
    let remotes = remote_list(repo);
    let (name, remote_defaults) = defaults(repo, &remotes);
    let bases: Vec<String> = name.map(|n| format!("refs/heads/{n}")).filter(|r| exists(repo, r)).into_iter()
        .chain(remote_defaults.into_iter().map(|(_, t)| t))
        .chain(line(repo, &["rev-parse", "-q", "--verify", "HEAD"]).map(|_| "HEAD".to_string()))
        .collect();
    let (mut plain, mut force) = (vec![], vec![]);
    for b in merged {
        let full = format!("refs/heads/{b}");
        if !bases.iter().any(|base| is_ancestor(repo, &full, base)) {
            return Err(format!("{b} is not merged any more (it has new commits); nothing was deleted. Refresh and try again."));
        }
        if is_ancestor(repo, &full, &d_reference(repo, b)) { plain.push(b.as_str()) } else { force.push(b.as_str()) }
    }
    force.extend(unmerged.iter().map(String::as_str));
    for (flag, names) in [("-d", plain), ("-D", force)] {
        if !names.is_empty() {
            let mut args = vec!["branch", flag, "--"];
            args.extend(names);
            git_out(repo, &args)?;
        }
    }
    Ok(())
}

pub(crate) fn delete_remote(repo: &str, branches: &[String]) -> Result<(), String> {
    if branches.len() > MAX_DELETE {
        return Err(format!("at most {MAX_DELETE} branches at a time"));
    }
    let mut by_remote: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for full in branches {
        let (remote, name) = remote_branch(repo, full)?;
        by_remote.entry(remote).or_default().push(format!("refs/heads/{name}"));
    }
    for (remote, refspecs) in &by_remote {
        let mut args = vec!["push", "--progress", "--delete", "--", remote.as_str()];
        args.extend(refspecs.iter().map(String::as_str));
        git_out(repo, &args)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::glob;

    #[test]
    fn globs() {
        assert!(glob("main", "main") && !glob("main", "main2") && !glob("main", "xmain"));
        assert!(glob("release/*", "release/1.0") && glob("release/*", "release/a/b") && glob("release/*", "release/"));
        assert!(!glob("release/*", "release") && !glob("release/*", "pre-release/1"));
        assert!(glob("*-wip", "x-wip") && glob("a*b*c", "a1b2c") && !glob("a*b*c", "a1c2b") && glob("*", "anything"));
        assert!(!glob("ab*ba", "aba"), "the prefix and suffix may not overlap");
    }
}

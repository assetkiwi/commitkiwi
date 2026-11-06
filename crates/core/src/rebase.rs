//! Interactive rebase: the editor's list of commits (a read) and its todo list, run as one scripted `git rebase -i`
//! (a write step, so it is killable and journaled like every other job).
//!
//! New messages are applied by `exec git commit --amend -F <file>` lines after each changed commit's last line, not
//! by `reword` and a scripted `GIT_EDITOR`: an editor sees only the order it is called in, and after a conflict the
//! user's Continue runs git without our editor. Todo lines survive a stop, so the message files live in the git dir
//! (`commitkiwi-rebase`) until the rebase is over.
use super::{FIELD, RECORD, check_oid, exec, git, git_dir_paths, in_progress, published_check, rebase_range, rebase_ready, valid_oid};
use commitkiwi_protocol::{RebaseCommit, RebasePlan, RebaseStep, TodoAction};

/// Commits the editor lists when it is opened without a starting commit (the newest unpublished ones).
const DEFAULT_PLAN: usize = 50;

fn head(repo: &str) -> Result<String, String> {
    let h = git(repo, &["rev-parse", "-q", "--verify", "HEAD"]).map_err(|_| "There are no commits yet.".to_string())?;
    let h = h.trim();
    if valid_oid(h) { Ok(h.to_string()) } else { Err("HEAD is not a commit.".into()) }
}

fn parent(repo: &str, c: &str) -> Option<String> {
    git(repo, &["rev-parse", "-q", "--verify", &format!("{c}^1")]).ok().map(|s| s.trim().to_string()).filter(|s| valid_oid(s))
}

pub fn plan(repo: &str, from: Option<&str>) -> Result<RebasePlan, String> {
    let head = head(repo)?;
    let oldest = match from {
        Some(c) => {
            check_oid(c)?;
            if git(repo, &["merge-base", "--is-ancestor", c, "HEAD"]).is_err() {
                return Err(format!("{} is not on the current branch", &c[..8]));
            }
            c.to_string()
        }
        // --max-count applies before --reverse: the oldest of the newest unpublished commits
        None => git(repo, &["rev-list", "--reverse", &format!("--max-count={DEFAULT_PLAN}"), "HEAD", "--not", "--remotes", "--"])?
            .lines()
            .next()
            .map(str::to_string)
            .ok_or("Every commit of this branch is on a remote branch already. To rewrite some anyway, right-click the oldest one in the commit list and choose Rebase Interactively from Here…")?,
    };
    let base = parent(repo, &oldest);
    let list = rebase_range(repo, base.as_deref())?;
    let range = base.as_deref().map_or("HEAD".to_string(), |b| format!("{b}..HEAD"));
    let unpublished = git(repo, &["rev-list", &range, "--not", "--remotes", "--"])?;
    let unpublished: std::collections::HashSet<&str> = unpublished.lines().collect();
    let format = format!("--format={RECORD}%H{FIELD}%an{FIELD}%at{FIELD}%s{FIELD}%B");
    let out = git(repo, &["log", "--no-ext-diff", "--no-textconv", "--reverse", &format, &range, "--"])?;
    let commits: Vec<RebaseCommit> = out
        .split(RECORD)
        .skip(1)
        .filter_map(|rec| {
            let f: Vec<&str> = rec.splitn(5, FIELD).collect();
            let [oid, author, time, subject, message] = f[..] else { return None };
            Some(RebaseCommit {
                oid: oid.to_string(),
                author: author.to_string(),
                time: time.parse().unwrap_or(0),
                subject: subject.to_string(),
                message: message.trim_end().to_string(),
                published: !unpublished.contains(oid),
            })
        })
        .collect();
    if commits.iter().map(|c| &c.oid).ne(list.iter()) {
        return Err("The branch changed while it was read; try again.".into());
    }
    let branch = git(repo, &["symbolic-ref", "-q", "--short", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Ok(RebasePlan { base, head, branch, commits })
}

/// The todo list for `steps` (checked by `apply`); `msg(i)` is the path of step `i`'s message file.
fn todo(steps: &[RebaseStep], msg: impl Fn(usize) -> String) -> String {
    let mut out = String::new();
    let mut pending: Option<usize> = None;
    let amend = |i: usize| format!("exec git commit --amend --allow-empty --quiet -F '{}'\n", msg(i));
    for (i, s) in steps.iter().enumerate() {
        let verb = match s.action {
            // reword = pick + our amend (git's own reword would open an editor)
            TodoAction::Pick | TodoAction::Reword => {
                if let Some(p) = pending.take() {
                    out += &amend(p);
                }
                pending = s.message.is_some().then_some(i);
                "pick"
            }
            TodoAction::Squash => "squash",
            TodoAction::Fixup => "fixup",
            TodoAction::Drop => "drop",
        };
        out += &format!("{verb} {}\n", s.oid);
    }
    if let Some(p) = pending {
        out += &amend(p);
    }
    out
}

pub fn apply(repo: &str, base: Option<&str>, expected_head: &str, steps: &[RebaseStep], published_ok: bool) -> Result<(), String> {
    if steps.is_empty() {
        return Err("No commits given.".into());
    }
    check_oid(expected_head)?;
    if let Some(b) = base {
        check_oid(b)?;
    }
    let mut joined = false; // an earlier line that keeps a commit
    for (i, s) in steps.iter().enumerate() {
        check_oid(&s.oid)?;
        let short = &s.oid[..8];
        if steps[..i].iter().any(|x| x.oid == s.oid) {
            return Err(format!("{short} is listed twice"));
        }
        match (s.action, s.message.as_deref().map(str::trim)) {
            (TodoAction::Squash | TodoAction::Fixup | TodoAction::Drop, Some(_)) => return Err(format!("{short}: only a pick or reword line carries a message")),
            (TodoAction::Reword, None) => return Err(format!("{short}: reword needs the new message")),
            (_, Some("")) => return Err(format!("{short}: the commit message is empty")),
            (TodoAction::Squash | TodoAction::Fixup, _) if !joined => return Err(format!("{short}: squash and fixup join the commit above; the first commit cannot be one")),
            _ => {}
        }
        joined |= s.action != TodoAction::Drop;
    }
    rebase_ready(repo)?;
    if head(repo)? != expected_head {
        return Err("The branch moved since the list was made; open the editor again.".into());
    }
    let list = rebase_range(repo, base)?;
    if list.len() != steps.len() || steps.iter().any(|s| !list.contains(&s.oid)) {
        return Err("The list does not match the branch any more; open the editor again.".into());
    }
    let changed = steps
        .iter()
        .zip(&list)
        .position(|(s, o)| s.action != TodoAction::Pick || s.message.is_some() || &s.oid != o)
        .ok_or("Nothing to change.")?;
    if !published_ok {
        published_check(repo, &list[changed])?;
    }

    // the git dir, not a temp dir: `exec` lines after a conflict still read their message files on Continue
    let dir = git_dir_paths(repo, &["commitkiwi-rebase"])?.remove(0);
    let shown = dir.to_string_lossy().into_owned();
    if shown.contains(['\'', '\n', '\r', '\0']) {
        return Err("The repository's path cannot be quoted for git.".into());
    }
    let _ = std::fs::remove_dir_all(&dir); // left by a rebase that was aborted
    std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700).create(&dir).map_err(|e| format!("cannot create {shown}: {e}"))?;
    let r = (|| {
        for (i, s) in steps.iter().enumerate() {
            if let Some(m) = &s.message {
                std::fs::write(dir.join(format!("msg-{i}")), format!("{}\n", m.trim_end())).map_err(|e| e.to_string())?;
            }
        }
        std::fs::write(dir.join("todo"), todo(steps, |i| format!("{shown}/msg-{i}"))).map_err(|e| e.to_string())?;
        let env = [("GIT_SEQUENCE_EDITOR", format!("cp '{shown}/todo'"))];
        exec(repo, &["rebase", "-i", "--no-autosquash", "--no-autostash", base.unwrap_or("--root")], None, &env).map(|_| ())
    })();
    if !matches!(in_progress(repo), Ok(Some(_))) {
        let _ = std::fs::remove_dir_all(&dir);
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(oid: char, action: TodoAction, message: Option<&str>) -> RebaseStep {
        RebaseStep { oid: oid.to_string().repeat(40), action, message: message.map(String::from) }
    }

    #[test]
    fn todo_lines() {
        use TodoAction::*;
        let o = |c: char| c.to_string().repeat(40);
        let steps = [step('b', Reword, Some("B")), step('a', Squash, None), step('c', Drop, None), step('d', Fixup, None), step('e', Pick, None), step('f', Pick, Some("F"))];
        let t = todo(&steps, |i| format!("/m/{i}"));
        let amend = |i: usize| format!("exec git commit --amend --allow-empty --quiet -F '/m/{i}'");
        let want = [format!("pick {}", o('b')), format!("squash {}", o('a')), format!("drop {}", o('c')), format!("fixup {}", o('d')), amend(0), format!("pick {}", o('e')), format!("pick {}", o('f')), amend(5)];
        assert_eq!(t.lines().collect::<Vec<_>>(), want);
    }
}

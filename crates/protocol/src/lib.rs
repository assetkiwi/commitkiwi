//! Wire types shared by the app, the in-process runner and the remote agent.
//! Frames: u32 big-endian length + msgpack(`Msg<T>`). Enums are externally tagged.
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::io::{self, Read};

pub const PROTO_VERSION: u32 = 21;
/// Written by the agent before its first frame. The client discards everything before it, so
/// output from a remote shell profile (motd, echo in .bashrc) cannot corrupt the stream.
pub const MAGIC: &[u8] = b"\0commitkiwi-agent/1\n";
/// Upper bound for one frame; guards against a corrupt or hostile peer making us allocate GBs.
pub const MAX_FRAME: usize = 64 << 20;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Msg<T> {
    pub id: u64,
    pub body: T,
    /// On replies from the agent: how long it took to handle the request there, ms (the request timing trace).
    /// Optional both ways, so agents and apps from before it still understand each other.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum Req {
    Hello,
    Open { path: String },
    Refs { repo: String },
    /// `hidden`: full ref names (`refs/heads/x`) left out of the commit list (the eye in Locations).
    Count { repo: String, #[serde(default)] hidden: Vec<String> },
    Log { repo: String, skip: u32, limit: u32, #[serde(default)] hidden: Vec<String> },
    /// File counts for specific commits (fetched lazily for the visible rows; `git log` stats are slow).
    Stats { repo: String, oids: Vec<String> },
    /// Parent row indices for every commit in `Log` order (drives the graph lanes client-side).
    Graph { repo: String, #[serde(default)] hidden: Vec<String> },
    /// Row index of a commit in `Log` order, if it is in the list.
    Locate { repo: String, oid: String, #[serde(default)] hidden: Vec<String> },
    /// Full message and changed files (against the first parent; with `from`, against `from`'s first parent:
    /// the combined change of a range of commits).
    Show { repo: String, oid: String, #[serde(default)] from: Option<String> },
    /// Unified diff of one file of a commit (`old_path` for renames; `from` as in `Show`).
    Diff {
        repo: String,
        oid: String,
        path: String,
        old_path: Option<String>,
        context: u32,
        ignore_ws: bool,
        #[serde(default)]
        from: Option<String>,
    },
    /// History of a line range (`git log -L`), e.g. of one hunk. Lines are 1-based and inclusive.
    LineLog { repo: String, oid: String, path: String, start: u32, end: u32, limit: u32 },
    /// An image file's bytes (base64) for display; refuses files over 8 MB. `rev` as in `ReadFile`.
    Image { repo: String, rev: String, path: String },
    /// Directory listing of the tree at a commit; `path` empty = root.
    Tree { repo: String, oid: String, path: String },
    Blob { repo: String, oid: String, path: String },
    /// A file's content (capped at 1 MB) for diff context and highlighting. `rev`: a commit id, `HEAD`,
    /// `index` (stage 0) or `worktree`; the path is relative to the repo root.
    ReadFile { repo: String, rev: String, path: String },
    /// Every file path in the tree at a commit (the Files tree's count and filter).
    Files { repo: String, oid: String },
    /// History of one file, following renames.
    FileLog { repo: String, oid: String, path: String, skip: u32, limit: u32 },
    Blame { repo: String, oid: String, path: String },
    /// Working copy: changed, untracked and conflicted files.
    Status { repo: String },
    /// Diff of a working-copy file: `staged` = index vs HEAD, otherwise worktree vs index
    /// (`conflicted`: worktree vs HEAD, so the conflict markers show as additions).
    /// `context`/`ignore_ws` as in `Diff`.
    WorkDiff {
        repo: String,
        path: String,
        old_path: Option<String>,
        staged: bool,
        untracked: bool,
        #[serde(default)]
        conflicted: bool,
        #[serde(default = "default_context")]
        context: u32,
        #[serde(default)]
        ignore_ws: bool,
    },
    Stage { repo: String, paths: Vec<String> },
    Unstage { repo: String, paths: Vec<String> },
    /// Throw away worktree changes (tracked files are restored, untracked files are deleted).
    Discard { repo: String, paths: Vec<String> },
    /// Apply a hunk/line patch built by the UI to the index or the worktree.
    Apply { repo: String, patch: String, mode: ApplyMode },
    /// `no_verify`: skip the commit hooks (Advanced Commit menu).
    Commit { repo: String, message: String, amend: bool, signoff: bool, #[serde(default)] no_verify: bool },
    /// `Name <email>` git would use for a new commit; empty when git has none configured (it would refuse to guess).
    Identity { repo: String },
    /// `git config --global user.name/user.email` ("Click here to set user details").
    SetIdentity { repo: String, name: String, email: String },
    /// `git merge --abort`.
    AbortMerge { repo: String },
    /// Resolve a conflicted file with one side (`git checkout --ours|--theirs`), then stage it.
    Resolve { repo: String, path: String, theirs: bool },
    /// Append a path to the repo's root .gitignore.
    Ignore { repo: String, path: String },
    /// `git stash push` with flags from a fixed list (`--include-untracked`, `--keep-index`, `--staged`).
    Stash { repo: String, flags: Vec<String> },
    /// `git stash pop` of the newest stash.
    PopStash { repo: String },
    /// `git pull` / `git fetch` / `git push` against the configured upstream, flags from fixed lists.
    Pull { repo: String, flags: Vec<String> },
    /// `remote`: fetch from that remote only (a configured one); None = git's default.
    Fetch { repo: String, flags: Vec<String>, #[serde(default)] remote: Option<String> },
    /// `remote` + `branch` (both or neither): push that local branch to its upstream branch on `remote`
    /// (the same name, with `--set-upstream`, when it has none there); neither = git's default push.
    Push { repo: String, flags: Vec<String>, #[serde(default)] remote: Option<String>, #[serde(default)] branch: Option<String> },
    /// Check out a branch or tag by name.
    Checkout { repo: String, name: String },
    /// `git worktree add <path> [<branch>]`; a relative path is relative to the repo root.
    AddWorktree { repo: String, path: String, branch: Option<String> },
    /// `git submodule add <url> [<path>]`.
    AddSubmodule { repo: String, url: String, path: Option<String> },
    /// `git submodule update --recursive` (`init`: also `--init`); `path`: only that submodule (a listed one).
    UpdateSubmodules { repo: String, init: bool, #[serde(default)] path: Option<String> },
    /// `git submodule sync --recursive`; `path` as in `UpdateSubmodules`.
    SyncSubmodules { repo: String, #[serde(default)] path: Option<String> },
    /// Find git repos under `root` (not following symlinks, skipping hidden/vendor dirs), `depth` levels deep.
    ScanRepos { root: String, #[serde(default = "default_scan_depth")] depth: u32 },
    /// Commits matching `query`, as rows in `Log` order (same `hidden` refs); at most `limit` (capped in core).
    Search { repo: String, query: SearchQuery, #[serde(default)] hidden: Vec<String>, limit: u32 },
    /// Run a write request as console job `job` (an id the UI picks): git's output streams back as `Resp::Output`
    /// frames with this message's id before the reply, and `Cancel { job }` kills its git process.
    /// Ref-moving requests reply `Moved` instead of `Done`.
    Job { job: u64, req: Box<Req> },
    /// Stop job `job`: kill its running git (and hooks, ssh) or keep it from starting. Always `Done`.
    Cancel { job: u64 },
    // ---- M5a branch/ref operations. A `rev` is a full commit id or a full ref name (`refs/heads/x`,
    // `refs/remotes/origin/x`, `refs/tags/v1`); new names are short names that must pass `git check-ref-format`.
    /// `git branch <name> [<from>]` (HEAD when `from` is None), or `git checkout -b` with `checkout`.
    CreateBranch { repo: String, name: String, from: Option<String>, checkout: bool },
    /// `git branch -m <branch> <name>` (both short local names).
    RenameBranch { repo: String, branch: String, name: String },
    /// `git branch -d` (`force`: `-D`, deletes unmerged work) of a local branch.
    DeleteBranch { repo: String, branch: String, force: bool },
    /// `git push <remote> --delete <branch>`; `branch` is the remote-tracking ref (`refs/remotes/origin/x`).
    DeleteRemoteBranch { repo: String, branch: String },
    /// `git merge <rev>` with flags from a fixed list (`--no-ff`, `--ff-only`, `--squash`, `--no-commit`).
    Merge { repo: String, rev: String, flags: Vec<String> },
    /// `git rebase <onto>` of the current branch.
    Rebase { repo: String, onto: String },
    CherryPick { repo: String, rev: String },
    /// `git revert --no-edit <rev>`.
    Revert { repo: String, rev: String },
    /// `git reset --soft|--mixed|--hard <rev>` of the current branch.
    Reset { repo: String, rev: String, mode: ResetMode },
    /// `git tag <name> <rev>`; with `message` an annotated tag.
    CreateTag { repo: String, name: String, rev: String, message: Option<String> },
    DeleteTag { repo: String, name: String },
    /// `git push <remote> refs/tags/<name>`.
    PushTag { repo: String, remote: String, name: String },
    /// `git push <remote> --delete refs/tags/<name>`.
    DeleteRemoteTag { repo: String, remote: String, name: String },
    /// `git branch -u <upstream> <branch>` (a remote-tracking ref), or `--unset-upstream` when None.
    SetUpstream { repo: String, branch: String, upstream: Option<String> },
    /// Continue, skip or abort the rebase, cherry-pick, revert or merge in progress (`Status.op`/`Status.merge`).
    Sequence { repo: String, action: SeqAction },
    /// `git rev-list --count <base>..<tip>` (`Count`): the commits a reset to `base` takes off the branch at `tip`.
    CountRange { repo: String, base: String, tip: String },
    // ---- M5b
    /// Rewind HEAD and the local refs (branches, tags, the stash) a journal entry moved to their state before it
    /// (`redo`: after it). Refused when the repository no longer matches the other side, an operation is in
    /// progress, or local changes would be overwritten; `mode` says how HEAD moves on its branch (see `UndoMode`).
    /// `check`: only validate (a read; `Done` or the reason it is refused).
    Undo { repo: String, moved: Moved, redo: bool, mode: UndoMode, #[serde(default)] check: bool },
    /// `git remote add|rename|remove|set-url`.
    AddRemote { repo: String, name: String, url: String },
    RenameRemote { repo: String, name: String, new_name: String },
    DeleteRemote { repo: String, name: String },
    SetRemoteUrl { repo: String, name: String, url: String },
    // ---- F8 (context menus)
    /// `git stash apply|pop|drop stash@{n}`; refused unless `stash` still names the stash with id `oid`.
    StashOp { repo: String, stash: String, oid: String, action: StashAction },
    /// `git stash clear` (every stash; not undoable).
    ClearStashes { repo: String },
    /// A remote's fetch URL (`Text`), a read.
    RemoteUrl { repo: String, name: String },
    // ---- M6 (merge tool, commit editing)
    /// An unmerged file for the merge tool: its index stages and the working-tree file (`Resp::Conflict`), a read.
    Conflict { repo: String, path: String },
    /// Write the merge tool's result over the unmerged file `path` (inside the repo, never through a symlink, via a
    /// temp file + rename), then `git add` it when `stage`. Refused unless `path` is unmerged.
    SaveMerge { repo: String, path: String, text: String, stage: bool },
    /// Rewrite commits of the current branch with a scripted `git rebase -i` whose todo list core builds from
    /// `commits` (full ids, on the branch, no merges in the range). `message`: the new message (`Reword`).
    /// Refused with an error starting `PUBLISHED` when the range is on a remote-tracking branch, unless `published_ok`.
    Rewrite { repo: String, action: RewriteAction, commits: Vec<String>, #[serde(default)] message: Option<String>, #[serde(default)] published_ok: bool },
    // ---- M7b (New Tab page, user commands)
    /// `git init` in `path` (absolute or `~/…`; created when missing). Refused when it already holds a `.git`.
    /// Replies `Text` = the repository's folder.
    Init { path: String },
    /// `git clone --progress -- <url> <name>` inside the existing folder `parent`; `name` defaults to the URL's last
    /// part (git's rule). URLs: not option-like, no control chars, no `ext::`/`fd::`. Replies `Text` = the new folder.
    Clone { url: String, parent: String, #[serde(default)] name: Option<String> },
    /// A user's custom command (the `git` command with `argv`): `git <argv…>` in the repo, no shell. `argv[0]`
    /// must be a git command (not an option, not an alias); runs as a normal write step.
    GitCustom { repo: String, argv: Vec<String> },
    // ---- M8 (live updates)
    /// Watch the repo for changes (worktree + `.git` essentials). Replies `Watch`; then `Changed` events arrive
    /// unsolicited (message id 0) until `Unwatch` or the connection ends. Watching again replaces the old watcher.
    Watch { repo: String },
    Unwatch { repo: String },
    // ---- Pull/merge requests through the user's own `gh` / `glab` (they hold the login; we store no tokens)
    /// Facts for the Create Pull/Merge Request dialog, a read that never fetches: `remote`'s URL, its default branch
    /// and branches, `source` (default: the current branch) with its upstream and how far it is ahead of the remote,
    /// the commits `target..source` (capped). With `forge` + `host`: that CLI (`cli_path`, else PATH and the usual
    /// install dirs) and whether it is logged in to `host` (`<cli> auth status`, short timeout). Replies `Forge`.
    ForgeProbe {
        repo: String,
        remote: String,
        #[serde(default)]
        source: Option<String>,
        #[serde(default)]
        target: Option<String>,
        #[serde(default)]
        forge: Option<Forge>,
        #[serde(default)]
        host: Option<String>,
        #[serde(default)]
        cli_path: Option<String>,
    },
    /// `gh pr create` / `glab mr create` (argv only, no shell, stdin closed, never prompts). Replies `Created`.
    ForgeCreate(ForgeRequest),
    // ---- Branch cleanup assistant
    /// Branches that are probably safe to delete (a read; replies `Cleanup`): local ones merged into the default
    /// branch or HEAD, without a commit for `stale_days` days (0: off), or whose upstream is gone; remote-tracking ones
    /// merged into their remote's default branch, or stale. Never the current branch, the default branch, a branch
    /// checked out in any worktree, or a name matching `protected` (`*` globs, matched without the remote name).
    CleanupCandidates { repo: String, stale_days: u32, #[serde(default)] protected: Vec<String> },
    /// Delete local branches in one job (short names). `merged`: core checks again that each is merged into the
    /// default branch or HEAD, then `git branch -d` (`-D` for one only the default branch has: git's `-d` looks at
    /// HEAD or the upstream only); `unmerged`: `git branch -D` (the UI asked first). Undo recreates them.
    DeleteBranches { repo: String, merged: Vec<String>, unmerged: Vec<String> },
    /// `git push --delete -- <remote> refs/heads/<b>…`, one push per remote; `branches`: remote-tracking refs
    /// (`refs/remotes/origin/x`). Not undoable.
    DeleteRemoteBranches { repo: String, branches: Vec<String> },
    // ---- Dashboard
    /// One repository's state at a glance (a read: never queued, no hooks, fsmonitor off): branch, upstream with
    /// ahead/behind, number of changed files, last commit. Replies `Overview`.
    Overview { repo: String },
    // ---- Interactive rebase
    /// The commits an interactive rebase would list (a read; replies `RebasePlan`): `from` (a full id on the current
    /// branch) and every commit after it up to HEAD; None = the commits not on any remote-tracking branch (the newest
    /// 50). Refused when the range holds a merge.
    RebasePlan { repo: String, #[serde(default)] from: Option<String> },
    /// Rewrite `base..HEAD` (`base` None: from the root) as `steps` say, oldest first, in one scripted `git rebase -i`.
    /// `steps` must hold every commit of the range once (full ids); `head` is HEAD as the plan saw it (refused when it
    /// moved). Refused with an error starting `PUBLISHED` when a rewritten commit is on a remote-tracking branch,
    /// unless `published_ok`. A conflict stops the rebase like any other (Continue/Skip/Abort with `Sequence`).
    InteractiveRebase { repo: String, base: Option<String>, head: String, steps: Vec<RebaseStep>, #[serde(default)] published_ok: bool },
}

/// One line of an interactive rebase. `message`: the final message of the commit this line starts (only on `pick` /
/// `reword`, covering the `squash`/`fixup` lines after it); required for `reword`; None keeps git's message.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct RebaseStep {
    pub oid: String,
    pub action: TodoAction,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TodoAction {
    Pick,
    Reword,
    Squash,
    Fixup,
    Drop,
}

/// `RebasePlan`'s answer: `base` is the parent of the oldest listed commit (None: it is a root commit), `head` the
/// commit HEAD was at; `commits` oldest first.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct RebasePlan {
    pub base: Option<String>,
    pub head: String,
    pub branch: Option<String>,
    pub commits: Vec<RebaseCommit>,
}

/// `message`: the full message; `published`: reachable from a remote-tracking branch.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct RebaseCommit {
    pub oid: String,
    pub author: String,
    pub time: i64,
    pub subject: String,
    pub message: String,
    pub published: bool,
}

/// `Overview`'s answer. `branch`: short name, None when detached; `upstream`: short name, None when none is set or it
/// is gone (then `ahead`/`behind` are 0); `changed`: changed, conflicted and untracked files (capped like `Status`,
/// see `truncated`); `time`/`subject`: HEAD's committer date (unix seconds) and subject, None before the first commit.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Overview {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changed: u32,
    pub truncated: bool,
    pub time: Option<i64>,
    pub subject: Option<String>,
}

/// `CleanupCandidates`' answer. `default_branch`: the short name the checks used (None: none found, so nothing
/// counts as merged except into HEAD); `truncated`: more candidates than listed.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Cleanup {
    pub default_branch: Option<String>,
    pub branches: Vec<CleanupBranch>,
    pub truncated: bool,
}

/// A branch the cleanup assistant suggests. `name`: the full ref (`refs/heads/x`, `refs/remotes/origin/x`);
/// `remote`: the remote of a remote-tracking branch. `time`: committer date of the tip (unix seconds); `ahead`/`behind`:
/// commits on it that the default branch lacks, and the reverse (0/0 without a default branch). Reasons: `merged`,
/// `stale`, `gone` (local only: its upstream was deleted on the remote).
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct CleanupBranch {
    pub name: String,
    pub remote: Option<String>,
    pub oid: String,
    pub time: i64,
    pub author: String,
    pub subject: String,
    pub ahead: u32,
    pub behind: u32,
    pub merged: bool,
    pub stale: bool,
    pub gone: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Forge {
    Github,
    Gitlab,
}

/// A request to create. `host`: the web host (`github.com`, `gitlab.example.com:8443`); `project`: `owner/name`
/// (GitHub) or `group/sub/project` (GitLab). `source`/`target`: branch names on the remote.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ForgeRequest {
    pub repo: String,
    pub forge: Forge,
    pub host: String,
    pub project: String,
    #[serde(default)]
    pub cli_path: Option<String>,
    pub source: String,
    pub target: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub draft: bool,
    /// GitLab only.
    #[serde(default)]
    pub remove_source_branch: bool,
    /// GitLab only.
    #[serde(default)]
    pub squash: bool,
    #[serde(default)]
    pub reviewers: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub assignees: Vec<String>,
}

/// `Rewrite` actions (the commit menu's Rewrite submenu). `Squash`/`Fixup` with one commit: into its parent; with several: into
/// the oldest of them (fixup keeps only that one's message). `Edit` stops the rebase at the commit (amend, Continue).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RewriteAction {
    Reword,
    Edit,
    Squash,
    Fixup,
    MoveUp,
    MoveDown,
    Drop,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StashAction {
    Apply,
    Pop,
    Drop,
}

/// How Undo/Redo moves HEAD along its branch: `soft` keeps index and working tree (undoing a commit leaves its
/// changes staged), `mixed` also resets the index (only when nothing is staged), `keep` updates the working tree
/// like `git reset --keep` (refused when that would overwrite local changes). Switching branches always checks out.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UndoMode {
    Soft,
    Mixed,
    Keep,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResetMode {
    Soft,
    Mixed,
    /// `--keep`: refused when local changes would be overwritten.
    Keep,
    Hard,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SeqAction {
    Continue,
    Skip,
    Abort,
}

fn default_context() -> u32 {
    3
}

/// A parsed search (the UI owns the `keyword:value` syntax). Every non-empty filter must match (AND);
/// text filters are case-insensitive substrings, several values of one filter must all match.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct SearchQuery {
    /// Free text: found in the message, the author's name or email, or the start of the hash.
    pub text: Vec<String>,
    pub message: Vec<String>,
    /// Author name or email.
    pub author: Vec<String>,
    /// Hash prefixes (hex).
    pub commit: Vec<String>,
    /// Repo-relative files or folders, taken literally; a commit matches when it touches any of them.
    pub file: Vec<String>,
    /// `git log -S`: commits that add or remove this string (at most one).
    pub content: Vec<String>,
    /// git date strings (`2024-01-31`, `2 weeks ago`), committer date.
    pub after: Option<String>,
    pub before: Option<String>,
    /// Only commits reachable from this branch, remote branch or tag (short name; at most one).
    pub branch: Vec<String>,
}

fn default_scan_depth() -> u32 {
    3
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApplyMode {
    /// Patch = worktree-vs-index diff; apply forward to the index.
    Stage,
    /// Patch = index-vs-HEAD diff; apply in reverse to the index.
    Unstage,
    /// Patch = worktree-vs-index diff (or a commit's diff: revert it); apply in reverse to the worktree.
    Discard,
    /// Patch = a commit's diff; apply forward to the worktree (cherry-pick a file or hunk).
    Worktree,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum Resp {
    Hello { proto: u32 },
    Repo(RepoInfo),
    Refs(Refs),
    Count(u32),
    Log(Vec<Commit>),
    Stats(Vec<(String, u32)>),
    Graph(GraphData),
    Locate(Option<u32>),
    Show(Detail),
    Diff(Patch),
    Tree(Vec<TreeEntry>),
    Files(Vec<String>),
    Blob(Blob),
    Blame(Vec<BlameLine>),
    Status(Status),
    Image(ImageData),
    Identity(String),
    Scan(Scan),
    Search(SearchResult),
    /// A plain string reply (`RemoteUrl`).
    Text(String),
    Conflict(ConflictFile),
    /// A write finished.
    Done,
    /// A ref-moving job finished: HEAD and the refs it changed (the journal's Undo data).
    Moved(Moved),
    /// Event, not a reply: a chunk of a running job's git output (stdout and stderr; `\r` redraws the line).
    Output(String),
    /// Reply to `Watch`: `polling` holds why there are no file events (the UI keeps polling status).
    Watch { polling: Option<String> },
    /// Event (message id 0), not a reply: a watched repo changed.
    Changed(Change),
    Forge(ForgeInfo),
    /// `ForgeCreate` finished: the request's URL (the first https URL the CLI printed), and what it printed.
    Created { url: Option<String>, output: String },
    Cleanup(Cleanup),
    Overview(Overview),
    RebasePlan(RebasePlan),
    Err(String),
}

/// `ForgeProbe`'s answer. Branch names are short (`main`), `upstream` is a full ref (`refs/remotes/origin/x`).
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct ForgeInfo {
    pub remote_url: String,
    pub default_branch: Option<String>,
    pub current_branch: Option<String>,
    pub source: Option<String>,
    pub upstream: Option<String>,
    /// Commits on `source` that are not on its remote branch; None when the remote has no such branch.
    pub ahead: Option<u32>,
    /// The remote's branches (remote-tracking refs, as last fetched).
    pub remote_branches: Vec<String>,
    /// `target..source`, newest first, at most 50.
    pub commits: Vec<CommitText>,
    /// Set when the probe named a forge.
    pub cli: Option<ForgeCli>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct CommitText {
    pub subject: String,
    pub body: String,
}

/// `path` None: not installed where the repo lives. `detail`: the auth check's message (why it is not logged in).
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct ForgeCli {
    pub name: String,
    pub path: Option<String>,
    pub installed: bool,
    pub authenticated: bool,
    pub detail: String,
}

/// HEAD: the branch it points at (full ref name; None when detached) and the commit (None before the first commit).
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Head {
    pub branch: Option<String>,
    pub oid: Option<String>,
}

/// A ref a job changed: `before` None = created, `after` None = deleted.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct RefMove {
    pub name: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Moved {
    pub head_before: Head,
    pub head_after: Head,
    pub refs: Vec<RefMove>,
}

/// Repo top-level dirs found by `ScanRepos`, sorted; `truncated` when a dir/result/time cap stopped the walk.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Scan {
    pub paths: Vec<String>,
    pub truncated: bool,
}

/// `Search`: matching rows in `Log` order, ascending; `truncated` when the limit stopped the search.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct SearchResult {
    pub rows: Vec<u32>,
    pub truncated: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct RepoInfo {
    /// Absolute top-level directory on the machine that holds the repo.
    pub root: String,
    pub name: String,
    /// None when HEAD is detached.
    pub branch: Option<String>,
    /// None for a repo without commits.
    pub oid: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Set when the repo uses Git LFS (`filter=lfs` in its root `.gitattributes`) but git-lfs is not set up on the
    /// machine that holds it: LFS files show as pointer files.
    #[serde(default)]
    pub lfs_warning: Option<String>,
}

/// What changed in a watched repo. `refs`: HEAD, refs, packed-refs or an operation state (merge/rebase) moved;
/// `work`: the worktree or the index. `polling`: the watcher gave up (limit, kernel queue); poll status instead.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Change {
    pub repo: String,
    pub refs: bool,
    pub work: bool,
    #[serde(default)]
    pub polling: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    Branch,
    Remote,
    Tag,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct RefItem {
    /// Short name, e.g. `main`, `origin/main`, `v1.0`.
    pub name: String,
    pub kind: RefKind,
    pub oid: String,
    /// True for the checked-out branch.
    pub head: bool,
    /// Local branches: the upstream's short name (`origin/main`), if one is set.
    #[serde(default)]
    pub upstream: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Stash {
    pub name: String,
    /// The stash commit (its diff against the first parent is the stashed change).
    pub oid: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Submodule {
    pub path: String,
    pub oid: String,
    pub initialized: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Refs {
    pub refs: Vec<RefItem>,
    pub stashes: Vec<Stash>,
    pub submodules: Vec<Submodule>,
    pub worktrees: Vec<Worktree>,
    /// Remote names (`git remote`).
    #[serde(default)]
    pub remotes: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct GraphData {
    /// Parent row indices per commit, in `Log` order.
    pub parents: Vec<Vec<u32>>,
    /// Rows a listed ref or HEAD points at (they stay visible when merges are collapsed).
    pub tips: Vec<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Worktree {
    pub path: String,
    /// Short branch name; None when detached (or bare).
    pub branch: Option<String>,
    pub oid: String,
    /// The worktree this repo was opened from.
    pub current: bool,
}

/// A ref label attached to a commit row.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Label {
    pub name: String,
    pub kind: RefKind,
    pub head: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Commit {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Unix seconds (author date).
    pub time: i64,
    pub subject: String,
    /// Changed files; None until fetched with `Req::Stats` (0 for merges: git reports no stat).
    pub files: Option<u32>,
    pub labels: Vec<Label>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    /// A added, M modified, D deleted, R renamed, C copied, T type changed.
    pub status: String,
    /// None for binary files.
    pub adds: Option<u32>,
    pub dels: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Detail {
    pub oid: String,
    pub tree: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    /// Committer name and date (differs from the author's after a rebase, amend or cherry-pick).
    pub committer: String,
    pub commit_time: i64,
    pub subject: String,
    pub body: String,
    pub files: Vec<FileChange>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Patch {
    pub text: String,
    /// Output was cut at the size limit (cut on a line boundary).
    pub truncated: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TreeKind {
    Tree,
    Blob,
    Commit, // submodule
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct TreeEntry {
    pub name: String,
    pub kind: TreeKind,
    pub size: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Blob {
    /// None for binary content.
    pub text: Option<String>,
    pub size: u64,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct BlameLine {
    pub oid: String,
    pub author: String,
    pub time: i64,
    pub text: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkKind {
    Changed,
    Untracked,
    Conflicted,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct WorkFile {
    pub path: String,
    /// Source path of a staged rename/copy.
    pub old_path: Option<String>,
    /// Index column: `.` unchanged, else A M D R C T (U when conflicted).
    pub index: char,
    /// Worktree column, same letters.
    pub worktree: char,
    pub kind: WorkKind,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Status {
    pub files: Vec<WorkFile>,
    /// More files than we list (see MAX_STATUS in core).
    pub truncated: bool,
    /// A merge is in progress (MERGE_HEAD exists): the prepared message (MERGE_MSG, may be empty).
    pub merge: Option<String>,
    /// Another operation stopped half-way: `rebase`, `cherry-pick` or `revert` (continue/skip/abort with `Sequence`).
    #[serde(default)]
    pub op: Option<String>,
    /// The rebase stopped at an `edit` line: the commit being edited (amend it, then continue).
    #[serde(default)]
    pub edit: Option<String>,
}

/// One index stage of an unmerged file: `mode` as git prints it (`100644`, `100755`, `120000` symlink, `160000`
/// submodule; the blob of a submodule is its `Subproject commit <id>` line).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ConflictSide {
    pub mode: String,
    pub blob: Blob,
}

/// `Conflict`: stage 1 base, 2 ours, 3 theirs (None = not on that side: added or deleted there), the working-tree
/// file (None = missing), and the commits on each side (HEAD; MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD or REBASE_HEAD).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ConflictFile {
    pub base: Option<ConflictSide>,
    pub ours: Option<ConflictSide>,
    pub theirs: Option<ConflictSide>,
    pub merged: Option<Blob>,
    pub ours_commit: Option<String>,
    pub theirs_commit: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ImageData {
    pub mime: String,
    pub base64: String,
    pub size: u64,
}

pub fn encode<T: Serialize>(m: &Msg<T>) -> Vec<u8> {
    let body = rmp_serde::to_vec_named(m).expect("protocol types always serialize");
    let mut v = Vec::with_capacity(body.len() + 4);
    v.extend_from_slice(&(body.len() as u32).to_be_bytes());
    v.extend_from_slice(&body);
    v
}

pub fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<Msg<T>, String> {
    rmp_serde::from_slice(body).map_err(|e| format!("bad frame: {e}"))
}

pub fn check_len(hdr: [u8; 4]) -> Result<usize, String> {
    let n = u32::from_be_bytes(hdr) as usize;
    if n > MAX_FRAME { Err(format!("frame too large: {n} bytes")) } else { Ok(n) }
}

/// Blocking read of one frame body. `Ok(None)` on clean EOF before a header.
pub fn read_frame<R: Read>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut hdr = [0u8; 4];
    match r.read_exact(&mut hdr) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = check_len(hdr).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let m = Msg { id: 7, ms: None, body: Req::Log { repo: "~/x".into(), skip: 5, limit: 500, hidden: vec!["refs/heads/x".into()] } };
        let bytes = encode(&m);
        let body = read_frame(&mut &bytes[..]).unwrap().unwrap();
        let back: Msg<Req> = decode(&body).unwrap();
        assert_eq!(back.id, 7);
        assert!(matches!(back.body, Req::Log { skip: 5, limit: 500, ref hidden, .. } if hidden == &["refs/heads/x"]));
    }

    #[test]
    fn rejects_oversized_header() {
        assert!(check_len(u32::MAX.to_be_bytes()).is_err());
        let bytes = u32::MAX.to_be_bytes();
        assert!(read_frame(&mut &bytes[..]).is_err());
    }

    /// The UI (app/src/lib/types.ts, api.ts) speaks this exact JSON through Tauri; keep both in step.
    #[test]
    fn json_shapes_match_the_ui() {
        let req: Req = serde_json::from_str(r#""Hello""#).unwrap();
        assert!(matches!(req, Req::Hello));
        let req: Req = serde_json::from_str(r#"{"Log":{"repo":"~/x","skip":500,"limit":500}}"#).unwrap();
        assert!(matches!(req, Req::Log { skip: 500, limit: 500, .. }));
        let req: Req = serde_json::from_str(r#"{"Stats":{"repo":"r","oids":["abc"]}}"#).unwrap();
        assert!(matches!(req, Req::Stats { ref oids, .. } if oids == &["abc"]));

        let c = Commit {
            oid: "o".into(), parents: vec![], author: "A".into(), email: "e".into(), time: 1, subject: "s".into(),
            files: None, labels: vec![Label { name: "main".into(), kind: RefKind::Remote, head: true }],
        };
        let json = serde_json::to_value(Resp::Log(vec![c])).unwrap();
        assert_eq!(json["Log"][0]["files"], serde_json::Value::Null);
        assert_eq!(json["Log"][0]["labels"][0]["kind"], "remote");
        let json = serde_json::to_value(Resp::Stats(vec![("o".into(), 3)])).unwrap();
        assert_eq!(json, serde_json::json!({"Stats": [["o", 3]]}));
        assert_eq!(serde_json::to_value(Resp::Count(7)).unwrap(), serde_json::json!({"Count": 7}));

        // M2 shapes (app/src/lib/types.ts: Detail, FileChange, TreeEntry, Blob, BlameLine)
        let req: Req = serde_json::from_str(r#"{"Diff":{"repo":"r","oid":"o","path":"a","old_path":null,"context":3,"ignore_ws":true}}"#).unwrap();
        assert!(matches!(req, Req::Diff { old_path: None, context: 3, ignore_ws: true, .. }));
        let req: Req = serde_json::from_str(r#"{"LineLog":{"repo":"r","oid":"o","path":"a","start":2,"end":9,"limit":50}}"#).unwrap();
        assert!(matches!(req, Req::LineLog { start: 2, end: 9, .. }));
        let img = serde_json::to_value(Resp::Image(ImageData { mime: "image/png".into(), base64: "AA==".into(), size: 1 })).unwrap();
        assert_eq!(img, serde_json::json!({"Image": {"mime":"image/png","base64":"AA==","size":1}}));
        let req: Req = serde_json::from_str(r#"{"FileLog":{"repo":"r","oid":"o","path":"a","skip":0,"limit":100}}"#).unwrap();
        assert!(matches!(req, Req::FileLog { limit: 100, .. }));
        assert_eq!(
            serde_json::to_value(Resp::Graph(GraphData { parents: vec![vec![1, 2], vec![]], tips: vec![0] })).unwrap(),
            serde_json::json!({"Graph": {"parents": [[1, 2], []], "tips": [0]}})
        );
        assert_eq!(serde_json::to_value(Resp::Locate(None)).unwrap(), serde_json::json!({"Locate": null}));
        let d = Detail {
            oid: "o".into(), tree: "t".into(), parents: vec![], author: "A".into(), email: "e".into(), time: 1,
            committer: "C".into(), commit_time: 2, subject: "s".into(), body: "b".into(),
            files: vec![FileChange { path: "p".into(), old_path: None, status: "M".into(), adds: None, dels: Some(2) }],
        };
        let j = serde_json::to_value(Resp::Show(d)).unwrap();
        assert_eq!(j["Show"]["files"][0], serde_json::json!({"path":"p","old_path":null,"status":"M","adds":null,"dels":2}));
        assert_eq!((&j["Show"]["tree"], &j["Show"]["committer"], &j["Show"]["commit_time"]), (&serde_json::json!("t"), &serde_json::json!("C"), &serde_json::json!(2)));
        // F4: optional fields default, so an older UI's requests still parse
        let req: Req = serde_json::from_str(r#"{"Commit":{"repo":"r","message":"m","amend":false,"signoff":true}}"#).unwrap();
        assert!(matches!(req, Req::Commit { signoff: true, no_verify: false, .. }));
        let req: Req = serde_json::from_str(r#"{"WorkDiff":{"repo":"r","path":"p","old_path":null,"staged":false,"untracked":false}}"#).unwrap();
        assert!(matches!(req, Req::WorkDiff { conflicted: false, .. }));
        let st = serde_json::to_value(Resp::Status(Status { files: vec![], truncated: false, merge: Some("Merge x".into()), op: None, edit: None })).unwrap();
        assert_eq!(st, serde_json::json!({"Status": {"files": [], "truncated": false, "merge": "Merge x", "op": null, "edit": null}}));
        let t = serde_json::to_value(Resp::Tree(vec![TreeEntry { name: "n".into(), kind: TreeKind::Commit, size: None }])).unwrap();
        assert_eq!(t, serde_json::json!({"Tree": [{"name":"n","kind":"commit","size":null}]}));
        let b = serde_json::to_value(Resp::Blob(Blob { text: None, size: 3, binary: true, truncated: false })).unwrap();
        assert_eq!(b, serde_json::json!({"Blob": {"text":null,"size":3,"binary":true,"truncated":false}}));
        let bl = serde_json::to_value(Resp::Blame(vec![BlameLine { oid: "o".into(), author: "a".into(), time: 5, text: "t".into() }])).unwrap();
        assert_eq!(bl["Blame"][0]["time"], 5);
        let p = serde_json::to_value(Resp::Diff(Patch { text: "x".into(), truncated: true })).unwrap();
        assert_eq!(p, serde_json::json!({"Diff": {"text":"x","truncated":true}}));
        let req: Req = serde_json::from_str(r#"{"ScanRepos":{"root":"~/p"}}"#).unwrap();
        assert!(matches!(req, Req::ScanRepos { depth: 3, .. }));
        let sc = serde_json::to_value(Resp::Scan(Scan { paths: vec!["/a".into()], truncated: false })).unwrap();
        assert_eq!(sc, serde_json::json!({"Scan": {"paths": ["/a"], "truncated": false}}));
        let req: Req = serde_json::from_str(r#"{"Search":{"repo":"r","query":{"text":["x"],"after":"2024-01-01"},"hidden":[],"limit":1000}}"#).unwrap();
        assert!(matches!(req, Req::Search { ref query, limit: 1000, .. } if query.text == ["x"] && query.after.as_deref() == Some("2024-01-01") && query.file.is_empty()));
        let sr = serde_json::to_value(Resp::Search(SearchResult { rows: vec![0, 4], truncated: true })).unwrap();
        assert_eq!(sr, serde_json::json!({"Search": {"rows": [0, 4], "truncated": true}}));
        // F7: jobs wrap a write request; WorkDiff options default for older UIs
        let req: Req = serde_json::from_str(r#"{"Job":{"job":9,"req":{"Fetch":{"repo":"r","flags":[]}}}}"#).unwrap();
        assert!(matches!(req, Req::Job { job: 9, ref req } if matches!(**req, Req::Fetch { .. })));
        let req: Req = serde_json::from_str(r#"{"Cancel":{"job":9}}"#).unwrap();
        assert!(matches!(req, Req::Cancel { job: 9 }));
        let req: Req = serde_json::from_str(r#"{"WorkDiff":{"repo":"r","path":"p","old_path":null,"staged":false,"untracked":false}}"#).unwrap();
        assert!(matches!(req, Req::WorkDiff { context: 3, ignore_ws: false, .. }));
        let m = Moved { head_before: Head { branch: Some("refs/heads/a".into()), oid: None }, head_after: Head::default(), refs: vec![RefMove { name: "refs/heads/a".into(), before: None, after: Some("o".into()) }] };
        assert_eq!(serde_json::to_value(Resp::Moved(m)).unwrap(), serde_json::json!({"Moved": {
            "head_before": {"branch": "refs/heads/a", "oid": null}, "head_after": {"branch": null, "oid": null},
            "refs": [{"name": "refs/heads/a", "before": null, "after": "o"}]}}));
        assert_eq!(serde_json::to_value(Resp::Output("x\r".into())).unwrap(), serde_json::json!({"Output": "x\r"}));
        // M5a
        let req: Req = serde_json::from_str(r#"{"Reset":{"repo":"r","rev":"refs/heads/main","mode":"hard"}}"#).unwrap();
        assert!(matches!(req, Req::Reset { mode: ResetMode::Hard, .. }));
        let req: Req = serde_json::from_str(r#"{"Sequence":{"repo":"r","action":"skip"}}"#).unwrap();
        assert!(matches!(req, Req::Sequence { action: SeqAction::Skip, .. }));
        let req: Req = serde_json::from_str(r#"{"CreateBranch":{"repo":"r","name":"x","from":null,"checkout":true}}"#).unwrap();
        assert!(matches!(req, Req::CreateBranch { from: None, checkout: true, .. }));
        let r = RefItem { name: "main".into(), kind: RefKind::Branch, oid: "o".into(), head: true, upstream: Some("origin/main".into()) };
        assert_eq!(serde_json::to_value(&r).unwrap()["upstream"], "origin/main");
        // M5b
        let req: Req = serde_json::from_str(r#"{"Push":{"repo":"r","flags":[]}}"#).unwrap();
        assert!(matches!(req, Req::Push { remote: None, branch: None, .. }));
        let req: Req = serde_json::from_str(r#"{"Undo":{"repo":"r","redo":false,"mode":"soft","moved":{"head_before":{"branch":null,"oid":"a"},"head_after":{"branch":null,"oid":"b"},"refs":[]}}}"#).unwrap();
        assert!(matches!(req, Req::Undo { mode: UndoMode::Soft, check: false, ref moved, .. } if moved.head_after.oid.as_deref() == Some("b")));
        let req: Req = serde_json::from_str(r#"{"RenameRemote":{"repo":"r","name":"a","new_name":"b"}}"#).unwrap();
        assert!(matches!(req, Req::RenameRemote { .. }));
        // M6
        let req: Req = serde_json::from_str(r#"{"Rewrite":{"repo":"r","action":"move_down","commits":["a"]}}"#).unwrap();
        assert!(matches!(req, Req::Rewrite { action: RewriteAction::MoveDown, message: None, published_ok: false, .. }));
        let req: Req = serde_json::from_str(r#"{"SaveMerge":{"repo":"r","path":"p","text":"t","stage":true}}"#).unwrap();
        assert!(matches!(req, Req::SaveMerge { stage: true, .. }));
        let side = ConflictSide { mode: "100644".into(), blob: Blob { text: Some("x".into()), size: 1, binary: false, truncated: false } };
        let c = ConflictFile { base: None, ours: Some(side), theirs: None, merged: None, ours_commit: Some("o".into()), theirs_commit: None };
        let j = serde_json::to_value(Resp::Conflict(c)).unwrap();
        assert_eq!(j["Conflict"]["ours"]["mode"], "100644");
        assert_eq!(j["Conflict"]["base"], serde_json::Value::Null);
        // branch cleanup
        let req: Req = serde_json::from_str(r#"{"CleanupCandidates":{"repo":"r","stale_days":90}}"#).unwrap();
        assert!(matches!(req, Req::CleanupCandidates { stale_days: 90, ref protected, .. } if protected.is_empty()));
        let req: Req = serde_json::from_str(r#"{"DeleteBranches":{"repo":"r","merged":["a"],"unmerged":[]}}"#).unwrap();
        assert!(matches!(req, Req::DeleteBranches { ref merged, .. } if merged == &["a"]));
        let c = Cleanup { default_branch: Some("main".into()), truncated: false, branches: vec![CleanupBranch { name: "refs/heads/a".into(), merged: true, ..Default::default() }] };
        let j = serde_json::to_value(Resp::Cleanup(c)).unwrap();
        assert_eq!((&j["Cleanup"]["default_branch"], &j["Cleanup"]["branches"][0]["remote"]), (&serde_json::json!("main"), &serde_json::Value::Null));
        assert_eq!(j["Cleanup"]["branches"][0]["merged"], true);
        // interactive rebase
        let req: Req = serde_json::from_str(r#"{"InteractiveRebase":{"repo":"r","base":null,"head":"h","steps":[{"oid":"a","action":"fixup"},{"oid":"b","action":"reword","message":"m"}]}}"#).unwrap();
        assert!(matches!(req, Req::InteractiveRebase { base: None, published_ok: false, ref steps, .. }
            if steps[0] == RebaseStep { oid: "a".into(), action: TodoAction::Fixup, message: None } && steps[1].message.as_deref() == Some("m")));
        let req: Req = serde_json::from_str(r#"{"RebasePlan":{"repo":"r"}}"#).unwrap();
        assert!(matches!(req, Req::RebasePlan { from: None, .. }));
        let p = RebasePlan { base: None, head: "h".into(), branch: Some("main".into()), commits: vec![RebaseCommit { oid: "a".into(), published: true, ..Default::default() }] };
        let j = serde_json::to_value(Resp::RebasePlan(p)).unwrap();
        assert_eq!((&j["RebasePlan"]["base"], &j["RebasePlan"]["commits"][0]["published"]), (&serde_json::Value::Null, &serde_json::json!(true)));
    }

    #[test]
    fn jobs_roundtrip_msgpack() {
        let m = Msg { id: 3, ms: None, body: Req::Job { job: 7, req: Box::new(Req::Push { repo: "r".into(), flags: vec!["--force".into()], remote: None, branch: None }) } };
        let back: Msg<Req> = decode(&read_frame(&mut &encode(&m)[..]).unwrap().unwrap()).unwrap();
        assert!(matches!(back.body, Req::Job { job: 7, ref req } if matches!(**req, Req::Push { ref flags, .. } if flags == &["--force"])));
    }

    #[test]
    fn clean_eof_is_none() {
        assert!(read_frame(&mut &[][..]).unwrap().is_none());
    }
}

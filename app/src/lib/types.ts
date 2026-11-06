// Mirrors crates/protocol (serde JSON; enums are externally tagged).
import type { SearchQuery } from "./search";
import type { Moved, UndoMode } from "./journal";
import type { RebaseCommit, Step as RebaseStep } from "./rebase";
export type RefKind = "branch" | "remote" | "tag";
/** `lfs_warning`: the repo uses Git LFS but git-lfs is missing/not set up where it lives (pointer files show) */
export interface RepoInfo { root: string; name: string; branch: string | null; oid: string | null; ahead: number; behind: number; lfs_warning?: string | null }
/** A watched repo changed (`repo-changed`): `refs` = HEAD/refs/operation state, `work` = worktree/index; `polling` = the watcher gave up */
export interface RepoChange { location: string; repo: string; refs: boolean; work: boolean; polling?: string | null }
/** `upstream`: a local branch's upstream short name (`origin/main`) */
export interface RefItem { name: string; kind: RefKind; oid: string; head: boolean; upstream?: string | null }
export interface Stash { name: string; oid: string; message: string }
export interface Submodule { path: string; oid: string; initialized: boolean }
/** `Graph` response: parent rows per commit, and the rows refs point at */
export interface GraphData { parents: number[][]; tips: number[] }
export interface Worktree { path: string; branch: string | null; oid: string; current: boolean }
export interface Refs { refs: RefItem[]; stashes: Stash[]; submodules: Submodule[]; worktrees: Worktree[]; remotes: string[] }
export interface Label { name: string; kind: RefKind; head: boolean }
export interface Commit {
  oid: string; parents: string[]; author: string; email: string; time: number;
  subject: string; files: number | null; labels: Label[];
}
export type Req =
  | "Hello"
  | { Open: { path: string } }
  | { Refs: { repo: string } }
  | { Count: { repo: string; hidden: string[] } }
  | { Log: { repo: string; skip: number; limit: number; hidden: string[] } }
  | { Stats: { repo: string; oids: string[] } }
  | { Graph: { repo: string; hidden: string[] } }
  | { Locate: { repo: string; oid: string; hidden: string[] } }
  | { Show: { repo: string; oid: string; from: string | null } }
  | { Diff: { repo: string; oid: string; path: string; old_path: string | null; context: number; ignore_ws: boolean; from: string | null } }
  | { LineLog: { repo: string; oid: string; path: string; start: number; end: number; limit: number } }
  | { Image: { repo: string; rev: string; path: string } }
  | { Tree: { repo: string; oid: string; path: string } }
  | { Blob: { repo: string; oid: string; path: string } }
  | { ReadFile: { repo: string; rev: string; path: string } }
  | { Files: { repo: string; oid: string } }
  | { FileLog: { repo: string; oid: string; path: string; skip: number; limit: number } }
  | { Blame: { repo: string; oid: string; path: string } }
  | { Status: { repo: string } }
  | { WorkDiff: { repo: string; path: string; old_path: string | null; staged: boolean; untracked: boolean; conflicted: boolean; context: number; ignore_ws: boolean } }
  | { Stage: { repo: string; paths: string[] } }
  | { Unstage: { repo: string; paths: string[] } }
  | { Discard: { repo: string; paths: string[] } }
  | { Apply: { repo: string; patch: string; mode: ApplyMode } }
  | { Commit: { repo: string; message: string; amend: boolean; signoff: boolean; no_verify: boolean } }
  | { Identity: { repo: string } }
  | { SetIdentity: { repo: string; name: string; email: string } }
  | { AbortMerge: { repo: string } }
  | { Resolve: { repo: string; path: string; theirs: boolean } }
  | { Ignore: { repo: string; path: string } }
  | { Stash: { repo: string; flags: string[] } }
  | { PopStash: { repo: string } }
  | { Pull: { repo: string; flags: string[] } }
  /** `remote`: that remote only */
  | { Fetch: { repo: string; flags: string[]; remote?: string | null } }
  /** `remote` + `branch`: push that branch to its upstream there (or the same name, setting the upstream) */
  | { Push: { repo: string; flags: string[]; remote?: string | null; branch?: string | null } }
  | { Checkout: { repo: string; name: string } }
  | { AddWorktree: { repo: string; path: string; branch: string | null } }
  | { AddSubmodule: { repo: string; url: string; path: string | null } }
  /** `path`: only that submodule */
  | { UpdateSubmodules: { repo: string; init: boolean; path?: string | null } }
  | { SyncSubmodules: { repo: string; path?: string | null } }
  | { ScanRepos: { root: string; depth: number } }
  | { Search: { repo: string; query: SearchQuery; hidden: string[]; limit: number } }
  /** a write as console job `job`; its output arrives as `job-output` events */
  | { Job: { job: number; req: Req } }
  | { Cancel: { job: number } }
  // M5a: `rev`/`from`/`onto`/`base`/`tip` are commit ids or full ref names (refs/heads|remotes|tags/...); names are short
  | { CreateBranch: { repo: string; name: string; from: string | null; checkout: boolean } }
  | { RenameBranch: { repo: string; branch: string; name: string } }
  | { DeleteBranch: { repo: string; branch: string; force: boolean } }
  | { DeleteRemoteBranch: { repo: string; branch: string } }
  | { Merge: { repo: string; rev: string; flags: string[] } }
  | { Rebase: { repo: string; onto: string } }
  | { CherryPick: { repo: string; rev: string } }
  | { Revert: { repo: string; rev: string } }
  | { Reset: { repo: string; rev: string; mode: "soft" | "mixed" | "keep" | "hard" } }
  | { CreateTag: { repo: string; name: string; rev: string; message: string | null } }
  | { DeleteTag: { repo: string; name: string } }
  | { PushTag: { repo: string; remote: string; name: string } }
  | { DeleteRemoteTag: { repo: string; remote: string; name: string } }
  | { SetUpstream: { repo: string; branch: string; upstream: string | null } }
  | { Sequence: { repo: string; action: "continue" | "skip" | "abort" } }
  | { CountRange: { repo: string; base: string; tip: string } }
  // M5b: Undo/Redo a journal entry (`check`: only validate, a read); remotes
  | { Undo: { repo: string; moved: Moved; redo: boolean; mode: UndoMode; check: boolean } }
  | { AddRemote: { repo: string; name: string; url: string } }
  | { RenameRemote: { repo: string; name: string; new_name: string } }
  | { DeleteRemote: { repo: string; name: string } }
  | { SetRemoteUrl: { repo: string; name: string; url: string } }
  // F8: a stash by entry (`oid` must still match `stash`), all stashes, a remote's URL (a read: `Text`)
  | { StashOp: { repo: string; stash: string; oid: string; action: "apply" | "pop" | "drop" } }
  | { ClearStashes: { repo: string } }
  | { RemoteUrl: { repo: string; name: string } }
  // M6: an unmerged file's stages (a read), the merge tool's save, commit editing by scripted rebase
  | { Conflict: { repo: string; path: string } }
  | { SaveMerge: { repo: string; path: string; text: string; stage: boolean } }
  /** refused with an error starting "PUBLISHED" when the commits are on a remote branch, unless `published_ok` */
  | { Rewrite: { repo: string; action: RewriteAction; commits: string[]; message: string | null; published_ok: boolean } }
  // M7b: replies `{ Text: <the repository folder> }`
  | { Init: { path: string } }
  | { Clone: { url: string; parent: string; name: string | null } }
  | { GitCustom: { repo: string; argv: string[] } }
  | { ForgeProbe: { repo: string; remote: string; source: string | null; target: string | null; forge: "github" | "gitlab" | null; host: string | null; cli_path: string | null } }
  | { ForgeCreate: ForgeRequest }
  // branch cleanup: candidates (a read, `{ Cleanup }`), then the deletes (local: short names; remote: full refs)
  | { CleanupCandidates: { repo: string; stale_days: number; protected: string[] } }
  | { DeleteBranches: { repo: string; merged: string[]; unmerged: string[] } }
  | { DeleteRemoteBranches: { repo: string; branches: string[] } }
  // the dashboard: a read, `{ Overview }`
  | { Overview: { repo: string } }
  // interactive rebase: the editor's list (a read, `{ RebasePlan }`), then the todo as one job; `base` null = from the
  // root, `head` = HEAD as the plan saw it; refused with "PUBLISHED…" like Rewrite unless `published_ok`
  | { RebasePlan: { repo: string; from: string | null } }
  | { InteractiveRebase: { repo: string; base: string | null; head: string; steps: RebaseStep[]; published_ok: boolean } };

/** commits oldest first; `base` null when the oldest is a root commit */
export interface RebasePlan { base: string | null; head: string; branch: string | null; commits: RebaseCommit[] }

export type RewriteAction = "reword" | "edit" | "squash" | "fixup" | "move_up" | "move_down" | "drop";
/** `mode`: 100644, 100755, 120000 (symlink) or 160000 (submodule) */
export interface ConflictSide { mode: string; blob: Blob }
/** stage 1 base, 2 ours, 3 theirs (null = not on that side), the working-tree file, and each side's commit */
export interface ConflictFile { base: ConflictSide | null; ours: ConflictSide | null; theirs: ConflictSide | null; merged: Blob | null; ours_commit: string | null; theirs_commit: string | null }

/** discard = reverse into the worktree (also reverts a commit's hunk/file); worktree = forward into it (cherry-picks one) */
export type ApplyMode = "stage" | "unstage" | "discard" | "worktree";
export type WorkKind = "changed" | "untracked" | "conflicted";
export interface WorkFile { path: string; old_path: string | null; index: string; worktree: string; kind: WorkKind }
/** `merge`: a merge is in progress; its prepared message (MERGE_MSG) */
/** `op`: a rebase, cherry-pick or revert stopped half-way ("rebase" | "cherry-pick" | "revert") */
/** `edit`: the rebase stopped at an `edit` line, at this commit (amend it, then continue) */
export interface Status { files: WorkFile[]; truncated: boolean; merge: string | null; op?: string | null; edit?: string | null }

export interface FileChange { path: string; old_path: string | null; status: string; adds: number | null; dels: number | null }
export interface Detail {
  oid: string; tree: string; parents: string[]; author: string; email: string; time: number;
  committer: string; commit_time: number;
  subject: string; body: string; files: FileChange[];
}
export interface Patch { text: string; truncated: boolean }
export interface TreeEntry { name: string; kind: "tree" | "blob" | "commit"; size: number | null }
export interface Blob { text: string | null; size: number; binary: boolean; truncated: boolean }
export interface BlameLine { oid: string; author: string; time: number; text: string }

/** A file version: `rev` is a commit id, "HEAD", "index" or "worktree". */
export interface FileRev { rev: string; path: string }
export interface ImageData { mime: string; base64: string; size: number }

/** The dashboard's row (crates/protocol Overview): `upstream` null when none is set or it is gone; `changed` files
 *  (untracked included); `time` (unix seconds) and `subject` of HEAD, null before the first commit */
export interface Overview { branch: string | null; upstream: string | null; ahead: number; behind: number; changed: number; truncated: boolean; time: number | null; subject: string | null }

/** ScanRepos: repo top-level dirs, sorted; `truncated` when a size/time cap stopped the walk */
export interface Scan { paths: string[]; truncated: boolean }
/** A pull/merge request for `gh pr create` / `glab mr create` (crates/protocol ForgeRequest) */
export interface ForgeRequest {
  repo: string; forge: "github" | "gitlab"; host: string; project: string; cli_path: string | null; source: string; target: string;
  title: string; body: string; draft: boolean; remove_source_branch: boolean; squash: boolean; reviewers: string[]; labels: string[]; assignees: string[];
}
/** `path` null: the CLI is not installed where the repo lives */
export interface ForgeCli { name: string; path: string | null; installed: boolean; authenticated: boolean; detail: string }
/** ForgeProbe's answer: `upstream` a full ref, `ahead` null when the remote has no such branch, `commits` newest first */
export interface ForgeInfo {
  remote_url: string; default_branch: string | null; current_branch: string | null; source: string | null; upstream: string | null;
  ahead: number | null; remote_branches: string[]; commits: { subject: string; body: string }[]; cli: ForgeCli | null;
}

/** Search: matching rows in Log order (ascending); `truncated` when the limit stopped it */
export interface SearchResult { rows: number[]; truncated: boolean }

/** A downloadable commit message model (crates/llm catalog) and where it stands. */
export interface ModelInfo { id: string; name: string; note: string; bytes: number; installed: boolean; downloading: boolean }
/** Event `llm-download`. */
export interface DownloadEvent { id: string; state: "progress" | "done" | "cancelled" | "error"; done: number; total: number; error: string | null }

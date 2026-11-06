// Context menus: our own grouping (the action you most likely want first, copy and visibility last), built on
// compatible command names so user menu files keep working. Captions and args use `$vars` filled per target by
// `fillMenu` (menu.ts); `visible` drops items that do not apply. Commands we lack show disabled. Pure and import-free.
import { MAIN_MENU, mergeMenu, type MenuDef } from "./menu.ts";

const SEP: MenuDef = { caption: "-" };
const palette = (command: string, args?: Record<string, unknown>): Pick<MenuDef, "command" | "args"> =>
  ({ command: "show_command_palette", args: args ? { command, args } : { command } });
const copy = (caption: string, text: string): MenuDef => ({ caption, command: "copy_to_clipboard", args: { text } });

const VISIBILITY: MenuDef[] = [
  { caption: "Hide $branch in the Graph", command: "hide_ref", args: { ref: "$ref" }, visible: "!hidden" },
  { caption: "Show $branch in the Graph", command: "show_ref", args: { ref: "$ref" }, visible: "hidden" },
  { caption: "Show Only $branch", command: "hide_all_refs_except", args: { ref: "$ref" } },
  { caption: "Show All Branches", command: "show_all_refs", visible: "any_hidden" },
];

/** A local branch. vars: branch, ref (refs/heads/…), head_ref (current branch or HEAD), head, hidden, any_hidden,
 *  request ("Pull Request", "Merge Request" or "Pull/Merge Request") */
const BRANCH_ITEMS: MenuDef[] = [
  { caption: "Check Out $branch", command: "checkout_branch", args: { branch: "$ref" } },
  { caption: "Merge $branch into $head_ref…", command: "merge_branch", args: { branch: "$ref" }, visible: "!head" },
  { caption: "Rebase $head_ref onto $branch", command: "rebase_branch", args: { branch: "$ref" }, visible: "!head" },
  { caption: "Create $request from $branch…", command: "create_pull_request", args: { branch: "$branch" } },
];
const BRANCH_MANAGE: MenuDef[] = [
  { caption: "Rename $branch…", ...palette("rename_branch", { branch: "$branch" }) },
  { caption: "Set Upstream…", ...palette("set_upstream", { branch: "$branch" }) },
  { caption: "Unset Upstream", command: "unset_upstream", args: { branch: "$branch" } },
  { caption: "Delete $branch", command: "delete_branch", args: { ref: "$ref" } },
];
const BRANCH_FIND: MenuDef[] = [
  { caption: "Find Commits on $branch…", command: "search", args: { query: "branch:$branch " } },
  copy("Copy Branch Name", "$branch"),
];
export const BRANCH: MenuDef[] = [...BRANCH_ITEMS, SEP, ...BRANCH_MANAGE, SEP, ...BRANCH_FIND, SEP, ...VISIBILITY];

/** A remote-tracking branch. vars: branch (origin/x), ref, head_ref, tracked (a local branch of that name exists), hidden, any_hidden */
const REMOTE_BRANCH_ITEMS: MenuDef[] = [
  { caption: "Check Out $branch", command: "checkout_branch", args: { branch: "$ref" }, visible: "!tracked" },
  { caption: "New Branch from $branch…", ...palette("create_branch", { from: "$ref" }), visible: "!tracked" },
  { caption: "Merge $branch into $head_ref…", command: "merge_branch", args: { branch: "$ref" }, visible: "!tracked" },
  { caption: "Rebase $head_ref onto $branch", command: "rebase_branch", args: { branch: "$ref" }, visible: "!tracked" },
  { caption: "Delete $branch", command: "delete_branch", args: { ref: "$ref" } },
  copy("Copy Branch Name", "$branch"),
];
export const REMOTE_BRANCH: MenuDef[] = [...REMOTE_BRANCH_ITEMS, SEP, ...VISIBILITY];

/** A branch folder (`feature/`). vars: branch (the folder path). Hiding a whole folder is not supported. */
export const BRANCH_FOLDER: MenuDef[] = [
  { caption: "New Branch in $branch…", ...palette("create_branch", { prefix: "$branch" }) },
  copy("Copy Folder Name", "$branch"),
];
export const REMOTE_BRANCH_FOLDER: MenuDef[] = [copy("Copy Folder Name", "$branch")];

/** A remote (the top folder under REMOTES). vars: remote */
export const REMOTE: MenuDef[] = [
  { caption: "Fetch $remote", command: "fetch", args: { remote: "$remote" } },
  { caption: "Copy URL", command: "copy_remote_url", args: { remote: "$remote" } },
  { caption: "Change URL…", ...palette("update_remote_url", { remote: "$remote" }) },
  { caption: "Rename $remote…", ...palette("rename_remote", { remote: "$remote" }) },
  SEP,
  { caption: "Remove $remote", command: "delete_remote", args: { remote: "$remote" } },
];

/** A tag. vars: tag_name, ref (refs/tags/…); then one REMOTE_TAG per remote (vars: remote) after a separator */
export const TAG: MenuDef[] = [
  { caption: "Check Out $tag_name", command: "checkout_branch", args: { branch: "$ref" } },
  { caption: "New Branch from $tag_name…", ...palette("create_branch_from_tag", { from: "$ref" }) },
  { caption: "Push $tag_name…", ...palette("push_tag", { ref: "$ref" }) },
  copy("Copy Tag Name", "$tag_name"),
  SEP,
  { caption: "Delete $tag_name", command: "delete_tag", args: { ref: "$ref" } },
];
export const remoteTags = (remotes: string[]): MenuDef[] => remotes.map((remote) =>
  ({ caption: `Delete $tag_name on ${remote}`, command: "delete_tag_on_remote", args: { ref: "$ref", remote } }));

/** A stash. vars: stash (stash@{n}), oid */
export const STASH: MenuDef[] = [
  { caption: "Apply Stash", command: "apply_stash", args: { stash: "$stash", oid: "$oid" } },
  { caption: "Apply and Drop (Pop)", command: "pop_stash", args: { stash: "$stash", oid: "$oid" } },
  SEP,
  { caption: "Drop Stash", command: "drop_stash", args: { stash: "$stash", oid: "$oid" } },
];

/** vars: submodule_name, submodule_path, initialized */
export const SUBMODULE: MenuDef[] = [
  { caption: "Open $submodule_name", command: "open_submodule", args: { submodule_path: "$submodule_path" }, visible: "initialized" },
  { caption: "Initialize $submodule_name", command: "update_submodule", args: { submodule_path: "$submodule_path", initialize: true }, visible: "!initialized" },
  { caption: "Update $submodule_name", command: "update_submodule", args: { submodule_path: "$submodule_path" }, visible: "initialized" },
  { caption: "Sync $submodule_name URL", command: "sync_submodule", args: { submodule_path: "$submodule_path" }, visible: "initialized" },
];

/** vars: worktree_name, worktree_path, current */
export const WORKTREE: MenuDef[] = [
  { caption: "Open $worktree_name", command: "open_worktree", args: { worktree_path: "$worktree_path" }, visible: "!current" },
  copy("Copy Worktree Name", "$worktree_name"),
];

/** Section headers in Locations (and their gear buttons). */
export const SECTIONS: Record<string, MenuDef[]> = {
  branch: [{ caption: "New Branch…", ...palette("create_branch") }, { caption: "Clean Up Branches…", command: "cleanup_branches" }],
  remote: [{ caption: "Add Remote…", ...palette("add_remote") }, { caption: "Clean Up Branches…", command: "cleanup_branches" }],
  tag: [{ caption: "New Tag…", ...palette("create_tag") }],
  stashes: [{ caption: "Clear All Stashes", command: "clear_stashes" }],
  // vars: uninitialized (some submodule is not)
  submodules: [
    { caption: "Add Submodule…", ...palette("add_submodule") },
    { caption: "Initialize All Submodules", command: "update_submodule", args: { initialize: true }, visible: "uninitialized" },
    { caption: "Update All Submodules", command: "update_submodule" },
    { caption: "Sync All Submodule URLs", command: "sync_submodule" },
  ],
  worktrees: [{ caption: "Add Worktree…", ...palette("add_worktree") }],
};

/**
 * A commit row: a section per local branch on it (BRANCH_ON_COMMIT), per remote branch (REMOTE_BRANCH_ON_COMMIT),
 * per tag (TAG), then COMMIT. vars: commit, short_commit, head_ref, multi (several rows selected: commits = their
 * ids), is_head (HEAD's commit), refs (refs point at it)
 */
export const BRANCH_ON_COMMIT: MenuDef[] = [...BRANCH_ITEMS, ...BRANCH_MANAGE, ...BRANCH_FIND];
export const REMOTE_BRANCH_ON_COMMIT: MenuDef[] = REMOTE_BRANCH_ITEMS;
export const COMMIT: MenuDef[] = [
  { caption: "Check Out This Commit", command: "checkout_branch", args: { branch: "$commit" } },
  { caption: "New", id: "new", aliases: ["create"], children: [
    { caption: "Branch Here…", ...palette("create_branch", { from: "$commit" }) },
    { caption: "Tag Here…", ...palette("create_tag", { commit: "$commit" }) },
  ] },
  SEP,
  { caption: "Cherry-pick $short_commit…", ...palette("cherry_pick", { commit: "$commit" }), visible: "!multi" },
  { caption: "Cherry-pick Selected Commits", command: "cherry_pick_commits", args: { commits: "$commits" }, visible: "multi" },
  { caption: "Revert $short_commit", command: "revert_commit", args: { commit: "$commit" }, visible: "!multi" },
  { caption: "Revert Selected Commits", command: "revert_commits", args: { commits: "$commits" }, visible: "multi" },
  { caption: "Rebase $head_ref onto This Commit", command: "rebase_branch", args: { commit: "$commit" }, visible: "!multi !is_head" },
  { caption: "Rebase Interactively from Here…", command: "interactive_rebase", args: { commit: "$commit" }, visible: "!multi" },
  { caption: "Rewrite History", id: "rewrite", aliases: ["edit"], children: [
    { caption: "Edit Message", command: "edit_commit", args: { commit: "$commit" }, visible: "!multi" },
    { caption: "Edit Contents", command: "edit_commit_contents", args: { commit: "$commit" }, visible: "!multi" },
    { caption: "Squash into Parent", command: "squash_commit", args: { commit: "$commit" }, visible: "!multi" },
    { caption: "Squash Selected", command: "squash_commits", args: { commits: "$commits" }, visible: "multi" },
    { caption: "Squash Selected, Keep First Message (fixup)", command: "fixup_commits", args: { commits: "$commits" }, visible: "multi" },
    { caption: "Move Up", command: "move_commit", args: { commit: "$commit", down: false }, visible: "!multi" },
    { caption: "Move Down", command: "move_commit", args: { commit: "$commit", down: true }, visible: "!multi" },
    { caption: "Drop Selected", command: "drop_commits", args: { commits: "$commits" } },
  ] },
  { caption: "Reset $head_ref to Here", id: "reset", children: [
    { caption: "Soft: keep the index and files, the difference shows as staged", command: "reset", args: { commit: "$commit", mode: "soft" } },
    { caption: "Mixed (default): keep the files, the difference shows as unstaged", command: "reset", args: { commit: "$commit", mode: "mixed" } },
    { caption: "Keep: reset the index and files, stop if local changes would be lost", command: "reset", args: { commit: "$commit", mode: "keep" } },
    { caption: "Hard: reset the index and files, ALL local changes are lost", command: "reset", args: { commit: "$commit", mode: "hard" } },
  ] },
  SEP,
  copy("Copy Commit Hash", "$commit"),
  SEP,
  { caption: "Hide Branches on This Commit", command: "hide_all_commit_refs", args: { commit: "$commit" }, visible: "!multi refs" },
  { caption: "Show Only Branches on This Commit", command: "hide_all_refs_except_refs_at_commit", args: { commit: "$commit" }, visible: "!multi refs" },
  { caption: "Show All Branches", command: "show_all_refs" },
];

/** Any file. vars: path, commit (the version to blame; none = HEAD), exists (there to open), tracked (in that version) */
export const FILE: MenuDef[] = [
  { caption: "Open in Editor…", command: "open_in_editor", args: { path: "$path" }, visible: "exists" },
  { caption: "$reveal", command: "open_dir", args: { path: "$path" }, visible: "exists" },
  copy("Copy File Path", "$path"),
  SEP,
  { caption: "File History", command: "search", args: { query: "file:\"$path\"" } },
  { caption: "Blame", command: "blame", args: { path: "$path", from: "$commit" }, visible: "tracked" },
];
/** A file of a commit (after FILE). vars: path, old_path, commit, from (multi-selection: its oldest) */
export const COMMIT_FILE: MenuDef[] = [
  { caption: "Revert Changes to This File", command: "revert_file", args: { path: "$path", old_path: "$old_path", commit: "$commit", from: "$from" } },
  { caption: "Cherry-pick This File", command: "cherry_pick_file", args: { path: "$path", old_path: "$old_path", commit: "$commit", from: "$from" } },
];
/** Working directory files by status (before FILE). vars: path */
export const MODIFIED_FILE: MenuDef[] = [
  { caption: "Stage File", command: "stage_file", args: { path: "$path" } },
  { caption: "Discard Changes…", command: "discard_file", args: { path: "$path" } },
];
export const UNTRACKED_FILE: MenuDef[] = [
  { caption: "Stage File", command: "stage_file", args: { path: "$path" } },
  { caption: "Ignore $path", command: "ignore_file", args: { path: "$path" } },
  { caption: "Delete File…", command: "delete_file", args: { path: "$path" } },
];
export const STAGED_FILE: MenuDef[] = [
  { caption: "Unstage File", command: "unstage_file", args: { path: "$path" } },
];
export const UNMERGED_FILE: MenuDef[] = [
  { caption: "Resolve Conflict", command: "resolve_merge_conflict", args: { path: "$path" } },
  { caption: "Take Ours", command: "resolve_merge_conflict", args: { path: "$path", mode: "ours" } },
  { caption: "Take Theirs", command: "resolve_merge_conflict", args: { path: "$path", mode: "theirs" } },
  { caption: "Stage File (Mark Resolved)", command: "stage_file", args: { path: "$path" } },
];
/** The `…` of a commit diff's hunk band. vars: path, patch_revert, patch_pick (patches built for that hunk) */
export const HUNK: MenuDef[] = [
  { caption: "Revert This Hunk", command: "revert_diff_hunk", args: { path: "$path", patch: "$patch_revert" } },
  { caption: "Cherry-pick This Hunk", command: "cherrypick_hunk", args: { path: "$path", patch: "$patch_pick" } },
];
/** An image in a diff. vars: path, exists, reveal */
export const IMAGE: MenuDef[] = [
  { caption: "Open in Editor…", command: "open_in_editor", args: { path: "$path" }, visible: "exists" },
  { caption: "$reveal", command: "open_dir", args: { path: "$path" }, visible: "exists" },
  copy("Copy File Path", "$path"),
];
/** A repository tab. vars: index */
export const TAB: MenuDef[] = [
  { caption: "Set Alias…", command: "set_alias", args: { index: "$index" } },
  SEP,
  { caption: "Close Tab", command: "close_by_index", args: { index: "$index" } },
];
/** A console row. vars: job, label, output, active (queued or running) */
export const CONSOLE_JOB: MenuDef[] = [
  { caption: "Cancel", command: "cancel_job", args: { job: "$job" }, visible: "active" },
  copy("Copy Command", "$label"),
  { ...copy("Copy Output", "$output"), visible: "output" },
];
/** The commit summary's `…`. vars: commit, message, tree */
export const COMMIT_SUMMARY: MenuDef[] = [
  copy("Copy Commit Hash", "$commit"),
  copy("Copy Message", "$message"),
  copy("Copy Tree Hash", "$tree"),
];
/** The toolbar's `…`. vars: repo_path, request (as in BRANCH) */
export const ACTIONS: MenuDef[] = [
  { caption: "New Branch…", ...palette("create_branch") },
  { caption: "Merge into Current Branch…", ...palette("merge_branch") },
  { caption: "Create $request…", command: "create_pull_request" },
  SEP,
  { caption: "Undo", command: "git_undo" },
  { caption: "Redo", command: "git_redo" },
  SEP,
  { caption: "$reveal", command: "open_dir" },
  { caption: "Open Repository in Editor", command: "open_dir_in_editor" },
  { caption: "Open Repository in Terminal", command: "open_terminal" },
  copy("Copy Repository Path", "$repo_path"),
];

/** A working directory file's menu (Files column, the file block's `…`): its status's items, then FILE. */
export function workFileMenu(f: { path: string; kind: string; index: string; worktree: string }, staged: boolean): [MenuDef[], Record<string, unknown>] {
  const status = f.kind === "conflicted" ? UNMERGED_FILE : f.kind === "untracked" ? UNTRACKED_FILE : staged ? STAGED_FILE : MODIFIED_FILE;
  return [joinMenus(status, FILE), { path: f.path, exists: f.worktree !== "D", tracked: f.kind !== "untracked" && f.index !== "A" }];
}
/** A commit's file; a stash's files get FILE only. `from`: the oldest commit of a multi-selection. */
export function commitFileMenu(f: { path: string; old_path: string | null; status: string }, commit: string, from: string | null, stash: boolean): [MenuDef[], Record<string, unknown>] {
  const there = f.status !== "D";
  return [stash ? FILE : joinMenus(COMMIT_FILE, FILE), { path: f.path, old_path: f.old_path, commit, from, exists: there, tracked: there }];
}

/** Sections joined with separators (the commit menu, a file's FILE + status part). */
export const joinMenus = (...parts: MenuDef[][]): MenuDef[] => parts.filter((p) => p.length).flatMap((p, i) => (i ? [SEP, ...p] : p));

/** The menu files a user can add to (`<name>.menu.json`; an older `<name>.sublime-menu` is read while the new file
 *  does not exist) -> the menus they extend. */
export const MENU_FILES: Record<string, MenuDef[][]> = Object.fromEntries(Object.entries({
  Main: [MAIN_MENU], Action: [ACTIONS],
  Branch: [BRANCH, BRANCH_ON_COMMIT], "Branch Folder": [BRANCH_FOLDER], "Branch Section": [SECTIONS.branch],
  Commit: [COMMIT], "Commit File": [COMMIT_FILE], File: [FILE], Hunk: [HUNK],
  "Image Context": [IMAGE], "Index File": [STAGED_FILE], "Modified File": [MODIFIED_FILE],
  "Untracked File": [UNTRACKED_FILE], "Unmerged File": [UNMERGED_FILE],
  Remote: [REMOTE], "Remote Section": [SECTIONS.remote],
  "Remote Branch": [REMOTE_BRANCH, REMOTE_BRANCH_ON_COMMIT], "Remote Branch Folder": [REMOTE_BRANCH_FOLDER],
  Stash: [STASH], "Stash Section": [SECTIONS.stashes],
  Submodule: [SUBMODULE], "Submodule Section": [SECTIONS.submodules],
  Tag: [TAG], "Tag Section": [SECTIONS.tag], "Tab Context": [TAB],
}).map(([name, menus]) => [`${name}.menu.json`, menus]));
const ORIGINAL = new Map<MenuDef[], MenuDef[]>(Object.values(MENU_FILES).flat().map((m) => [m, [...m]]));

/** The user's menu files (parsed, by file name; a missing name = no additions) merged over the defaults, in place,
 *  so every menu built from these lists afterwards includes them. Calling it again starts from the defaults. */
export function applyUserMenus(files: Record<string, unknown[]>): void {
  for (const [name, menus] of Object.entries(MENU_FILES)) for (const m of menus) m.splice(0, m.length, ...mergeMenu(ORIGINAL.get(m)!, files[name] ?? []));
}

// The command palette's entries: our default list (grouped by a category prefix), then the user's `commands.json`,
// then captions our own commands carry. Command names and args are the compatible ones, so a user's commands file
// and key bindings keep working. Entries whose command is not available right now are left out (not shown
// disabled). Pure.
import { parseJsonc } from "./jsonc.ts";

export interface PaletteEntry { caption: string; command: string; args?: Record<string, unknown> }
export interface PaletteItem { label: string; detail?: string; command: string; args: Record<string, unknown> }

const e = (caption: string, command: string, args?: Record<string, unknown>): PaletteEntry => ({ caption, command, ...(args ? { args } : {}) });

/** "Category: Caption\tdetail": the text after a tab is shown on the right (what it runs, or what it is for). */
export const DEFAULT_PALETTE: PaletteEntry[] = [
  // Repository
  e("Repository: Switch…\topen tabs and recent repositories", "quick_switch_repository"),
  e("Repository: Show Folder\tin the file manager", "open_dir", { dir: "$working_dir" }),
  e("Repository: Open in Terminal", "open_terminal", { dir: "$working_dir" }),
  e("Repository: Add Submodule…\tgit submodule add", "add_submodule"),
  e("Repository: Open Submodule…\tin a new tab", "open_submodule"),
  e("Repository: Add Worktree…\tgit worktree add", "add_worktree"),
  e("Repository: Open Worktree…\tin a new tab", "open_worktree"),
  // Branches
  e("Branch: Check Out…\tgit switch", "checkout_branch"),
  e("Branch: Check Out Remote as New Local…\tgit switch -c", "checkout_branch", { create_branch: true, local_refs: false, tag_refs: false, remote_refs: true }),
  e("Branch: Create from Here…\tat the current commit", "create_branch"),
  e("Branch: Create from Tag…", "create_branch_from_tag"),
  e("Branch: Rename…\tgit branch -m", "rename_branch"),
  e("Branch: Delete…\tgit branch -d", "delete_branch", { prompt: false }),
  e("Branch: Delete on Remote…\tgit push --delete", "delete_branch", { prompt: false, local_refs: false, remote_refs: true }),
  e("Branch: Clean Up…\tmerged, stale and upstream-gone branches", "cleanup_branches"),
  e("Branch: Merge into Current…\tgit merge", "merge_branch"),
  e("Branch: Rebase Current onto…\tgit rebase", "rebase_branch"),
  e("Rebase: Interactive…\treorder, squash, reword or drop unpushed commits", "interactive_rebase"),
  e("Branch: Set Upstream\tthe branch pull and push use", "set_upstream"),
  e("Branch: Unset Upstream", "unset_upstream"),
  e("Branch: Hide in Graph…", "hide_ref"),
  e("Branch: Show Hidden…", "show_ref"),
  e("Branch: Show Only…\thide every other branch", "hide_all_refs_except"),
  e("Branch: Show All Hidden", "show_all_refs"),
  // Tags & remotes
  e("Remote: Fetch…\tgit fetch", "fetch"),
  e("Remote: Pull…\tgit pull", "pull"),
  e("Remote: Push…\tgit push", "push", { prompt: true }),
  e("Remote: Add…\tgit remote add", "add_remote"),
  e("Remote: Remove…\tgit remote remove", "delete_remote", { prompt: false }),
  e("Remote: Rename…\tgit remote rename", "rename_remote"),
  e("Tag: Create…\tgit tag", "create_tag"),
  e("Tag: Delete…\tgit tag -d", "delete_tag", { prompt: false }),
  e("Tag: Delete on Remote…\tgit push --delete", "delete_tag_on_remote", { prompt: false }),
  e("Tag: Push…\tgit push <remote> <tag>", "push_tag"),
  // Stash
  e("Stash: Save Changes…\tgit stash push", "stash"),
  e("Stash: Pop Latest\tgit stash pop", "pop_stash"),
  e("Stash: Drop…\tgit stash drop", "drop_stash"),
  e("Stash: Clear All\tgit stash clear", "clear_stashes"),
  // Commits & history
  e("History: Blame File…\twho changed each line", "blame"),
  e("History: File History…\tcommits that touched a file", "file_history"),
  e("History: Expand Merge Commits (Toggle)\tin the commit graph", "toggle_preference", { setting: "expand_merge_commits_by_default" }),
  // Working directory
  e("Changes: Stage All, Including Untracked\tgit add -A", "stage_all"),
  e("Changes: Stage Modified Files\tgit add -u", "stage_all_modified"),
  e("Changes: Unstage All\tgit reset", "unstage_all"),
  e("Changes: Commit Staged\tgit commit", "commit"),
  // Search & navigate
  e("Go: Search Commits…", "toggle_search"),
  e("Go: HEAD Commit", "navigate_to_head"),
  e("Go: Commit Message\tthe message box", "navigate_to_commit_message"),
  // View & layout
  e("View: Toggle Side Bar", "toggle_side_bar"),
  e("View: Ignore Whitespace in Diffs (Toggle)", "toggle_ignore_diff_whitespace"),
  e("View: Select Theme…\tbuilt-in and your theme files", "select_theme"),
  // Preferences
  e("Preferences: Open…", "open_preferences"),
  e("Preferences: Edit settings.json…\tevery preference as a file", "edit_settings"),
  e("Preferences: Import from Sublime Merge…\tkey bindings, commands and menus", "import_from_sublime_merge"),
];

/** The user's `commands.json`: entries with a caption and command; anything else is skipped. Throws on bad JSON. */
export function parseCommands(text: string): PaletteEntry[] {
  if (!text.trim()) return [];
  const v = parseJsonc(text);
  if (!Array.isArray(v)) throw new Error("the file must contain a JSON array");
  return v.filter((x): x is PaletteEntry => !!x && typeof x === "object" && typeof x.caption === "string" && x.caption !== "" && typeof x.command === "string"
    && (x.args === undefined || (!!x.args && typeof x.args === "object" && !Array.isArray(x.args))));
}

/** `show_command_palette {command}` stands for that command (it opens its prompt). */
const target = (p: PaletteEntry): string =>
  p.command === "show_command_palette" && typeof p.args?.command === "string" ? p.args.command : p.command;

/**
 * What the palette lists: `defaults` + `user` entries whose command `has` (registered and not refused), then each
 * registered caption whose command no entry uses and whose caption is not taken. Exact duplicates are dropped.
 * `keysFor`: a binding's pretty keys, shown with the caption's own detail. Sorted by label.
 */
export function paletteItems(
  defaults: PaletteEntry[], user: PaletteEntry[], registered: { name: string; caption?: string }[],
  has: (command: string) => boolean, keysFor: (command: string, args: Record<string, unknown>) => string | undefined,
): PaletteItem[] {
  const listed = [...defaults, ...user];
  const used = new Set(listed.map(target));
  const entries = [...listed, ...registered.filter((r) => r.caption && !used.has(r.name)).map((r) => e(r.caption!, r.name))];
  const seen = new Set<string>(), labels = new Set<string>(), out: PaletteItem[] = [];
  for (const p of entries) {
    if (!has(target(p))) continue;
    const [label, tabDetail] = p.caption.split("\t");
    const args = p.args ?? {};
    const key = `${label}\u0000${p.command}\u0000${JSON.stringify(args)}`;
    // ours come last: skip one whose caption an entry above already shows
    if (seen.has(key) || (!listed.includes(p) && labels.has(label))) continue;
    seen.add(key);
    labels.add(label);
    const detail = [tabDetail, keysFor(p.command, args)].filter(Boolean).join("   ") || undefined;
    out.push({ label, detail, command: p.command, args });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

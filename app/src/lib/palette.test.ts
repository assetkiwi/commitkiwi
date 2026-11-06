import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PALETTE, paletteItems, parseCommands, type PaletteEntry } from "./palette.ts";

const has = (names: string[]) => (c: string) => names.includes(c);
const none = () => undefined;

test("our entries with categories and args; missing commands are left out", () => {
  const items = paletteItems(DEFAULT_PALETTE, [], [], has(["toggle_preference", "pop_stash", "checkout_branch", "delete_branch"]), none);
  const by = Object.fromEntries(items.map((i) => [i.label, i]));
  assert.deepEqual(by["History: Expand Merge Commits (Toggle)"].args, { setting: "expand_merge_commits_by_default" });
  assert.deepEqual(by["Stash: Pop Latest"], { label: "Stash: Pop Latest", detail: "git stash pop", command: "pop_stash", args: {} });
  assert.deepEqual(by["Branch: Check Out Remote as New Local…"].args, { create_branch: true, local_refs: false, tag_refs: false, remote_refs: true });
  assert.deepEqual(by["Branch: Delete on Remote…"].args, { prompt: false, local_refs: false, remote_refs: true });
  assert.deepEqual(items.map((i) => i.label), [...items.map((i) => i.label)].sort((a, b) => a.localeCompare(b)));
  // every entry has a category and no placeholder without a backend
  for (const p of DEFAULT_PALETTE) assert.match(p.caption, /^(Repository|Branch|Rebase|Remote|Tag|Stash|History|Changes|Go|View|Preferences): /, p.caption);
  assert.ok(!DEFAULT_PALETTE.some((p) => /^(gitflow_|lfs_|init_gitflow|edit_gitflow)|^(apply_patch|view_tree|navigate_to_(commit|branch|tag|stash)|clean_working_dir|open_dir_in_sublime_text|lock_worktree|unlock_worktree|remove_worktree)$/.test(p.command)));
});

test("our captions fill in, but never duplicate a command or caption the list has", () => {
  const reg = [{ name: "stash", caption: "Stash" }, { name: "delete_remote_branch", caption: "Branch: Delete on Remote…" }, { name: "refresh", caption: "Refresh" }, { name: "hide_overlay" }];
  const labels = paletteItems(DEFAULT_PALETTE, [], reg, () => true, none).map((i) => i.label);
  assert.ok(labels.includes("Stash: Save Changes…") && !labels.includes("Stash"));
  assert.equal(labels.filter((l) => l === "Branch: Delete on Remote…").length, 1);
  assert.ok(labels.includes("Refresh"));
});

test("user entries: listed with args, palette-wrapped commands checked by their target, keys shown", () => {
  const user = parseCommands(`[
    // comment
    { "caption": "Cleanup\\tgit gc", "command": "git", "args": { "argv": ["gc"] } },
    { "caption": "Rebase…", "command": "show_command_palette", "args": { "command": "git", "args": { "argv": ["rebase", "$select_branch"] } } },
    { "caption": "Broken", "command": 3 }, { "command": "git" }, { "caption": "Bad args", "command": "git", "args": [1] },
  ]`);
  assert.equal(user.length, 2);
  const items = paletteItems([], user, [], has(["git", "show_command_palette"]), (c, a) => (c === "git" && (a.argv as string[])[0] === "gc" ? "⌘G" : undefined));
  assert.deepEqual(items[0], { label: "Cleanup", detail: "git gc   ⌘G", command: "git", args: { argv: ["gc"] } });
  assert.equal(items[1].command, "show_command_palette");
  assert.equal(paletteItems([], user, [], has(["show_command_palette"]), none).length, 0, "no repository open: no git command");
  assert.throws(() => parseCommands("{}"), /array/);
  assert.deepEqual(parseCommands("  "), []);
});

test("exact duplicates collapse", () => {
  const dup: PaletteEntry[] = [{ caption: "X", command: "a" }, { caption: "X", command: "a" }, { caption: "X", command: "a", args: { y: 1 } }];
  assert.equal(paletteItems(dup, [], [], () => true, none).length, 2);
});

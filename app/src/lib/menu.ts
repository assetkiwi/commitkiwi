// The main menu bar: our own grouping (most used first), built on compatible command names so user menu files
// and key bindings keep working. Items whose command is not available right now show disabled. Pure.
import { fillArgv } from "./customGit.ts";

export interface MenuDef {
  caption: string; command?: string; args?: Record<string, unknown>; children?: MenuDef[]; id?: string;
  /** earlier ids of this submenu: a user's menu file naming one still adds to it */
  aliases?: string[];
  /** context menus: shown only when every space-separated flag in the menu's vars is truthy, `!flag` falsy. */
  visible?: string;
}
/** `command` "native:<x>": an OS item (clipboard, window), handled by the desktop shell and absent from the in-window bar. */
export interface MenuNode { caption: string; id?: string; enabled?: boolean; keys?: string[]; accel?: string; children?: MenuNode[] }
export interface MenuAction { command: string; args: Record<string, unknown>; keys?: string[] }

const SEP: MenuDef = { caption: "-" };
const palette = (command: string, args?: Record<string, unknown>): Pick<MenuDef, "command" | "args"> =>
  ({ command: "show_command_palette", args: args ? { command, args } : { command } });
const layout = (caption: string, value: string): MenuDef => ({ caption, command: "set_preference", args: { setting: "side_bar_layout", value } });

export const MAIN_MENU: MenuDef[] = [
  { caption: "File", id: "file", children: [
    { caption: "New Tab", command: "new_tab" },
    { caption: "Open Repository…", command: "prompt_open_repository" },
    { caption: "Switch Repository…", command: "quick_switch_repository" },
    { caption: "Repository Dashboard", command: "show_dashboard" },
    { caption: "Reopen Closed Tab", command: "restore_tab" },
    SEP,
    { caption: "Clone Repository…", command: "display_clone_page" },
    { caption: "New Repository…", command: "prompt_new_repository" },
    { caption: "Add Repositories from Folder…", command: "add_repositories_from_folder" },
    SEP,
    { caption: "Show Repository Folder", command: "open_dir" },
    { caption: "Open Repository in Editor", command: "open_dir_in_editor" },
    { caption: "Open Repository in Terminal", command: "open_terminal" },
    { caption: "Edit .gitignore…", command: "open_in_editor", args: { file: "$git_dir/.gitignore" } },
    { caption: "Edit .gitattributes…", command: "open_in_editor", args: { file: "$git_dir/.gitattributes" } },
    SEP,
    { caption: "Install Command Line Tool…", command: "install_command_line_tool" },
    { caption: "Import from Sublime Merge…", command: "import_from_sublime_merge" },
    SEP,
    { caption: "Close Tab", command: "close" },
    { caption: "Close Window", command: "native:close_window" },
  ] },
  { caption: "Edit", id: "edit", children: [
    { caption: "Undo", command: "native:undo" }, { caption: "Redo", command: "native:redo" }, SEP,
    { caption: "Cut", command: "native:cut" }, { caption: "Copy", command: "native:copy" }, { caption: "Paste", command: "native:paste" }, SEP,
    { caption: "Select All", command: "native:select_all" },
  ] },
  { caption: "Changes", id: "changes", children: [
    { caption: "Commit Staged Changes", command: "commit" },
    { caption: "Stage All Changes", command: "stage_all" },
    { caption: "Stage Modified Files", command: "stage_all_modified" },
    { caption: "Unstage All", command: "unstage_all" },
    SEP,
    { caption: "Stash Changes", command: "stash" },
    { caption: "Stash with Message…", command: "stash", args: { prompt: true } },
    { caption: "Pop Latest Stash", command: "pop_stash" },
    SEP,
    { caption: "Undo", command: "git_undo" },
    { caption: "Redo", command: "git_redo" },
  ] },
  { caption: "Branch", id: "branch", aliases: ["repository"], children: [
    { caption: "Check Out Branch…", ...palette("checkout_branch") },
    { caption: "Check Out Remote Branch…", ...palette("checkout_branch", { local_refs: false, tag_refs: false, remote_refs: true }) },
    { caption: "New Branch…", ...palette("create_branch") },
    { caption: "New Branch from Remote…", ...palette("create_branch_from_remote_branch") },
    SEP,
    { caption: "Merge into Current Branch…", ...palette("merge_branch") },
    { caption: "Rebase Current Branch…", ...palette("rebase_branch") },
    { caption: "Rebase Interactively…", command: "interactive_rebase" },
    SEP,
    { caption: "Rename Branch…", ...palette("rename_branch") },
    { caption: "Delete Branch…", ...palette("delete_branch") },
    { caption: "Clean Up Branches…", command: "cleanup_branches" },
  ] },
  { caption: "Remote", id: "remote", children: [
    { caption: "Fetch", command: "fetch" },
    { caption: "Pull…", command: "pull", args: { prompt: true } },
    { caption: "Push…", ...palette("push", { prompt: true }) },
    SEP,
    // through gh / glab, else the browser
    { caption: "Create Pull/Merge Request…", command: "create_pull_request" },
    SEP,
    { caption: "Add Remote…", ...palette("add_remote") },
  ] },
  { caption: "Go", id: "go", aliases: ["navigate"], children: [
    { caption: "Back", command: "navigate_back" },
    { caption: "Forward", command: "navigate_forward" },
    { caption: "HEAD Commit", command: "navigate_to_head" },
    { caption: "Commit Message", command: "navigate_to_commit_message" },
    SEP,
    { caption: "Search Commits", command: "toggle_search" },
    { caption: "Natural Language Search", command: "toggle_natural_search" },
    { caption: "Blame File…", ...palette("blame") },
    { caption: "File History…", ...palette("file_history") },
    SEP,
    { caption: "Next Tab", command: "next_tab" },
    { caption: "Previous Tab", command: "prev_tab" },
    { caption: "Move Tab Left", command: "move_tab_left" },
    { caption: "Move Tab Right", command: "move_tab_right" },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ caption: `Tab ${n}`, command: "select_tab", args: { index: n - 1 } })),
  ] },
  { caption: "View", id: "view", aliases: ["tools"], children: [
    { caption: "Command Palette…", command: "show_command_palette" },
    { caption: "Refresh", command: "refresh" },
    SEP,
    { caption: "Toggle Side Bar", command: "toggle_side_bar" },
    { caption: "Show Console", command: "toggle_console" },
    { caption: "Layout", id: "layout", children: [
      layout("One Column", "tabs"),
      layout("Two Columns, Files on Left", "commit_graph_as_column"),
      layout("Two Columns, Files on Right", "locations_as_column"),
      layout("Three Columns", "columns"),
    ] },
    SEP,
    { caption: "Toggle Light/Dark Theme", command: "toggle_theme" },
    { caption: "Enter Full Screen", command: "native:fullscreen" },
  ] },
  // macOS: shown inside the application menu
  { caption: "Preferences", id: "preferences", children: [
    { caption: "Preferences…", command: "open_preferences" },
    { caption: "Key Bindings…", command: "show_keybindings" },
    { caption: "Select Theme…", command: "select_theme" },
    SEP,
    { caption: "Edit settings.json…", command: "edit_settings" },
    { caption: "Edit keymap.json…", command: "edit_key_bindings" },
    { caption: "Open Configuration Folder…", command: "browse_packages" },
    { caption: "Import from Sublime Merge…", command: "import_from_sublime_merge" },
  ] },
  { caption: "Window", id: "window", children: [
    { caption: "Minimize", command: "native:minimize" }, { caption: "Zoom", command: "native:maximize" },
  ] },
  { caption: "Help", id: "help", children: [
    { caption: "About commit.kiwi & Licenses…", command: "show_about" },
  ] },
];

const tidy = (list: MenuDef[]): MenuDef[] =>
  list.filter((c, i, a) => c.caption !== "-" || (i > 0 && i < a.length - 1 && a[i + 1].caption !== "-"));
const fill = (text: string, vars: Record<string, unknown>): string =>
  text.replace(/\$(\w+)/g, (m, k: string) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));

/**
 * A context menu for one target: `$name` in captions and string args filled from `vars` (an arg that is exactly
 * `$name` takes the value as is, so ids/lists/numbers survive), hidden items dropped, separators tidied. A `git`
 * command's `argv` is filled by `fillArgv`'s rules; when that refuses (a file called `--x`), the args become
 * `{ refused }` and the command reports it instead of running.
 */
export function fillMenu(defs: MenuDef[], vars: Record<string, unknown>): MenuDef[] {
  const shown = (d: MenuDef) => !d.visible || d.visible.split(" ").every((f) => (f.startsWith("!") ? !vars[f.slice(1)] : !!vars[f]));
  const arg = (v: unknown): unknown => typeof v !== "string" ? v : /^\$\w+$/.test(v) ? vars[v.slice(1)] : fill(v, vars);
  const args = (a: Record<string, unknown>): Record<string, unknown> => {
    if (Array.isArray(a.argv)) {
      try { return { ...a, argv: fillArgv(a.argv, vars) }; } catch (e) { return { refused: e instanceof Error ? e.message : String(e) }; }
    }
    return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? args(v as Record<string, unknown>) : arg(v)]));
  };
  return tidy(defs.filter(shown).map((d) => ({
    ...d,
    caption: fill(d.caption, vars),
    args: d.args && args(d.args),
    children: d.children && fillMenu(d.children, vars),
  })));
}

const isDef = (v: unknown): v is MenuDef => !!v && typeof v === "object" && !Array.isArray(v)
  && (typeof (v as MenuDef).caption === "string" || typeof (v as MenuDef).id === "string");
/** something `resolveMenu` can show: a separator, a submenu or a command */
const complete = (d: MenuDef) => typeof d.caption === "string" && (d.caption === "-" || Array.isArray(d.children) || typeof d.command === "string")
  && (d.args === undefined || (!!d.args && typeof d.args === "object" && !Array.isArray(d.args)));

/**
 * A user's menu file merged into ours: an item whose `id` matches one of ours (or one of its `aliases`) adds its
 * `children` to that submenu (recursively, by id again) and replaces the fields it gives; any other item is appended.
 * Items that are not menu items are skipped. Returns a new list; `base` is untouched.
 */
export function mergeMenu(base: MenuDef[], user: unknown[]): MenuDef[] {
  const out = base.map((d) => ({ ...d }));
  for (const u of user) {
    if (!isDef(u)) continue;
    const at = u.id === undefined ? -1 : out.findIndex((d) => d.id === u.id || !!d.aliases?.includes(u.id!));
    const kids = Array.isArray(u.children) ? u.children : undefined;
    if (at < 0) {
      if (complete(u)) out.push(kids ? { ...u, children: mergeMenu([], kids) } : { ...u });
      continue;
    }
    const d = out[at];
    const merged = { ...d, ...u, id: d.id, children: kids ? mergeMenu(d.children ?? [], kids) : d.children };
    if (complete(merged)) out[at] = merged;
  }
  return out;
}

/** `show_command_palette {command}` opens that command's prompt, so it is available exactly when that command is. */
const target = (d: MenuDef): string =>
  d.command === "show_command_palette" && typeof d.args?.command === "string" ? d.args.command : d.command!;

/**
 * Resolve the definitions against the registry (`has`) and keymap (`keysFor`). Leaf ids index `actions`.
 * `native: false` drops OS items (the in-window bar) and menus left empty by that. `captionFor`: a command's own
 * caption for now (Undo: commit).
 */
export function resolveMenu(
  defs: MenuDef[], has: (command: string) => boolean, keysFor: (command: string, args: Record<string, unknown>) => string[] | undefined,
  native: boolean, captionFor: (command: string) => string | undefined = () => undefined,
): { nodes: MenuNode[]; actions: MenuAction[] } {
  const actions: MenuAction[] = [];
  const walk = (list: MenuDef[]): MenuNode[] => list.flatMap((d): MenuNode[] => {
    if (d.children) {
      const children = walk(d.children);
      // no leading/trailing/double separators once native items are gone
      const tidy = children.filter((c, i) => c.caption !== "-" || (i > 0 && i < children.length - 1 && children[i + 1].caption !== "-"));
      return tidy.some((c) => c.caption !== "-") ? [{ caption: d.caption, children: tidy }] : [];
    }
    if (d.caption === "-") return [{ caption: "-" }];
    if (d.command!.startsWith("native:")) return native ? [{ caption: d.caption, id: d.command, enabled: true }] : [];
    const args = d.args ?? {};
    const keys = keysFor(d.command!, args);
    actions.push({ command: d.command!, args, keys });
    return [{ caption: captionFor(target(d)) ?? d.caption, id: String(actions.length - 1), enabled: has(target(d)), keys }];
  });
  return { nodes: walk(defs), actions };
}

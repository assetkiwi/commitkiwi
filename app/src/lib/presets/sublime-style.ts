// The "sublime-style" compatibility preset (Preferences > Key Bindings): reproduces the key chords of Sublime Merge,
// for compatibility, on the commands commit.kiwi has. Data only; the app's own defaults are in ../defaultKeymap.ts.
import type { Binding, Platform } from "../keymap.ts";

const closeOverlay: Binding = { keys: ["escape"], command: "hide_overlay", context: [{ key: "overlay_visible" }] };
// ⌘Z/⌘⇧Z: git undo/redo only outside text fields (there they edit the text)
const noText = [{ key: "text_focus", operator: "not_equal" }];
const table = [{ key: "control", operand: "commit_table" }, { key: "search_mode", operator: "not_equal" }];
/** keys that are the same on every platform */
// Escape: later bindings win (filters, search, console, overlay last via closeOverlay, autocomplete)
const COMMON: Binding[] = [
  { keys: ["left"], command: "collapse_merge", context: table },
  { keys: ["right"], command: "expand_merge", context: table },
  { keys: ["escape"], command: "toggle_files_filter", context: [{ key: "control", operand: "text_control filter_input files_filter" }] },
  { keys: ["escape"], command: "toggle_ref_filter", context: [{ key: "control", operand: "text_control filter_input locations_filter" }] },
  { keys: ["escape"], command: "exit_search", context: [{ key: "search_mode" }] },
  { keys: ["escape"], command: "toggle_console", context: [{ key: "console_visible" }] },
  { keys: ["escape"], command: "hide_auto_complete", context: [{ key: "auto_complete_visible" }] },
  { keys: ["escape"], command: "close_preferences", context: [{ key: "preferences" }] },
  { keys: ["escape"], command: "askpass_cancel", context: [{ key: "askpass_visible" }] },
];

/** Cmd/Ctrl+1..8: repository tab 1..8 (no tab 9: ⌘9 is navigate_to_commit_message). Before mergeKeys, whose
 *  merge_mode ⌘1-3 then win in the merge tool. */
const tabKeys = (mod: string): Binding[] =>
  [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ keys: [`${mod}+${n}`], command: "select_tab", args: { index: n - 1 } }));

/** the merge tool's keys (merge_mode bindings), `mod` = super on macOS, ctrl elsewhere; after the others so they win */
const mergeKeys = (mod: string): Binding[] => {
  const merge = [{ key: "merge_mode" }];
  return [
    { keys: [`${mod}+s`], command: "save", context: merge },
    { keys: [`${mod}+shift+s`], command: "save", context: merge },
    { keys: [`${mod}+n`], command: "next_conflict", context: merge },
    { keys: [`${mod}+shift+n`], command: "prev_conflict", context: merge },
    { keys: [`${mod}+0`], command: "toggle_merged_vs_base", context: merge },
    { keys: [`${mod}+1`], command: "focus_left", context: merge },
    { keys: [`${mod}+2`], command: "focus_middle", context: merge },
    { keys: [`${mod}+3`], command: "focus_right", context: merge },
    { keys: [`${mod}+shift+,`], command: "use_left_hunk", context: merge },
    { keys: [`${mod}+shift+.`], command: "use_right_hunk", context: merge },
  ];
};

const MAC: Binding[] = [
  { keys: ["super+t"], command: "new_tab" },
  { keys: ["super+shift+t"], command: "restore_tab" },
  { keys: ["super+w"], command: "close" },
  { keys: ["ctrl+tab"], command: "next_tab" },
  { keys: ["ctrl+shift+tab"], command: "prev_tab" },
  { keys: ["super+o"], command: "prompt_open_repository" },
  { keys: ["super+shift+o"], command: "quick_switch_repository" },
  { keys: ["super+ctrl+p"], command: "quick_switch_repository" },
  { keys: ["super+p"], command: "show_command_palette" },
  { keys: ["super+,"], command: "open_preferences" },
  { keys: ["super+shift+p"], command: "show_command_palette" },
  { keys: ["f5"], command: "refresh" },
  { keys: ["super+shift+h"], command: "refresh" },
  { keys: ["super+k", "super+b"], command: "toggle_side_bar" },
  { keys: ["super+0"], command: "navigate_to_head" },
  { keys: ["super+left"], command: "navigate_back" },
  { keys: ["super+right"], command: "navigate_forward" },
  { keys: ["super+b"], command: "show_command_palette", args: { command: "checkout_branch" } },
  { keys: ["super+shift+b"], command: "show_command_palette", args: { command: "create_branch" } },
  { keys: ["super+z"], command: "git_undo", context: noText },
  { keys: ["super+shift+z"], command: "git_redo", context: noText },
  { keys: ["super+s"], command: "stash" },
  { keys: ["super+shift+s"], command: "pop_stash" },
  { keys: ["super+alt+down"], command: "pull" },
  { keys: ["f7"], command: "pull" },
  { keys: ["super+alt+up"], command: "show_command_palette", args: { command: "push" } },
  { keys: ["f8"], command: "show_command_palette", args: { command: "push" } },
  { keys: ["shift+f8"], command: "show_command_palette", args: { command: "push", args: { prompt: true } } },
  { keys: ["super+f"], command: "toggle_search", context: [{ key: "merge_mode", operator: "not_equal" }] },
  { keys: ["ctrl+backquote"], command: "toggle_console" },
  { keys: ["super+g"], command: "find_next", context: [{ key: "search_mode" }] },
  { keys: ["super+shift+g"], command: "find_prev", context: [{ key: "search_mode" }] },
  { keys: ["super+shift+f"], command: "toggle_ref_filter" },
  { keys: ["super+alt+f"], command: "toggle_files_filter" },
  { keys: ["super+9"], command: "navigate_to_commit_message" },
  { keys: ["super+;"], command: "show_commit_message_history" },
  { keys: ["super+shift+a"], command: "stage_all_modified" },
  { keys: ["super+k", "super+a"], command: "stage_all" },
  { keys: ["super+shift+r"], command: "unstage_all" },
  ...tabKeys("super"),
  ...mergeKeys("super"),
  ...COMMON,
  closeOverlay,
];

const OTHER: Binding[] = [
  { keys: ["ctrl+t"], command: "new_tab" },
  { keys: ["ctrl+shift+t"], command: "restore_tab" },
  { keys: ["ctrl+w"], command: "close" },
  { keys: ["ctrl+f4"], command: "close" },
  { keys: ["ctrl+tab"], command: "next_tab" },
  { keys: ["ctrl+shift+tab"], command: "prev_tab" },
  { keys: ["ctrl+o"], command: "prompt_open_repository" },
  { keys: ["ctrl+shift+o"], command: "quick_switch_repository" },
  { keys: ["ctrl+p"], command: "show_command_palette" },
  { keys: ["ctrl+,"], command: "open_preferences" },
  { keys: ["ctrl+shift+p"], command: "show_command_palette" },
  { keys: ["f5"], command: "refresh" },
  { keys: ["ctrl+shift+h"], command: "refresh" },
  { keys: ["ctrl+k", "ctrl+b"], command: "toggle_side_bar" },
  { keys: ["ctrl+0"], command: "navigate_to_head" },
  { keys: ["alt+left"], command: "navigate_back" },
  { keys: ["alt+right"], command: "navigate_forward" },
  { keys: ["ctrl+b"], command: "show_command_palette", args: { command: "checkout_branch" } },
  { keys: ["ctrl+shift+b"], command: "show_command_palette", args: { command: "create_branch" } },
  { keys: ["ctrl+z"], command: "git_undo", context: noText },
  { keys: ["ctrl+shift+z"], command: "git_redo", context: noText },
  { keys: ["ctrl+s"], command: "stash" },
  { keys: ["ctrl+shift+s"], command: "pop_stash" },
  { keys: ["ctrl+alt+down"], command: "pull" },
  { keys: ["f7"], command: "pull" },
  { keys: ["ctrl+alt+up"], command: "show_command_palette", args: { command: "push" } },
  { keys: ["f8"], command: "show_command_palette", args: { command: "push" } },
  { keys: ["shift+f8"], command: "show_command_palette", args: { command: "push", args: { prompt: true } } },
  { keys: ["ctrl+f"], command: "toggle_search", context: [{ key: "merge_mode", operator: "not_equal" }] },
  { keys: ["ctrl+`"], command: "toggle_console" },
  { keys: ["f3"], command: "find_next", context: [{ key: "search_mode" }] },
  { keys: ["shift+f3"], command: "find_prev", context: [{ key: "search_mode" }] },
  { keys: ["ctrl+shift+f"], command: "toggle_ref_filter" },
  { keys: ["ctrl+alt+f"], command: "toggle_files_filter" },
  { keys: ["ctrl+9"], command: "navigate_to_commit_message" },
  { keys: ["ctrl+;"], command: "show_commit_message_history" },
  { keys: ["ctrl+shift+a"], command: "stage_all_modified" },
  { keys: ["ctrl+k", "ctrl+a"], command: "stage_all" },
  { keys: ["ctrl+shift+r"], command: "unstage_all" },
  ...tabKeys("ctrl"),
  ...mergeKeys("ctrl"),
  ...COMMON,
  closeOverlay,
];

export function sublimeStyleBindings(platform: Platform): Binding[] {
  if (platform === "mac") return MAC;
  // Linux alone also has ctrl+alt+p for the repository switcher
  return platform === "linux" ? [...OTHER, { keys: ["ctrl+alt+p"], command: "quick_switch_repository" }] : OTHER;
}

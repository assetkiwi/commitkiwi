// commit.kiwi's default key bindings, built on common desktop conventions (documented in docs/KEYMAP.md), and the
// presets a user can pick instead (pref `keymap_preset`). The user's keymap file always goes on top.
import type { Binding, Platform } from "./keymap.ts";
import { sublimeStyleBindings } from "./presets/sublime-style.ts";

export type KeymapPreset = "default" | "sublime-style";
export const KEYMAP_PRESETS: { value: KeymapPreset; label: string; detail: string }[] = [
  { value: "default", label: "commit.kiwi", detail: "desktop conventions (⌘/Ctrl+P switch repository, ⌘/Ctrl+B side bar, …)" },
  { value: "sublime-style", label: "Sublime-style (compatibility)", detail: "the key assignments Sublime Merge users know" },
];

// git undo/redo only outside text fields (inside, the field's own undo)
const noText = [{ key: "text_focus", operator: "not_equal" }];
const table = [{ key: "control", operand: "commit_table" }, { key: "search_mode", operator: "not_equal" }];
const merge = [{ key: "merge_mode" }];
const search = [{ key: "search_mode" }];

/** Escape closes the innermost thing first (later bindings win): filters, search, console, preferences, overlay. */
const ESCAPE: Binding[] = [
  { keys: ["left"], command: "collapse_merge", context: table },
  { keys: ["right"], command: "expand_merge", context: table },
  { keys: ["escape"], command: "toggle_files_filter", context: [{ key: "control", operand: "text_control filter_input files_filter" }] },
  { keys: ["escape"], command: "toggle_ref_filter", context: [{ key: "control", operand: "text_control filter_input locations_filter" }] },
  { keys: ["escape"], command: "exit_search", context: search },
  { keys: ["escape"], command: "toggle_console", context: [{ key: "console_visible" }] },
  { keys: ["escape"], command: "hide_auto_complete", context: [{ key: "auto_complete_visible" }] },
  { keys: ["escape"], command: "close_preferences", context: [{ key: "preferences" }] },
  { keys: ["escape"], command: "askpass_cancel", context: [{ key: "askpass_visible" }] },
  { keys: ["escape"], command: "hide_overlay", context: [{ key: "overlay_visible" }] },
];

/** `m`: the primary modifier (super on macOS, ctrl elsewhere). */
function bindings(m: string, mac: boolean): Binding[] {
  const palette = (command: string, args?: Record<string, unknown>) => ({ command: "show_command_palette", args: args ? { command, args } : { command } });
  return [
    // window and tabs
    { keys: [`${m}+t`], command: "new_tab" },
    { keys: [`${m}+shift+t`], command: "restore_tab" },
    { keys: [`${m}+w`], command: "close" },
    { keys: ["ctrl+tab"], command: "next_tab" },
    { keys: ["ctrl+shift+tab"], command: "prev_tab" },
    ...(mac
      ? [{ keys: ["super+shift+]"], command: "next_tab" }, { keys: ["super+shift+["], command: "prev_tab" }]
      : [{ keys: ["ctrl+pagedown"], command: "next_tab" }, { keys: ["ctrl+pageup"], command: "prev_tab" }]),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ keys: [`${m}+${n}`], command: "select_tab", args: { index: n - 1 } })),
    { keys: ["ctrl+shift+pageup"], command: "move_tab_left" },
    { keys: ["ctrl+shift+pagedown"], command: "move_tab_right" },
    { keys: [`${m}+o`], command: "prompt_open_repository" },
    { keys: [`${m}+shift+d`], command: "show_dashboard" },
    { keys: [`${m}+p`], command: "quick_switch_repository" },
    // the last binding of a command is the one menus show
    { keys: ["f1"], command: "show_command_palette" },
    { keys: [`${m}+shift+p`], command: "show_command_palette" },
    { keys: [`${m}+,`], command: "open_preferences" },
    // view
    { keys: [`${m}+b`], command: "toggle_side_bar" },
    { keys: [`${m}+j`], command: "toggle_console" },
    { keys: [`${m}+r`], command: "refresh" },
    { keys: ["f5"], command: "refresh" },
    // navigate
    ...(mac
      ? [{ keys: ["super+["], command: "navigate_back" }, { keys: ["super+]"], command: "navigate_forward" }]
      : [{ keys: ["alt+left"], command: "navigate_back" }, { keys: ["alt+right"], command: "navigate_forward" }]),
    { keys: [`${m}+shift+h`], command: "navigate_to_head" },
    { keys: [`${m}+shift+m`], command: "navigate_to_commit_message" },
    { keys: [`${m}+alt+m`], command: "show_commit_message_history" },
    // search and filters
    { keys: [`${m}+f`], command: "toggle_search", context: [{ key: "merge_mode", operator: "not_equal" }] },
    { keys: [`${m}+alt+n`], command: "toggle_natural_search", context: [{ key: "merge_mode", operator: "not_equal" }] },
    ...(mac
      ? [{ keys: ["super+g"], command: "find_next", context: search }, { keys: ["super+shift+g"], command: "find_prev", context: search }]
      : [{ keys: ["f3"], command: "find_next", context: search }, { keys: ["shift+f3"], command: "find_prev", context: search }]),
    { keys: [`${m}+shift+f`], command: "toggle_files_filter" },
    { keys: [`${m}+shift+l`], command: "toggle_ref_filter" },
    // working directory and history
    { keys: [`${m}+enter`], command: "commit" },
    { keys: [`${m}+shift+a`], command: "stage_all" },
    { keys: [`${m}+alt+a`], command: "stage_all_modified" },
    { keys: [`${m}+shift+u`], command: "unstage_all" },
    { keys: [`${m}+z`], command: "git_undo", context: noText },
    { keys: [`${m}+shift+z`], command: "git_redo", context: noText },
    ...(mac ? [] : [{ keys: ["ctrl+y"], command: "git_redo", context: noText }]),
    // branches, stashes, remotes
    { keys: [`${m}+shift+c`], ...palette("checkout_branch") },
    { keys: [`${m}+shift+n`], ...palette("create_branch") },
    { keys: [`${m}+alt+b`], command: "cleanup_branches" },
    { keys: [`${m}+alt+r`], command: "interactive_rebase" },
    { keys: [`${m}+alt+s`], command: "stash" },
    { keys: [`${m}+alt+shift+s`], command: "pop_stash" },
    { keys: [`${m}+alt+f`], command: "fetch" },
    { keys: [`${m}+alt+p`], command: "pull" },
    { keys: [`${m}+alt+shift+p`], ...palette("push") },
    // the merge tool (context-restricted, so they win there)
    { keys: [`${m}+s`], command: "save", context: merge },
    { keys: [`${m}+shift+s`], command: "save_without_staging", context: merge },
    { keys: ["f7"], command: "next_conflict", context: merge },
    { keys: ["shift+f7"], command: "prev_conflict", context: merge },
    { keys: [`${m}+0`], command: "toggle_merged_vs_base", context: merge },
    { keys: [`${m}+1`], command: "focus_left", context: merge },
    { keys: [`${m}+2`], command: "focus_middle", context: merge },
    { keys: [`${m}+3`], command: "focus_right", context: merge },
    { keys: [`${m}+alt+1`], command: "use_left_hunk", context: merge },
    { keys: [`${m}+alt+3`], command: "use_right_hunk", context: merge },
    ...ESCAPE,
  ];
}

const DEFAULT: Record<Platform, Binding[]> = { mac: bindings("super", true), linux: bindings("ctrl", false), win: bindings("ctrl", false) };

/** The preset's bindings (unknown names: the default). */
export function presetBindings(platform: Platform, preset: string = "default"): Binding[] {
  return preset === "sublime-style" ? sublimeStyleBindings(platform) : DEFAULT[platform];
}

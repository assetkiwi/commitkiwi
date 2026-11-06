# Key bindings

commit.kiwi ships two key binding presets. Pick one in **Preferences > Key Bindings > Preset** (or set
`"keymap_preset"` in `settings.json`); it applies at once. Your own `keymap.json` always goes on top of the preset.

| Preset | Value | What it is |
|---|---|---|
| commit.kiwi (default) | `default` | The table below, built on common macOS/Windows/Linux desktop conventions. |
| Sublime-style (compatibility) | `sublime-style` | The assignments Sublime Merge users already know, for the commands commit.kiwi has. |

Source: `app/src/lib/defaultKeymap.ts` (default) and `app/src/lib/presets/sublime-style.ts` (compatibility preset).

## Default preset

`⌘` is Cmd on macOS. On Linux and Windows read `Ctrl` for `⌘` (and the platform column where it differs).

| Action | macOS | Linux / Windows | Command |
|---|---|---|---|
| New tab | ⌘T | Ctrl+T | `new_tab` |
| Reopen closed tab | ⇧⌘T | Ctrl+Shift+T | `restore_tab` |
| Close tab | ⌘W | Ctrl+W | `close` |
| Next / previous tab | ⌃Tab / ⌃⇧Tab, ⇧⌘] / ⇧⌘[ | Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PageDown / Ctrl+PageUp | `next_tab` / `prev_tab` |
| Tab 1–9 (in tab bar order) | ⌘1 … ⌘9 | Ctrl+1 … Ctrl+9 | `select_tab {index}` |
| Move tab left / right | ⌃⇧PageUp / ⌃⇧PageDown | Ctrl+Shift+PageUp / Ctrl+Shift+PageDown | `move_tab_left` / `move_tab_right` |
| Open repository | ⌘O | Ctrl+O | `prompt_open_repository` |
| Switch repository | ⌘P | Ctrl+P | `quick_switch_repository` |
| Repository dashboard | ⇧⌘D | Ctrl+Shift+D | `show_dashboard` |
| Command palette | ⇧⌘P, F1 | Ctrl+Shift+P, F1 | `show_command_palette` |
| Preferences | ⌘, | Ctrl+, | `open_preferences` |
| Toggle side bar | ⌘B | Ctrl+B | `toggle_side_bar` |
| Toggle console | ⌘J | Ctrl+J | `toggle_console` |
| Refresh | F5, ⌘R | F5, Ctrl+R | `refresh` |
| Back / forward | ⌘[ / ⌘] | Alt+← / Alt+→ | `navigate_back` / `navigate_forward` |
| Go to HEAD | ⇧⌘H | Ctrl+Shift+H | `navigate_to_head` |
| Go to commit message | ⇧⌘M | Ctrl+Shift+M | `navigate_to_commit_message` |
| Commit message history | ⌥⌘M | Ctrl+Alt+M | `show_commit_message_history` |
| Search commits | ⌘F | Ctrl+F | `toggle_search` |
| Natural-language search (open / toggle ✨) | ⌥⌘N | Ctrl+Alt+N | `toggle_natural_search` |
| Next / previous result | ⌘G / ⇧⌘G | F3 / Shift+F3 | `find_next` / `find_prev` |
| Filter files | ⇧⌘F | Ctrl+Shift+F | `toggle_files_filter` |
| Filter locations | ⇧⌘L | Ctrl+Shift+L | `toggle_ref_filter` |
| Commit | ⌘↵ | Ctrl+Enter | `commit` |
| Stage all (incl. untracked) | ⇧⌘A | Ctrl+Shift+A | `stage_all` |
| Stage modified files | ⌥⌘A | Ctrl+Alt+A | `stage_all_modified` |
| Unstage all | ⇧⌘U | Ctrl+Shift+U | `unstage_all` |
| Undo / redo (git, outside text fields) | ⌘Z / ⇧⌘Z | Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y | `git_undo` / `git_redo` |
| Check out a branch | ⇧⌘C | Ctrl+Shift+C | `show_command_palette {command: checkout_branch}` |
| New branch | ⇧⌘N | Ctrl+Shift+N | `show_command_palette {command: create_branch}` |
| Clean up branches | ⌥⌘B | Ctrl+Alt+B | `cleanup_branches` |
| Interactive rebase (unpushed commits) | ⌥⌘R | Ctrl+Alt+R | `interactive_rebase` |
| Stash / pop stash | ⌥⌘S / ⌥⇧⌘S | Ctrl+Alt+S / Ctrl+Alt+Shift+S | `stash` / `pop_stash` |
| Fetch | ⌥⌘F | Ctrl+Alt+F | `fetch` |
| Pull | ⌥⌘P | Ctrl+Alt+P | `pull` |
| Push… | ⌥⇧⌘P | Ctrl+Alt+Shift+P | `show_command_palette {command: push}` |
| Close the innermost panel | Esc | Esc | filters, search, console, preferences, overlay |
| Collapse / expand a merge (commit list) | ← / → | ← / → | `collapse_merge` / `expand_merge` |

The sublime-style preset has no keys for moving tabs, the dashboard or the interactive rebase (use the palette or the
menus) and selects tabs 1–8 only (⌘9 is the commit message there). Dragging a tab in the tab bar also reorders it.

Merge tool only (`merge_mode` context, so these win there):

| Action | macOS | Linux / Windows | Command |
|---|---|---|---|
| Save and stage / save | ⌘S / ⇧⌘S | Ctrl+S / Ctrl+Shift+S | `save` / `save_without_staging` |
| Next / previous conflict | F7 / ⇧F7 | F7 / Shift+F7 | `next_conflict` / `prev_conflict` |
| Focus left / merged / right | ⌘1 / ⌘2 / ⌘3 | Ctrl+1 / 2 / 3 | `focus_left` / `focus_middle` / `focus_right` |
| Take left / right hunk | ⌥⌘1 / ⌥⌘3 | Ctrl+Alt+1 / 3 | `use_left_hunk` / `use_right_hunk` |
| Merged vs. base | ⌘0 | Ctrl+0 | `toggle_merged_vs_base` |

Interactive rebase editor (a focused row):

| Action | Keys |
|---|---|
| Move the row up / down | ⌥↑ / ⌥↓ (Alt+↑ / Alt+↓) |
| Focus the previous / next row | ↑ / ↓ |
| Pick / reword / squash / fixup / drop | P / R / S / F / D |
| Cancel a drag, then close the editor | Esc |

## Your own bindings

`keymap.json` in the configuration folder (Preferences > Open Configuration Folder…), a JSON array with comments;
see `docs/CONFIGURATION.md`. The key bindings editor in Preferences writes to it. Later entries win; bind keys to
`noop` to remove a preset binding.

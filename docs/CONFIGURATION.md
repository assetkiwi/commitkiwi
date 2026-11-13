# Configuration files

Everything commit.kiwi can be told is in plain files in its configuration folder:

- macOS: `~/Library/Application Support/kiwi.commit.desktop/`
- Linux: `$XDG_CONFIG_HOME/kiwi.commit.desktop/` (default `~/.config/kiwi.commit.desktop/`)

**Preferences > Open Configuration Folder…** (palette: *Preferences: Open Configuration Folder…*) opens it and first
creates the example files that are missing. Every file is JSON with comments (`//`, `/* */`) and trailing commas.
Edits apply when the commit.kiwi window gets focus again. A broken file is reported in a banner and ignored; the rest
keeps working. Example files are only created when missing, never overwritten.

| File | What it holds | Example created by |
|---|---|---|
| `settings.json` | Any preference (same names as `preferences.json`); wins over the Preferences window | Preferences > Edit settings.json…, the folder command |
| `keymap.json` | Your key bindings, on top of the preset | the key bindings editor, Preferences > Edit keymap.json… |
| `commands.json` | Extra command palette entries | the folder command |
| `<Menu>.menu.json` | Items added to a menu (`Main.menu.json`, `Branch.menu.json`, …) | the folder command (`Main.menu.json`) |
| `themes/*.theme.json` | Your themes | `themes/example.theme.json`, when the `themes` folder is missing |
| `preferences.json` | What the Preferences window saves (also tabs, recent repositories) | the app; not meant for hand edits |

## Precedence

1. `settings.json` (a key set there shows *set in settings.json* in Preferences and cannot be changed there; remove
   it from the file to edit it in the window again; `preferences.json` keeps the window's own value meanwhile).
2. `preferences.json` (the Preferences window).
3. Built-in defaults.

Key bindings: the preset (`keymap_preset`, see `docs/KEYMAP.md`), then `keymap.json` on top (later entries win).
Palette: the built-in list, then `commands.json`. Menus: the built-in menus, then each `<Menu>.menu.json` merged in.

### Older file names

Files from older builds are still read while the new file does not exist: `Default.sublime-keymap` (for
`keymap.json`), `Default.sublime-commands` (for `commands.json`) and `<Menu>.sublime-menu` (for `<Menu>.menu.json`).
When commit.kiwi creates the new file (the key bindings editor, an Edit… command, the folder command), it starts as a
copy of the older one, so nothing you set is lost; the older file is left on disk and no longer read.

### Import from Sublime Merge

**File > Import from Sublime Merge…** (also in Preferences and the palette) reads Sublime Merge's user folder
(`~/Library/Application Support/Sublime Merge/Packages/User` on macOS, `~/.config/sublime-merge/Packages/User` on
Linux, or a folder you pick) and copies your own files into the new names: the platform keymap
(`Default (OSX).sublime-keymap`, else `Default.sublime-keymap`) to `keymap.json`, `Default.sublime-commands` to
`commands.json`, `<Menu>.sublime-menu` to `<Menu>.menu.json`. Only those file names directly in that folder are read
(no symlinks, nothing else). It lists what it would do first; files that exist here are only replaced when you choose
*Import and replace mine*. The schema is the same, so the text is copied as is (with a comment naming its source).

## settings.json

Every preference, with its default (the example file lists them all, commented out):

```jsonc
{
	// "system" (Light/Dark by the OS), "light", "dark", "kiwi-light", "kiwi-dark" or a theme file's name
	"theme": "system",
	// "tabs", "commit_graph_as_column", "locations_as_column", "columns"
	"side_bar_layout": "locations_as_column",
	"diff_style": "split",              // or "unified"
	"diff_context_lines": 3,
	"ignore_diff_white_space": false,
	"word_diff": false,              // true: shade the changed words inside a changed line
	"diff_syntax_colors": true,
	"word_wrap": false,                 // wrap long lines in unified diffs
	"editor_command": "open -t {path}", // {path} is filled in, no shell (Linux: "xdg-open {path}")
	"editor_command_remote": "code --remote ssh-remote+{host} {path}",
	"ui_font_size": 13,
	"font_size": 12,                    // diff and file text
	"expand_merge_commits_by_default": true,
	"terminal_command": "open -a Terminal {path}",
	"confirm_destructive": true,
	"update_check": true,               // check for a new version at startup
	"agent_cleanup_days": 30,           // 0: never remove old remote agents
	"commit_model": "",
	"commit_suggest": true,
	"natural_search": false,            // the search bar takes a sentence for the local model (the ✨ toggle)
	"forge_hosts": {},                  // e.g. { "git.example.com": "gitlab" }
	"gh_path": "",
	"glab_path": "",
	"open_request_after_create": true,
	"keymap_preset": "default",         // or "sublime-style"
	"cleanup_stale_days": 90,           // Clean Up Branches: stale after this many days without a commit (0: off)
	// Clean Up Branches never offers these; * matches anything (also /), names are matched without the remote
	"cleanup_protected_branches": ["main", "master", "develop", "trunk", "release/*"],
}
```

An unknown name or a value of the wrong type is reported and ignored.

## keymap.json

```jsonc
[
	{ "keys": ["super+shift+x"], "command": "toggle_theme" },
	// a two-step chord
	{ "keys": ["super+k", "super+t"], "command": "select_theme" },
	// run git in the open repository (no shell)
	{ "keys": ["super+alt+g"], "command": "git", "args": { "argv": ["gc"] } },
	// only in the commit list
	{ "keys": ["space"], "command": "expand_merge", "context": [{ "key": "control", "operand": "commit_table" }] },
	// remove a preset binding
	{ "keys": ["f5"], "command": "noop" },
]
```

Keys: `super` (Cmd), `ctrl`, `alt`, `shift`, `primary` (Cmd on macOS, Ctrl elsewhere) plus a key name (`a`, `f5`,
`enter`, `escape`, `left`, `pageup`, `,`, …). `context` conditions: `key` (a mode such as `text_focus`,
`merge_mode`, `search_mode`, `overlay_visible`, `console_visible`, `preferences`, or `control` with the focused
widget, e.g. `commit_table`, `text_control filter_input files_filter`), `operator` (`equal`, `not_equal`,
`regex_match`, `not_regex_match`, `regex_contains`, `not_regex_contains`), `operand`.

## commands.json

```jsonc
[
	// text after a tab is shown on the right
	{ "caption": "Repository: Clean Up\tgit gc", "command": "git", "args": { "argv": ["gc", "--prune=now"] } },
	// $select_* asks for a value first
	{ "caption": "Branch: Interactive Rebase…", "command": "git", "args": { "argv": ["rebase", "-i", "$select_branch"] } },
	// any registered command, with args
	{ "caption": "View: Unified Diffs", "command": "set_preference", "args": { "setting": "diff_style", "value": "unified" } },
]
```

`git` runs git (never a shell) in the open repository. Filled in: `$working_dir`, `$git_dir`, `$commit`,
`$short_commit`, `$head`, `$head_ref`; asked for first: `$select_branch`, `$select_local_branch`,
`$select_remote_branch`, `$select_ref`, `$select_tag`, `$select_commit`, `$select_stash`, `$text`.

## Menu files

`Main.menu.json` (the menu bar), `Action` (toolbar `…`), `Branch`, `Branch Folder`, `Branch Section`, `Commit`,
`Commit File`, `File`, `Hunk`, `Image Context`, `Index File` (staged), `Modified File`, `Untracked File`,
`Unmerged File`, `Remote`, `Remote Section`, `Remote Branch`, `Remote Branch Folder`, `Stash`, `Stash Section`,
`Submodule`, `Submodule Section`, `Tag`, `Tag Section`, `Tab Context` — each `<name>.menu.json`.

An item with the `id` of an existing submenu adds its `children` there (and replaces fields it gives); any other item
is appended. The target's `$variables` work in captions and args (`$branch`, `$ref`, `$commit`, `$short_commit`,
`$path`, `$tag_name`, `$remote`, …).

```jsonc
// Main.menu.json: add to the View menu, and a menu of your own
[
	{ "id": "view", "children": [{ "caption": "Garbage Collect", "command": "git", "args": { "argv": ["gc"] } }] },
	{ "caption": "Tools", "children": [{ "caption": "Log -1", "command": "git", "args": { "argv": ["log", "-1"] } }] },
]
```

```jsonc
// Branch.menu.json
[{ "caption": "Force Delete $branch", "command": "git", "args": { "argv": ["branch", "-D", "$branch"] } }]
```

Menu bar ids: `file`, `edit`, `changes`, `branch`, `remote`, `go`, `view` (with submenu `layout`), `preferences`,
`window`. Commit menu submenus: `new`, `rewrite`, `reset`. Earlier ids still work: `repository` (→ `branch`),
`navigate` (→ `go`), `tools` (→ `view`), `create` (→ `new`), `edit` in the commit menu (→ `rewrite`).

## Themes

Built in: **Light** and **Dark** (the default look; **System** picks one by the OS setting), **Kiwi Light** and
**Kiwi Dark** (`kiwi-light`, `kiwi-dark`; a green/amber palette). Select Theme lists the Kiwi themes,
your theme files, then Light, Dark and System; moving through the list previews.

A theme file, `themes/<anything>.theme.json`:

```jsonc
{
	"name": "Moss",            // shown in Select Theme, and the value for "theme" in settings.json
	"kind": "dark",            // "light" or "dark": the base look the variables go on top of
	"extends": "Kiwi Dark",    // optional: "Light", "Dark", "Kiwi Light", "Kiwi Dark" or another theme's name
	"variables": {
		"--accent": "#70a040",
		"--lane0": "#70a040",
	},
}
```

Variables a theme can set (CSS values; unknown names make the file invalid):

| Variable | Used for |
|---|---|
| `--bg` | window background (title bar, tab bar, side panes) |
| `--surface` | cards, lists, the main panes |
| `--surface-2` | secondary panels (side bar, file headers) |
| `--hover` | hovered rows and buttons |
| `--sel`, `--sel-ring` | selected row and its outline |
| `--border`, `--border-strong` | separators, input and button borders |
| `--text`, `--text-2`, `--muted` | main, secondary and quiet text |
| `--accent` | focus ring, HEAD badge, spinner, active controls |
| `--accent-soft`, `--accent-text` | ref badges and links: background and text |
| `--on-accent` | text on `--accent` |
| `--danger` | errors |
| `--lane0` … `--lane5` | commit graph lanes |
| `--shadow` | card and popup shadow (a `box-shadow` value) |
| `--add-bg`, `--add-gutter`, `--add-fg` | added lines in diffs: background, gutter, text/badge |
| `--del-bg`, `--del-gutter`, `--del-fg` | removed lines in diffs |
| `--wd-add`, `--wd-del` | word diff highlights |
| `--band-soft`, `--band` | hunk and file header bands |
| `--band-conflict`, `--conflict-fg` | conflicted files and warnings |
| `--syn-kw`, `--syn-str`, `--syn-com`, `--syn-num`, `--syn-fn`, `--syn-var`, `--syn-attr` | syntax colours |
| `--primary-bg`, `--primary-hover`, `--primary-text` | primary buttons (Commit, Save, …) |
| `--font-ui`, `--font-mono` | interface and code fonts (a `font-family` list; fonts are not bundled) |
| `--radius-control`, `--radius-card`, `--radius-pill` | corner radius of buttons, cards, ref badges |

Kiwi token mapping: page `--bg` = green-50 `#f8fbf4` ("paper"), `--surface-2`/`--accent-soft`/`--band-soft` =
green-100 `#f0f7e8` ("mist"), cards `--surface` = white, text = slate `#0f172a`/`#334155`/`#64748b`, borders slate
`#e2e8f0`/`#cbd5e1`, accents green-600/700/800, primary buttons amber-500 `#f59e0b` (hover amber-400, text
green-950), radii 0.75rem / 1rem / 9999px, UI font Figtree then system fonts, code SF Mono / Fira Code. Kiwi Dark
keeps the same hue family but stays almost black so green never competes with diffs: page `#0c0f09`, panels
`#121610`/`#191f15`, text `#e9ece4`, selection and bands in muted olive-gray, green 400/500 only for small accents
(links, lanes, focus), amber buttons. Diff additions use a distinct mint-emerald (`#0f2a1a` background, `#8be5ad`
text) so they are never confused with the olive UI tint. Text, link, button and diff pairs meet WCAG AA (4.5:1); `app/src/lib/themes.test.ts`
checks them.

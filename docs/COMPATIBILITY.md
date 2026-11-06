# File-format compatibility

commit.kiwi reads key binding, command palette and menu files in the JSON format that Sublime Merge documents
publicly for its own customisation (the "Key Bindings", "Command Palette", "Menus" and "Custom Commands" pages of the
Sublime Merge documentation). People who customised that application can bring their files along, and anyone can
write new ones from the same public description.

commit.kiwi is an independent project. It is not affiliated with, endorsed by, or sponsored by Sublime HQ Pty Ltd.
"Sublime Merge" is a trademark of its owner and is used here only to name the file format. This compatibility layer
was written from the public documentation alone; no files were copied or extracted from the application.

## What is read

| commit.kiwi file | Format | Older name still read |
|---|---|---|
| `keymap.json` | array of `{ "keys": [...], "command": "...", "args": {...}, "context": [...] }` | `Default.sublime-keymap` |
| `commands.json` | array of `{ "caption": "...", "command": "...", "args": {...} }` | `Default.sublime-commands` |
| `<Menu>.menu.json` | array of `{ "caption", "command", "args", "id", "children" }` | `<Menu>.sublime-menu` |

All files are JSON with `//` and `/* */` comments and trailing commas allowed, as the public format describes.

- **Keys**: modifier names `super`, `ctrl`, `alt`, `shift`, `primary` and key names such as `f5`, `enter`,
  `escape`, `pageup`; two-step chords are a list of two entries.
- **Context**: `key`, `operator` (`equal`, `not_equal`, `regex_match`, `not_regex_match`, `regex_contains`,
  `not_regex_contains`) and `operand`, evaluated against commit.kiwi's own modes and focused controls
  (see [CONFIGURATION.md](CONFIGURATION.md)).
- **Commands**: commit.kiwi registers its actions under the command names the public documentation uses where it
  has the same action (`new_tab`, `show_command_palette`, `toggle_side_bar`, `stage_all`, …). Arguments use the
  documented names.
- **Custom `git` command**: `{ "command": "git", "args": { "argv": [...] } }` runs git (never a shell) in the open
  repository, with the documented `$variables` (`$working_dir`, `$commit`, `$select_branch`, …).
- **Menus**: an item whose `id` matches an existing submenu adds its `children` there; other items are appended.

## Import from Sublime Merge

**File > Import from Sublime Merge…** copies a user's own files into commit.kiwi's config folder:

- Only the user folder is read: `~/Library/Application Support/Sublime Merge/Packages/User` on macOS,
  `~/.config/sublime-merge/Packages/User` on Linux, or a folder the user picks.
- Only these names, directly in that folder: the platform key map (`Default (OSX).sublime-keymap`,
  `Default (Linux).sublime-keymap`, else `Default.sublime-keymap`), `Default.sublime-commands` and the
  `<Menu>.sublime-menu` files commit.kiwi knows. Regular files up to 1 MiB; symlinks are skipped so nothing outside
  the folder is read.
- The application bundle and its packages are never opened.
- The plan is shown first. Existing files are replaced only when the user chooses so. The text is copied as is,
  after a comment naming its source; one context key with a different name for text fields is renamed.

## What is intentionally not compatible

- **Settings files** (`*.sublime-settings`): commit.kiwi has its own `settings.json` with its own preference names
  (some share a name where the meaning is the same).
- **Themes and colour schemes** (`*.sublime-theme`, `*.sublime-color-scheme`): commit.kiwi themes are CSS-variable
  files (`themes/*.theme.json`).
- **Packages and plugins**: there is no plugin API; `.sublime-package` archives are not read.
- **Mouse maps** are not read.
- **Commands commit.kiwi does not have**: menu items naming them show disabled; palette entries are left out; key
  bindings for them do nothing.
- **Look and default layout**: the default key bindings, palette wording and grouping, menus and visual design are
  commit.kiwi's own. The optional `sublime-style` key binding preset reproduces the documented key chords for
  compatibility; it is not the default.

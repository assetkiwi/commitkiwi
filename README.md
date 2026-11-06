# commit.kiwi

A fast desktop git client for macOS, with first-class support for repositories on remote machines.

- **Remote repositories over SSH**: open a repository on a server or dev box as if it were local. A small agent is
  uploaded over your existing ssh setup and does the git work there; nothing is mounted or synced.
- **Commit messages from a local model** (optional): a small language model running on your computer suggests a
  message for the staged changes. Your diff never leaves the machine.
- **Natural-language search** (optional, same model): switch the search bar's ✨ toggle on and describe the commits
  ("by Alex touching the login form last month"); the generated keyword query is shown for review before it runs.
- **Pull and merge requests** through your own `gh` (GitHub) or `glab` (GitLab), with no tokens stored by the app.
- **Branch cleanup**: list the branches that are merged, stale or whose upstream is gone, with their last commit and
  how far they are from the default branch, and delete the chosen ones in one go (local deletes can be undone).
- **Repository dashboard**: every recent repository, local and remote, with its branch, uncommitted changes,
  ahead/behind and last commit; fetch, fast-forward pull or open each one, or fetch them all at once.
- **Interactive rebase**: drag commits into a new order, set pick, reword, squash, fixup or drop per commit (or use
  the keyboard), edit messages inline and see the resulting history before applying; pushed commits need an extra
  confirmation, conflicts open the usual Continue/Abort flow, and Undo puts the branch back.
- **Undo and redo** for commits, checkouts, resets, merges and other ref changes, with checks that refuse anything
  that would touch uncommitted work.
- **Live updates** through a file watcher, locally and on remote hosts.
- **Line-level staging**, split and unified diffs, word diff, syntax colours, a three-way merge tool, blame and file
  history, search, a command palette, tabs you reorder by dragging and a console showing every git command it runs.
- **Themes and plain-file configuration**: light, dark and custom themes; key bindings, palette entries, menus and
  settings in JSON files.

Built with Tauri 2, Svelte 5 and Rust; git operations use the `git` command line.

## Install (macOS, Apple silicon)

Download the `.dmg` from the Releases page, open it and drag **commit.kiwi** to Applications.

The app is **ad-hoc signed but not notarized**: the project has no Apple Developer ID. macOS therefore blocks the first
launch of a downloaded copy. To allow it (macOS 15 and later):

1. Open commit.kiwi once; macOS says it cannot verify the app. Click **Done**.
2. Open **System Settings > Privacy & Security**, scroll to Security, and click **Open Anyway** next to the message
   about commit.kiwi. Confirm with your password.

Or, if you prefer the terminal and trust the download, remove the quarantine flag once:

```sh
xattr -dr com.apple.quarantine /Applications/commit.kiwi.app
```

Verify the download first. Each release lists SHA-256 checksums in `SHA256SUMS` and carries a GitHub build
provenance attestation:

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify commit.kiwi_<version>_aarch64.dmg --repo OWNER/REPO
```

(`OWNER/REPO` is this repository's path on GitHub.) A Homebrew tap may follow; it would install the same unnotarized
build and show the same Open Anyway steps. There is no auto-update yet: check the Releases page for new versions.

Linux: no desktop package yet (build from source). The Linux agent for remote repositories is built and bundled with
the macOS app.

## Build from source

Prerequisites: Rust 1.91+, Node 22, pnpm 10, cmake and a C/C++ compiler (llama.cpp is compiled on the first build),
the Xcode command line tools on macOS, and Docker for the Linux agents.

```sh
cd app && pnpm install && pnpm tauri dev   # run the app from source
scripts/build-agents.sh                    # static Linux agents (aarch64, x86_64) via Docker -> agents/
scripts/package-macos.sh                   # release .app and .dmg (rebuilds stale agents first)
```

`cd app && pnpm dev` runs only the UI in a browser against a built-in mock backend. Tests and project layout:
[CONTRIBUTING.md](CONTRIBUTING.md).

## Remote repositories

Pick **Remote (SSH)** on the New Tab page and enter a host from your `~/.ssh/config` (or `user@host`). The first
connection uploads the matching agent to `~/.cache/commitkiwi/` on that host. Authentication is whatever your ssh
config and ssh-agent already do; commit.kiwi never asks for or stores a remote password. Old agent versions are
cleaned up after 30 days (Preferences > Remote).

## Command line

`commitkiwi [path ...]` opens the repository containing each path in a tab (relative paths and files work); with no
path it opens or focuses the app. Install the link with **File > Install Command Line Tool…** (it goes into the first
writable of `/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`; no sudo). `commitkiwi --help` lists the options.

## Configuration

Preferences, key bindings, palette entries, menus and themes are JSON files (with comments) in the config folder,
`~/Library/Application Support/kiwi.commit.desktop/` on macOS. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
and [docs/KEYMAP.md](docs/KEYMAP.md). Existing key binding, command and menu files in the format Sublime Merge
documents can be imported: [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## AI commit messages and models

Suggestions are off until you download a model with **Download Commit Message Model…** from the command palette.
commit.kiwi does not include any model. The models it offers are third-party: Qwen3.5 2B and Qwen2.5-Coder 1.5B
Instruct (GGUF builds), downloaded on demand from Hugging Face (about 1 to 1.3 GB) under their own licences. They are
published as Apache-2.0 on their model cards; check the model card before you use one. The download shows the size and
source and asks first, and is verified against a pinned SHA-256. With a model present, an empty commit message box
shows a suggestion for the staged changes; **Tab** takes it. **Delete Commit Message Model…** removes it again.

The same model powers natural-language search: the ✨ button in the search bar (⌥⌘N, or **Search: Natural Language
Mode** in the palette) takes a sentence, Enter asks the model, and the resulting keywords (`author:`, `file:`,
`after:`, …) appear below the bar to edit, **Run** (Enter again) or **Edit as Keywords**. Dates such as "last month" or
"since Monday" are worked out without the model. A normal search never waits on the model.

## Security

commit.kiwi treats repositories as untrusted: displaying one does not run its hooks, filters or other configured
programs. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Design details:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), the [code of conduct](CODE_OF_CONDUCT.md) and the
[roadmap](docs/ROADMAP.md).

## Licence

Licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option. Copyright 2026 The
commit.kiwi contributors. Unless you state otherwise, any contribution you submit is dual-licensed the same way.

Third-party components and their licences are listed in [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md), which also
ships inside the app (**Help > About commit.kiwi & Licenses…**).

## Names and older versions

Earlier builds were called `gitmerge`, `merge.kiwi` and `sourcery.kiwi`. On first launch commit.kiwi copies their
preferences and config files and keeps using an already downloaded model. A command line link installed by an older
build points at the old app: remove it and install the tool again.

## Not affiliated

commit.kiwi is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Sublime HQ
Pty Ltd. "Sublime Merge" and "Sublime Text" are trademarks of their respective owner and are used only to describe
file-format compatibility. commit.kiwi can read key binding, command and menu files in the format documented publicly
for Sublime Merge, so existing customisations can be imported. All code, default bindings, menu definitions, wording,
icons and visual design in this repository were written by the commit.kiwi contributors; no files, artwork or themes
from Sublime Merge are included.

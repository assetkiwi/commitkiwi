# Architecture

commit.kiwi is a desktop git client. The window is a web UI (Svelte 5) inside a Tauri 2 shell; all git work is done
by a Rust core that runs the `git` command line, either on this computer or, for remote repositories, inside a small
agent program on the remote host, reached over SSH.

```
app/src             Svelte 5 UI (runes), TypeScript; pure logic in app/src/lib, components in app/src/components
app/src-tauri       Tauri shell: one generic `rpc` command, preferences, config files, menus, launcher, local model
crates/protocol     request/response types + length-prefixed msgpack framing, PROTO_VERSION
crates/core         every git operation and parser; `handle(Req) -> Resp` is the single entry point
crates/runner       Runner::{Local, Remote}: ssh connection, agent upload, askpass helper
crates/agent        `commitkiwi-agent --stdio`: the core behind a frame reader, run on the remote host
crates/llm          optional local commit message model (llama.cpp), download + prompt + generation
```

## Request path

The UI sends a `Req` through the Tauri command `rpc(location, req)`. `location` is `local` or `ssh:<host>`. For
`local` the shell calls `core::handle` directly (on a worker thread); for a remote location the runner forwards the
frame to that host's agent, which calls the same `core::handle` there. Local and remote repositories therefore behave
the same, and one test suite covers both (`crates/core/tests`, plus an agent loopback test in `crates/agent/tests`).

In a plain browser (no Tauri), `app/src/lib/mock.ts` answers every request with generated data. The UI development
server and all browser end-to-end tests run against this mock.

## Remote repositories (agent over SSH)

- The app runs the system `ssh` with the user's `~/.ssh/config`, `BatchMode=yes` and a ControlMaster socket
  (`~/.ssh/commitkiwi-%C`). Authentication is whatever ssh-agent and the config already provide; the app never
  sees or stores a remote password.
- On first connect it uploads the matching static Linux agent (musl, `x86_64` or `aarch64`) to
  `~/.cache/commitkiwi/agent-<sha256 prefix>`, so a changed build installs itself next to the old one. Uploads go to
  a temporary name and are renamed into place; a running agent keeps its file.
- The agent prints a fixed `MAGIC` marker before any frame, so shell start-up noise cannot corrupt the stream, and
  runs remote commands under `sh -c` (works with fish/csh login shells).
- A handshake compares `PROTO_VERSION`. When the installed agent speaks another version or the handshake fails, the
  app uploads again once and retries.
- Old agents are swept: after a connection comes up (at most once a day per host) one `sh -c` script touches the
  current agent file and deletes other regular `agent-*` files in that folder that have not been used for
  `agent_cleanup_days` (default 30, 0 = never). Symlinks, folders and other names are never touched.
- The agent reads frames on its main thread and handles each request on its own thread, so a `Cancel` reaches a busy
  agent on the same connection.

## Writes: job queue, journal, cancel

Every git command that changes something goes through `runGit` (`app/src/lib/jobs.svelte.ts`, pure state machine in
`journal.ts`):

- One strict FIFO queue per repository: a write pressed while another runs waits instead of being refused, because
  the next command may depend on the previous one. A failed or cancelled command drops the queue behind it.
- The backend runs a write as `Req::Job{job, req}`. Core registers each git step's process group; `Req::Cancel{job}`
  terminates it (or marks a job that has not started). Output is streamed back as `Resp::Output` frames (fetch, pull
  and push run with `--progress`).
- The journal (shown in the console panel) records label, status, times, output and errors. Requests that move refs
  reply `Resp::Moved`: HEAD before and after, and every ref that changed. The journal is in memory for the session
  only (capped at 300 entries).

Reads never queue; they run concurrently.

## Repository dashboard

**File > Repository Dashboard** (`show_dashboard`, also linked from the New Tab page) lists every repository on the
recent list (opened, bulk-added and remote ones) without opening tabs. Each row is one `Req::Overview`: a read (no
queue, hooks off, fsmonitor off so no daemon is started per repository) made of one `git status --porcelain=v2
--branch` (parsed by the same code as `Status`) and one `git log -1`, so it works through the agent unchanged. The UI
(`app/src/components/Dashboard.svelte`, pure logic in `app/src/lib/dashboard.ts`) asks at most 4 at a time with a 15 s
timeout each; a remote repository that times out or whose ssh link fails shows "offline", and the other repositories
on that host are not asked again in that round. The badge is the most pressing of diverged, dirty, behind, ahead and
clean, or error/offline.

Fetch and Pull are ordinary jobs through `runGit`, keyed `location|path` like the repository's tab: an open
repository's job queues behind that tab's own writes and shows in its console, an unopened one runs through the same
`Req::Job` path. Pull is `git pull --ff-only`, refused up front without a branch or upstream or when diverged, and
git's own refusal is reworded the same way. **Fetch All** fetches the listed repositories (not offline or broken
ones) 3 at a time with a progress count; Cancel stops starting new ones and cancels the running jobs.

## Branch cleanup

**Branch > Clean Up Branches…** (`cleanup_branches`) asks core for candidates (`Req::CleanupCandidates`, a read, so it
works the same through the agent): local branches merged into the default branch (origin's `HEAD`, else another
remote's, else `main`/`master`/`trunk`/`develop`) or into HEAD, local branches whose upstream is `[gone]`,
remote-tracking branches merged into their remote's default branch, and any of them without a commit for
`cleanup_stale_days`. The current branch, the default branch, branches checked out in any worktree and names matching
`cleanup_protected_branches` are never listed. Each comes with its tip's date, subject and author and its ahead/behind
count against the default branch (`app/src/lib/cleanup.ts` groups and selects; only merged ones start selected).

Local deletes are one job (`Req::DeleteBranches`): core checks again that every "merged" branch is merged, then
deletes them with `git branch -d` (or `-D` when only the default branch has the commits, since git's `-d` checks HEAD or
the upstream only); branches with unmerged commits use `-D` and only after a confirmation listing them. The job replies
`Moved`, so Undo recreates every branch at its old commit. Remote deletes are a separate job after a second
confirmation (`Req::DeleteRemoteBranches`: one `git push --delete -- <remote> refs/heads/<b>…` per remote, refs
validated as existing remote-tracking branches) and are not undoable.

## Interactive rebase

**Branch > Rebase Interactively…** (`interactive_rebase`, ⌥⌘R) lists the commits not on any remote-tracking branch
(the newest 50); a commit's **Rebase Interactively from Here…** lists that commit and everything after it. Both are
`Req::RebasePlan`, a read (one `rev-list` for the range, one `log` for the messages, one `rev-list --not --remotes` for
what is already pushed) that refuses a range with a merge. The editor (`app/src/components/RebaseEditor.svelte`, pure
logic in `app/src/lib/rebase.ts`) reorders rows by dragging a handle (pointer events, as in the tab bar) or Alt+↑/↓,
sets an action per row (p/r/s/f/d), edits reword messages inline, previews the resulting commits, and asks for an
extra confirmation when a pushed commit would be rewritten (it then needs a force push).

Apply is one job, `Req::InteractiveRebase { base, head, steps }`. Core re-checks everything: full commit ids only,
each commit of `base..HEAD` exactly once, HEAD unchanged since the plan, no merge, nothing in progress, a clean
working tree (untracked files are fine; no autostash), squash/fixup only below a kept commit, and the published check
from the first changed line on. It then runs the existing scripted path: `git rebase -i --no-autosquash
--no-autostash <base>` (or `--root`) with `GIT_SEQUENCE_EDITOR=cp '<todo>'`, as a normal write step (hooks kept,
killable process group, streamed output). Reworded and edited messages are not passed through an editor: after each
changed commit's last line the todo has `exec git commit --amend --allow-empty --quiet -F '<file>'` (the author is
kept). The message files live in the git dir (`commitkiwi-rebase/`, mode 0700), because those `exec` lines must still
work when the user continues after a conflict; the folder is removed when the rebase ends in the same job and
replaced by the next interactive rebase otherwise. A conflict stops the rebase like any other and the Working
Directory shows it under the rebase banner (Continue, Skip, Abort). The job replies `Moved`, so Undo puts HEAD and the
branch back (never `--hard`).

## Undo and redo

Undo replays the journal: entries that moved refs form a stack, an undo moves its entry to the redo stack, and any
other write clears redo. The backend request `Req::Undo` validates every ref name and object id it gets back and:

- restores only `refs/heads/*`, `refs/tags/*` and HEAD (a popped stash is re-added with `git stash store`; a stash is
  never dropped, so undoing a stash push is refused);
- refuses when the repository changed since (HEAD or any ref is not where the entry left it), while a job runs,
  during a merge/rebase/cherry-pick/revert, when the entry only moved remote-tracking refs (fetch, push), when a
  branch is checked out in another worktree, or when a file that would change has local changes;
- moves HEAD with `git checkout` when the branch changes, otherwise with `reset --soft` (undoing a commit leaves its
  changes staged), `--mixed` (only to undo a mixed reset, with nothing staged) or `--keep`; never `--hard`;
- updates the other refs in one `git update-ref --stdin` transaction with expected old values, rolled back if the
  HEAD move fails.

The UI asks for a dry run (`check`) after each status change so the menu caption can say why undo is unavailable.

## File watcher

Repositories update live. Locally the shell watches the working tree with the platform watcher (FSEvents on macOS,
inotify on Linux) through the `notify` crate; for remote repositories the agent runs the same watcher on the remote
host and pushes change events over the existing connection. Events are debounced, ignored paths (`.gitignore`, the
`.git` internals that do not matter) are filtered, and changes caused by our own `git status` are not reported back.
When watching is not possible (too many folders, unsupported file system) the repository falls back to polling
status every few seconds. A lost remote connection is shown and reconnected.

## Lazy diffs and tabs

Large changes stay fast because only what is near the view is built:

- Every file block renders its header; the body (request, diff, highlighting) only while it is within about 1.5
  screens of the visible area, a placeholder of the last measured height otherwise (`app/src/lib/lazy.ts`,
  `lazyBody.ts`). State that must survive unmounting (picked lines, "show entire file", file contents) lives in the
  parent. Diff requests go through a small queue (3 at a time) and are dropped when the body left the view first.
- Whole-file syntax highlighting uses Lezer parsers (files up to about 1 MB), with highlight.js per line otherwise.
- The commit list is virtualised. Every open repository tab stays mounted (hidden tabs are `inert`), so switching
  tabs issues no requests. Tab views are kept in a fixed order (by id), not the tab bar's: dragging a tab (pointer
  events with a 5 px threshold; HTML5 drag and drop belongs to the webview's file drop) or Move Tab Left/Right only
  reorders `app.tabs`, which is saved, and never moves or remounts a view.

## Security model

commit.kiwi assumes a cloned repository may be hostile. Its `.git/config` must not be able to run code just because
the repository is displayed.

**Git calls.** Core separates reads from writes:

- Reads (`git()`, `git_capped`, search, status, the dashboard's overview, diff, log, blame) run with `-c core.hooksPath=/dev/null`, add
  `--no-ext-diff --no-textconv` to log/show/diff/blame, override `core.fsmonitor` when it names a program (the
  built-in daemon, `true`, is kept), and blank every `filter.<driver>.clean/smudge/process` except the exact stock
  git-lfs command lines. The repository config is read again on every request (one `git config --get-regexp` call
  under `LC_ALL=C`), so a hook added later is still neutralised. Driver names that cannot be expressed as `-c`
  overrides make the read fail closed.
- Writes (`git_out`, `git_stdin`: commit, push, …) keep hooks and filters, as users expect.
- User paths are passed with `--literal-pathspecs`; object ids from the UI are checked before they reach git;
  commands are executed without a shell (argv only). The `.gitignore` writer refuses symlinks and non-regular files
  and writes through a temporary file plus rename.

**Input validation.** Ref names, remote names and URLs, clone targets, host names and custom `git` command
arguments (no aliases, no global options, no control characters) are validated in core before git runs. Tests:
`crates/core/tests/hardening.rs`, `m7.rs`, and unit tests in `crates/core/src/lib.rs`.

**Passwords (askpass).** For local repositories git and ssh run `GIT_ASKPASS`/`SSH_ASKPASS`, which point at the app's
own executable in helper mode. The helper connects to the running app over a unix socket in a private (0700)
temporary folder, authenticates with a random token, and the app shows the prompt in the window. Answers go socket →
stdout → git and are never stored or logged. Remote repositories rely on the user's ssh agent and keys.

**Forges.** Pull and merge requests are created by running the user's own `gh` (GitHub) or `glab` (GitLab) where the
repository lives, which already hold the login. commit.kiwi stores no tokens and calls no forge API itself. Arguments
are always `--flag=value` in argv, stdin is `/dev/null`, prompts and telemetry are disabled through environment
variables, and titles, bodies, branch and label names are validated first. Without a logged-in CLI the app opens the
forge's prefilled "new request" page in the browser instead.

**Command line launcher.** `commitkiwi [path …]` forwards paths to a running instance over a unix socket in the
config folder (folder 0700, owner checked, socket 0600, peer uid checked).

**Network.** Besides git, ssh, gh and glab, the only network use is the optional model download (Hugging Face, pinned
size and SHA-256).

## Local commit message model

`crates/llm` runs a small language model with llama.cpp (Metal on macOS) on this computer only, never in the agent:
the UI collects the facts (status, staged diff, recent subjects) through ordinary requests, so remote repositories
work too and the diff never leaves the machine. The prompt builder (`crates/llm/src/prompt.rs`) takes file names and
counts from git, drops noise (lock files, generated files, binaries), clips the diff to a budget, and shows recent
subjects as style hints; a GBNF grammar constrains the answer. The model is not bundled: it is downloaded on request
into the app's data folder (resumable, size and SHA-256 checked, `crates/llm/src/catalog.rs`).

**Natural-language search** uses the same loaded model (`llm_search_query`, `crates/llm/src/search.rs`), only when
the search bar's ✨ toggle is on and Enter is pressed. The UI (`app/src/lib/nlSearch.ts`, pure) resolves relative date
phrases ("last month", "since Monday", "3 days ago") to `after:`/`before:` dates first, then sends the sentence, today's
date, those dates, the `KEYWORDS` table of `app/src/lib/search.ts` and cheap hints (authors of the latest 300 commits,
top-level paths, local branches). The Rust side builds the GBNF grammar and the prompt (few-shot examples, filtered to
the keywords sent) from that table, so the model can only answer space-separated `keyword:value` terms and plain words
and the two cannot drift; it runs greedy with a fixed seed and at most 96 tokens. The answer is then parsed by the
ordinary search parser: unknown keywords, bad or made-up dates, a second `contents:`/`branch:` and non-hex `commit:`
values are dropped with a warning, the resolved dates replace the model's, and an empty result falls back to one word of
the sentence. The user reviews the query; it runs as the normal `Search` request, so nothing the model writes is ever
executed except as validated search terms. Bare dates are sent to git as the start of the day (`forGit`).

## Shutdown

Quitting (menu, Dock, logout) goes through AppKit's `terminate:`, which calls `exit()`: Tauri state, including a
loaded model, is never dropped, and ggml's C++ static destructors run. With Metal residency sets on, ggml then aborts
(`GGML_ASSERT([rsets->data count] == 0)` in `ggml_metal_rsets_free`, because the model's buffers are still
registered), so `main` sets `GGML_METAL_NO_RESIDENCY=1` before any thread starts
(`commitkiwi_llm::generate::disable_metal_residency_sets`). `scripts/check-exit.sh` checks it on a Mac.

## Configuration, preferences and themes

The config folder holds `preferences.json` (written by the Preferences window), `settings.json` (hand edits, wins over
the window), `keymap.json`, `commands.json`, `<Menu>.menu.json` and `themes/*.theme.json`. All are JSON with comments.
The shell writes only a fixed list of file names (temporary file + rename). Key bindings come from a preset (the
default one, or the `sublime-style` compatibility preset) with the user's keymap on top. Themes are sets of CSS
variables on top of a light or dark base; built-in themes are checked for WCAG AA contrast in
`app/src/lib/themes.test.ts`. See [CONFIGURATION.md](CONFIGURATION.md) and [KEYMAP.md](KEYMAP.md).

## Protocol versioning

`crates/protocol` defines every request and reply. Any change to those types bumps `PROTO_VERSION`; the Linux agents
must then be rebuilt (`scripts/build-agents.sh`) because the app uploads them as they are. Optional fields that old
peers can ignore (for example the timing field `Msg.ms`) do not need a bump. The agent's install path contains a hash
of its binary, so a new build never overwrites a running one.

## Names

The project was called `gitmerge`, then `merge.kiwi`, then `sourcery.kiwi`, before `commit.kiwi`. Identifiers without
dots use `commitkiwi`; the bundle identifier is `kiwi.commit.desktop`. On first launch the app copies preferences and
config files from the newest older config folder (`kiwi.sourcery.desktop`, `kiwi.merge.desktop`,
`app.gitmerge.desktop`) when the new one has none, uses an older `models` folder in place until a new one exists, and
the remote sweep also clears old agents in `~/.cache/{sourcerykiwi,mergekiwi,gitmerge}`. Older `SOURCERYKIWI_*`,
`MERGEKIWI_*` and `GITMERGE_*` environment variables are still read as fallbacks. Nothing is moved or deleted.

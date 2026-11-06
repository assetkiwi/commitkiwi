# Contributing to commit.kiwi

Thanks for helping. Bug reports, fixes and features are welcome. For anything larger than a small fix, open an issue
first so the approach can be agreed before you spend time on it. Security problems: see [SECURITY.md](SECURITY.md),
not the public tracker.

## Prerequisites

- macOS (arm64) for the desktop app; Linux works for the core, agent and UI tests.
- Rust 1.91 or newer (edition 2024), with the Xcode command line tools on macOS.
- `cmake` and a C/C++ compiler: the first build compiles llama.cpp (a few minutes).
- Node 22 and pnpm 10.
- Docker, to build the static Linux agents used for remote repositories.
- Google Chrome (or Chromium), for the Playwright end-to-end tests (`playwright-core` drives the system browser).
- `rsvg-convert`, only to regenerate icons.

## Build and run

```sh
cd app && pnpm install          # once
pnpm dev                        # UI in a browser on http://127.0.0.1:1420 with the mock backend
pnpm tauri dev                  # the real app (stop `pnpm dev` first: both use port 1420)
scripts/build-agents.sh         # Linux agents (aarch64, x86_64) via Docker -> agents/
scripts/package-macos.sh        # release .app + .dmg (see docs/RELEASING.md)
```

## Tests

```sh
cargo test --workspace                           # protocol, core (temporary fixture repos), runner, agent loopback, app
cargo clippy --workspace --all-targets -- -D warnings
cd app && pnpm check && pnpm test                # svelte-check + node:test unit tests
cd app && pnpm dev                               # in one terminal, then in another:
cd app && pnpm e2e                               # every browser end-to-end test against the mock backend
node app/e2e/smoke.mjs                           # or one file at a time
cargo test -p commitkiwi-agent --test docker -- --ignored   # Linux agent inside Alpine (needs Docker + built agents)
scripts/check-exit.sh                            # quitting with the model loaded must not crash (needs a Mac with Metal)
```

`#[ignore]` benchmarks (`crates/core/tests/watch_bench.rs`, `large_repo.rs`, `status_bench.rs`) print timings with
`--release -- --ignored --nocapture`. `COMMITKIWI_REAL_REPO=<path>` runs `real_repo.rs` read-only against a checkout
of your choice. Tests must never write to a repository they did not create.

## Code layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short: `crates/core` does all git work, `crates/protocol` is
the wire format, `crates/runner` and `crates/agent` handle remote repositories, `crates/llm` the optional model,
`app/src-tauri` the desktop shell and `app/src` the UI (pure logic in `app/src/lib`, components in
`app/src/components`).

## Coding rules

- Keep changes small and focused; match the surrounding style. `cargo clippy` must stay clean and `pnpm check` must
  pass.
- Reads and writes are different paths in core: reads use `git()` / `git_capped` (hardened, no hooks), writes use
  `git_out` / `git_stdin` (hooks kept, killable, streamed). Never put a read on the write path or the reverse. Any new
  `log`/`show`/`diff`/`blame` call adds `--no-ext-diff --no-textconv`.
- Run git without a shell, pass user paths with `--literal-pathspecs`, and validate anything that comes from the UI
  (ref names, object ids, URLs, hosts) in core before it reaches git.
- Every write from the UI goes through `runGit` (`app/src/lib/jobs.svelte.ts`) so it is queued, journaled and
  cancellable.
- Files under `app/src/lib` that have tests stay import-free or import `./x.ts` with the extension (node runs them
  with `--experimental-strip-types`). TypeScript is pinned to `~6` for svelte-check.
- Add a test with each fix or feature: Rust integration tests build their own temporary repositories; UI behaviour
  goes in a unit test or an e2e file against the mock (`app/src/lib/mock.ts`).
- Never store secrets. Passwords pass through the askpass helper only; forges use the user's `gh`/`glab`.

## Adding things

- **A command**: register it with `registerCommand(name, { caption, run })` in `app/src/lib/appCommands.ts`
  (app-wide) or in the view that owns it (for example `RepoView.svelte`). A caption makes it appear in the palette;
  to place it in a category add it to `DEFAULT_PALETTE` in `app/src/lib/palette.ts`. Prefer an existing public
  command name when the action is the same, so users' key binding files keep working.
- **A menu item**: add it to `MAIN_MENU` in `app/src/lib/menu.ts` (the menu bar) or to the right definition in
  `app/src/lib/contextMenus.ts`. Items whose command is missing show disabled. Update the tests in `menu.test.ts` or
  `contextMenus.test.ts`.
- **A key binding**: add it to `app/src/lib/defaultKeymap.ts` and the table in `docs/KEYMAP.md` (and to
  `app/src/lib/presets/sublime-style.ts` when the compatibility preset has the same chord).
- **A built-in theme**: add `app/src/lib/themes/<id>.theme.json` (variables from `THEME_VARIABLES` in
  `app/src/lib/themes.ts`), register it in `BUILTIN_THEMES` (`app/src/lib/state.svelte.ts`) and add it to the
  contrast checks in `app/src/lib/themes.test.ts` (WCAG AA).
- **A preference**: add it with its default in `state.svelte.ts`, to the Preferences window and to the
  `settings.json` list in `docs/CONFIGURATION.md`.

## Protocol changes and the agent

Any change to the types in `crates/protocol` bumps `PROTO_VERSION`. After a change to `crates/protocol`,
`crates/core` or `crates/agent`, rebuild the Linux agents with `scripts/build-agents.sh` and run the Docker agent
test; the app uploads the agent binaries as they are, and an old agent with a new protocol is refused.

## Third-party licences

When you add or update a dependency (Cargo or npm), run `scripts/gen-third-party.py` and commit the updated
`THIRD-PARTY-LICENSES.md`. New dependencies must have a licence compatible with MIT OR Apache-2.0 distribution.

## Clean-room rule

commit.kiwi is compatible with some file formats of other git clients, built from their public documentation only.

- Do not copy, extract, decompile or paraphrase files, artwork, themes, menus, key maps, text or code from
  proprietary applications, including ones installed on your machine. Use public documentation, and write your own.
- Do not commit screenshots of private repositories or of other applications. Test data must be made up (use
  `example.com` addresses and generic names).

By contributing you agree that your contribution is licensed under MIT OR Apache-2.0, as the rest of the project.

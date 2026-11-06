# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's **Report a vulnerability** button on this repository's
Security tab (private vulnerability reporting), not in a public issue or pull request. Include what you found, how to
reproduce it (a small repository or config that triggers it is ideal), and the version you tested.

You should get a first answer within a week. Fixes are released as soon as they are ready, and reporters are credited
in the release notes unless they prefer otherwise.

## Supported versions

commit.kiwi is pre-1.0. Only the latest release gets security fixes.

## Security model in short

The full description is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model).

- **Untrusted repositories.** Opening or displaying a repository must not run code from it. Read-only git calls
  disable hooks, external diff and textconv drivers, `core.fsmonitor` programs and clean/smudge/process filters
  (except stock git-lfs); the repository config is re-checked on every request. Writes (commit, push, …) keep hooks,
  as git users expect.
- **No shell.** git, ssh, gh and glab are run with an argument vector, never through a shell. Ref names, object ids,
  URLs, host names and custom command arguments are validated before git runs.
- **Secrets.** commit.kiwi stores no passwords or tokens. Local password and passphrase prompts go through an askpass
  helper over a private, token-authenticated unix socket and are never logged. Remote repositories use your ssh agent
  and keys. Pull/merge requests use your own logged-in `gh` / `glab`.
- **Remote agent.** A static agent binary is uploaded to `~/.cache/commitkiwi/` on hosts you connect to, over your
  ssh connection, and runs as your user.
- **Network.** Besides git, ssh, gh and glab, the only network access is the optional commit message model download
  from Hugging Face, checked against a pinned size and SHA-256.

Things that are in scope: code execution or file writes caused by viewing a repository, escaping the validation of
UI input into git or ssh arguments, leaking a password or a diff off the machine, the askpass or launcher sockets.

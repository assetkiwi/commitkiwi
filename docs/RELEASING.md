# Releasing

Releases are macOS arm64 `.dmg` files (ad-hoc signed, not notarized) plus checksums and a build provenance
attestation, published as a GitHub Release. Linux is "build from source" for now; the Linux agents ship inside the
macOS app.

`OWNER/REPO` below stands for this repository's GitHub path.

> The workflows in `.github/workflows/` (`ci.yml`, `release.yml`) have not been run outside GitHub; check the first
> runs closely.

## Checklist

1. **Version.** Bump the version in `Cargo.toml` (`[workspace.package]`), `app/package.json` and
   `app/src-tauri/tauri.conf.json` (they must match), then `cargo check` to update `Cargo.lock`.
2. **Licences.** `scripts/gen-third-party.py` and commit `THIRD-PARTY-LICENSES.md` if it changed (the packaging
   script refuses a stale file).
3. **Changelog.** Add a section for the version to the release notes (what changed, anything users must do).
4. **Verify.** `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
   `cd app && pnpm check && pnpm test`, the e2e files against `pnpm dev`, and `scripts/publish-gate.sh`.
5. **Tag.** A signed, annotated tag: `git tag -s v0.1.0 -m "commit.kiwi 0.1.0"`, then `git push origin v0.1.0`.
6. **Build.** Pushing the tag runs `release.yml`: an Ubuntu job builds the Linux agents (`scripts/build-agents.sh`),
   a macOS arm64 job builds the app with them, writes `SHA256SUMS`, attests the build and creates a **draft**
   release. To build by hand instead: `scripts/package-macos.sh` (it checks the licence file, bundles the agents
   and licences, and runs `codesign --verify --deep --strict`), then copy the `.dmg` into an empty folder and run
   `scripts/release-checksums.sh <folder>`.
7. **Check the draft.** Download the `.dmg` and `SHA256SUMS` from the draft and run the README commands:
   ```sh
   shasum -a 256 -c SHA256SUMS --ignore-missing
   gh attestation verify commit.kiwi_0.1.0_aarch64.dmg --repo OWNER/REPO
   ```
   Install it on a Mac that has never run commit.kiwi and follow the README's Open Anyway steps; open a local and a
   remote repository; open Help > About commit.kiwi & Licenses… and the third-party licences.
8. **Publish** the draft with the release notes. Say plainly that the build is not notarized, how to allow it
   (README "Install"), and that there is no auto-update: users download new versions from the Releases page.

## Homebrew tap (optional)

A separate `OWNER/homebrew-tap` repository can carry a cask. Do not strip the quarantine attribute in the cask; tell
users how to allow the app instead:

```ruby
cask "commit-kiwi" do
  version "0.1.0"
  sha256 "<sha256 of the dmg from SHA256SUMS>"

  url "https://github.com/OWNER/REPO/releases/download/v#{version}/commit.kiwi_#{version}_aarch64.dmg"
  name "commit.kiwi"
  desc "Git client with remote repositories over SSH"
  homepage "https://github.com/OWNER/REPO"

  depends_on arch: :arm64
  depends_on macos: ">= :ventura"

  app "commit.kiwi.app"

  caveats <<~EOS
    commit.kiwi is not notarized. On first launch macOS blocks it: open System Settings >
    Privacy & Security and click "Open Anyway" next to the commit.kiwi message.
  EOS
end
```

## Linux

No desktop package yet. Users build from source (README "Build from source"); `scripts/build-agents.sh` builds the
static agents that remote repositories use.

## Signing and notarization

The app is ad-hoc signed (`bundle.macOS.signingIdentity` `"-"` in `tauri.conf.json`), which keeps the bundle's code
signature valid but does not identify a developer. Notarization would need an Apple Developer ID; until then the
Open Anyway step is required on every Mac.

## Workflow supply chain

Every third-party action in `.github/workflows/*.yml` is pinned to a full commit SHA with the human-readable ref in a
trailing comment, because the release job holds `contents: write`, `id-token: write` and `attestations: write`.
`.github/dependabot.yml` proposes weekly bumps as reviewable pull requests. To bump by hand:
`git ls-remote https://github.com/<owner>/<action> 'refs/tags/<tag>^{}' 'refs/tags/<tag>'` and use the `^{}` commit when
the tag is annotated (otherwise the plain tag line). `dtolnay/rust-toolchain` is pinned to the head of its `stable`
branch, which moves; Dependabot keeps it current. Review the diff of an action before accepting a bump.

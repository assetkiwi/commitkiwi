#!/bin/sh
# macOS build: Linux agents (rebuilt via Docker when stale) + `tauri build` -> commit.kiwi.app and .dmg.
# Ad-hoc signed (bundle.macOS.signingIdentity "-"), no Developer ID, not notarized.
# The agents ship inside the app (Contents/Resources/agents/linux-*/commitkiwi-agent) for remote repos, next to
# LICENSE-MIT, LICENSE-APACHE and THIRD-PARTY-LICENSES.md.
# usage: scripts/package-macos.sh        (honours CARGO_TARGET_DIR; must be absolute)
set -eu
cd "$(dirname "$0")/.."
for arch in aarch64 x86_64; do
  f=agents/linux-$arch/commitkiwi-agent
  if [ ! -f "$f" ] || [ -n "$(find crates/protocol crates/core crates/agent -newer "$f" -type f -print | head -n 1)" ]; then
    scripts/build-agents.sh $arch
  fi
done
if ! python3 scripts/gen-third-party.py --check; then
  echo "THIRD-PARTY-LICENSES.md is out of date: run scripts/gen-third-party.py and commit the result" >&2
  exit 1
fi
(cd app && pnpm tauri build --bundles app,dmg)
target=${CARGO_TARGET_DIR:-$PWD/target}
app=$(ls -d "$target"/release/bundle/macos/*.app | head -n 1)
for f in THIRD-PARTY-LICENSES.md LICENSE-MIT LICENSE-APACHE; do
  cmp -s "$f" "$app/Contents/Resources/$f" || { echo "missing or different in the bundle: $f" >&2; exit 1; }
done
codesign --verify --deep --strict --verbose=2 "$app"
echo
echo "built (ad-hoc signed, not notarized):"
ls -d "$app" "$target"/release/bundle/dmg/*.dmg

#!/bin/sh
# Linux build: `tauri build` -> AppImage, .deb and .rpm for the machine's architecture. The static Linux agents
# (agents/linux-*/commitkiwi-agent, from scripts/build-agents.sh) ship inside the package for remote repos, next to
# LICENSE-MIT, LICENSE-APACHE and THIRD-PARTY-LICENSES.md.
# Needs: libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev cmake clang file rpm
# usage: scripts/package-linux.sh        (honours CARGO_TARGET_DIR; must be absolute)
set -eu
cd "$(dirname "$0")/.."
for arch in aarch64 x86_64; do
  [ -x "agents/linux-$arch/commitkiwi-agent" ] || { echo "missing agents/linux-$arch/commitkiwi-agent: run scripts/build-agents.sh" >&2; exit 1; }
done
if ! python3 scripts/gen-third-party.py --check; then
  echo "THIRD-PARTY-LICENSES.md is out of date: run scripts/gen-third-party.py and commit the result" >&2
  exit 1
fi
(cd app && pnpm tauri build --bundles appimage,deb,rpm)
target=${CARGO_TARGET_DIR:-$PWD/target}
deb=$(ls "$target"/release/bundle/deb/*.deb | head -n 1)
# the licences and both agents must be in the package
list=$(dpkg-deb -c "$deb")
for f in THIRD-PARTY-LICENSES.md LICENSE-MIT LICENSE-APACHE agents/linux-aarch64/commitkiwi-agent agents/linux-x86_64/commitkiwi-agent; do
  echo "$list" | grep -q "/$f\$" || { echo "missing in $deb: $f" >&2; exit 1; }
done
echo
echo "built:"
ls "$target"/release/bundle/appimage/*.AppImage "$deb" "$target"/release/bundle/rpm/*.rpm

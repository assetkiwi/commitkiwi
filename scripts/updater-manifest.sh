#!/bin/sh
# Write <dir>/latest.json, the in-app updater's manifest (Tauri updater format), from the signed update bundles in
# <dir>: the macOS commit.kiwi_<v>_aarch64.app.tar.gz and the Linux AppImages, each with its .sig next to it.
# The app reads it from the latest published release, so a draft is never offered.
# usage: scripts/updater-manifest.sh <dir> <tag> <owner/repo>
set -eu
dir=${1:?usage: scripts/updater-manifest.sh <dir> <tag> <owner/repo>}
tag=${2:?tag}
repo=${3:?owner/repo}
cd "$dir"
entries=""
add() { # <platform> <file>
  [ -f "$2" ] && [ -f "$2.sig" ] || { echo "updater-manifest: missing $2 or $2.sig" >&2; exit 1; }
  # .sig files are one line of base64: no JSON escaping needed
  entries="$entries${entries:+,}
    \"$1\": { \"signature\": \"$(tr -d '\n' < "$2.sig")\", \"url\": \"https://github.com/$repo/releases/download/$tag/$2\" }"
}
for f in *_aarch64.app.tar.gz; do add darwin-aarch64 "$f"; done
for f in *_amd64.AppImage; do add linux-x86_64 "$f"; done
for f in *_aarch64.AppImage; do add linux-aarch64 "$f"; done
cat > latest.json <<EOF
{
  "version": "${tag#v}",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {$entries
  }
}
EOF
python3 -m json.tool latest.json > /dev/null
echo "wrote $dir/latest.json"

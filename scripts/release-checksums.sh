#!/bin/sh
# Write SHA256SUMS for the release files in <dir> (every regular file except SHA256SUMS itself), sorted by name,
# in the format `shasum -a 256 -c SHA256SUMS` checks.
# usage: scripts/release-checksums.sh <dir>
set -eu
dir=${1:?usage: scripts/release-checksums.sh <dir>}
cd "$dir"
files=$(find . -maxdepth 1 -type f ! -name SHA256SUMS ! -name '.*' | sed 's|^\./||' | LC_ALL=C sort)
[ -n "$files" ] || { echo "release-checksums: no files in $dir" >&2; exit 1; }
# shortcut: release file names have no spaces or newlines (tauri/our scripts name them); quote-safe enough for that.
# shellcheck disable=SC2086
shasum -a 256 $files > SHA256SUMS
shasum -a 256 -c SHA256SUMS
echo "wrote $dir/SHA256SUMS"

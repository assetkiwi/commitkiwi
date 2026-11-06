#!/bin/sh
# Publish gate: scan every file that would be published (tracked + untracked, honouring .gitignore) and exit 1 on
# any hit. Run from the repository to check, or with a directory argument (e.g. an export) to scan that tree.
#
# Checks:
#   - private patterns, one extended regex per line (case-insensitive), from $PUBLISH_GATE_PATTERNS or else
#     .git/info/publish-gate-patterns (outside the published tree, so the names themselves are never published);
#   - home-folder paths (/Users/<name>), private key blocks, GitHub and AWS access tokens;
#   - folders that must never be published (reference/, agents/, target/, node_modules/, .omc/, .claude/).
# usage: scripts/publish-gate.sh [dir]
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
patterns=${PUBLISH_GATE_PATTERNS:-$(cd "$here" && git rev-parse --path-format=absolute --git-path info/publish-gate-patterns)}
cd "${1:-$here}"
if [ ! -f "$patterns" ]; then
  echo "publish-gate: no private pattern file at $patterns (set PUBLISH_GATE_PATTERNS)" >&2
  exit 2
fi
private=$(grep -v -e '^#' -e '^[[:space:]]*$' "$patterns" | paste -s -d '|' -)
builtin='/Users/[a-z]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}'
regex=${private:+$private|}$builtin

list=$(mktemp)
trap 'rm -f "$list"' EXIT
git ls-files -co --exclude-standard > "$list"
hits=0

bad_dirs=$(grep -E '^(reference|agents|target|node_modules|\.omc|\.claude)/|/node_modules/' "$list" || true)
if [ -n "$bad_dirs" ]; then
  echo "publish-gate: files in folders that must not be published:"
  echo "$bad_dirs" | head -n 20
  hits=1
fi

# shortcut: file names with a newline are not handled (git would quote them); none exist in this project.
while IFS= read -r f; do
  [ -f "$f" ] || continue
  if grep -a -q -i -E "$regex" "$f"; then
    hits=1
    if grep -I -q . "$f" 2>/dev/null; then
      grep -n -i -E "$regex" "$f" | cut -c1-200 | sed "s|^|$f:|"
    else
      echo "$f: (binary file matches)"
    fi
  fi
  if printf '%s\n' "$f" | grep -q -i -E "$regex"; then echo "$f: (file name)"; hits=1; fi
done < "$list"

count=$(wc -l < "$list" | tr -d ' ')
if [ "$hits" -ne 0 ]; then
  echo "publish-gate: FAILED ($count files scanned)" >&2
  exit 1
fi
echo "publish-gate: ok, 0 hits in $count files"

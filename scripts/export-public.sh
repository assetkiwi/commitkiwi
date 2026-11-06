#!/usr/bin/env bash
# Export the publishable working tree (tracked + untracked files, honouring .gitignore) into a NEW repository with a
# single commit, for publishing. The source repository and its history are not touched.
#
# usage: scripts/export-public.sh <target-dir> [--name 'Full Name'] [--email addr]
#   The commit identity comes from --name/--email, else GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL; it is required and set
#   only in the new repository. Identities matching .git/info/publish-identity-deny (work domains) are refused.
set -euo pipefail
src=$(cd "$(dirname "$0")/.." && pwd)
target="" name=${GIT_AUTHOR_NAME:-} email=${GIT_AUTHOR_EMAIL:-}
while [ $# -gt 0 ]; do
  case $1 in
    --name) name=${2:?--name needs a value}; shift 2 ;;
    --email) email=${2:?--email needs a value}; shift 2 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) [ -z "$target" ] || { echo "one target directory only" >&2; exit 2; }; target=$1; shift ;;
  esac
done
[ -n "$target" ] || { echo "usage: scripts/export-public.sh <target-dir> [--name 'Full Name'] [--email addr]" >&2; exit 2; }
if [ -e "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null || echo x)" ]; then
  echo "refusing: $target exists and is not an empty folder" >&2; exit 1
fi

# identity: required, plausible, and not one of the private names
[ -n "$name" ] && [ -n "$email" ] || { echo "refusing: a commit identity is required (--name and --email)" >&2; exit 1; }
[[ $email =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { echo "refusing: not an email address: $email" >&2; exit 1; }
# employer/work domains the public identity must not use: one regex per line in .git/info/publish-identity-deny
deny=${PUBLISH_IDENTITY_DENY:-$(cd "$src" && git rev-parse --path-format=absolute --git-path info/publish-identity-deny)}
[ -f "$deny" ] || { echo "refusing: no identity deny list at $deny (set PUBLISH_IDENTITY_DENY)" >&2; exit 1; }
denied=$(grep -v -e '^#' -e '^[[:space:]]*$' "$deny" | paste -s -d '|' -)
if [ -n "$denied" ] && printf '%s\n%s\n' "$name" "$email" | grep -q -i -E "$denied"; then
  echo "refusing: $email / $name matches the identity deny list; use your public identity" >&2; exit 1
fi
export PUBLISH_GATE_PATTERNS=${PUBLISH_GATE_PATTERNS:-$(cd "$src" && git rev-parse --path-format=absolute --git-path info/publish-gate-patterns)}

echo "==> publish gate on $src"
"$src/scripts/publish-gate.sh"

echo "==> copy files"
mkdir -p "$target"
target=$(cd "$target" && pwd)
(cd "$src" && git ls-files -z -co --exclude-standard | while IFS= read -r -d '' f; do
  if [ -f "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi
done | tar -cf - --null -T -) | (cd "$target" && tar -xpf -)

echo "==> new repository"
cd "$target"
git init -q -b main
git config user.name "$name"
git config user.email "$email"
git add -A
git -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -q -m "Initial public release"
"$src/scripts/publish-gate.sh" "$target"

files=$(git ls-files | wc -l | tr -d ' ')
size=$(du -sh "$target" | cut -f1)
echo
echo "Exported $files files ($size) to $target as one commit by $name <$email>:"
git log --oneline
cat <<EOF

Next steps (nothing has been pushed):
  1. Create an empty repository on GitHub (no README/licence), then:
       cd "$target" && git remote add origin git@github.com:OWNER/REPO.git && git push -u origin main
  2. In the repository settings enable secret scanning + push protection and private vulnerability reporting.
  3. Release: follow docs/RELEASING.md; sign the first tag (git tag -s v0.1.0 -m "commit.kiwi 0.1.0").
EOF

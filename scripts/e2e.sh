#!/bin/sh
# Browser end-to-end tests against the Vite dev server (mock backend): starts `pnpm dev` on 127.0.0.1:1420 unless
# one is already running, runs the given e2e files (default: all of `pnpm e2e`), stops the server it started.
# usage: scripts/e2e.sh [name ...]      e.g. scripts/e2e.sh m5b keys
set -eu
cd "$(dirname "$0")/../app"
started=""
if ! curl -s -o /dev/null http://127.0.0.1:1420; then
  pnpm dev >"${TMPDIR:-/tmp}/commitkiwi-e2e-dev.log" 2>&1 &
  started=$!
  trap 'kill $started 2>/dev/null; pkill -P $started 2>/dev/null || true' EXIT INT TERM
  i=0
  until curl -s -o /dev/null http://127.0.0.1:1420; do
    i=$((i + 1)); [ $i -gt 60 ] && { echo "dev server did not start, see ${TMPDIR:-/tmp}/commitkiwi-e2e-dev.log" >&2; exit 1; }
    sleep 0.5
  done
fi
if [ $# -eq 0 ]; then
  pnpm e2e
else
  for f in "$@"; do node "e2e/$f.mjs"; done
fi

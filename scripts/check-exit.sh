#!/bin/sh
# Quit-crash regression check (needs a Mac with Metal): the exit example keeps Metal memory alive and returns from
# main; it must exit 0 every time (134 = ggml aborted in its static destructors). `--keep-residency` shows the crash.
# usage: scripts/check-exit.sh [runs] [example args]   (COMMITKIWI_EXIT_MODEL=<model.gguf> to use a real model)
set -eu
cd "$(dirname "$0")/.."
runs=${1:-20}
[ $# -gt 0 ] && shift
cargo build -q -p commitkiwi-llm --example exit
fails=0
for _ in $(seq "$runs"); do
  target/debug/examples/exit "$@" >/dev/null 2>&1 || { echo "exit code $?"; fails=$((fails + 1)); }
done
echo "check-exit: $fails of $runs runs failed"
[ "$fails" -eq 0 ]

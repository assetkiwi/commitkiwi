#!/bin/sh
# Build static Linux agents (musl, inside Docker) into agents/linux-<arch>/commitkiwi-agent.
# The app uploads the matching one to a remote host on first connect (COMMITKIWI_AGENT_DIR or ./agents next to the app).
# usage: scripts/build-agents.sh [aarch64] [x86_64]     (default: both; the non-native arch runs under emulation, slower)
set -eu
cd "$(dirname "$0")/.."
archs=${*:-"aarch64 x86_64"}
for arch in $archs; do
  case $arch in
    aarch64) platform=linux/arm64 ;;
    x86_64)  platform=linux/amd64 ;;
    *) echo "unknown arch $arch" >&2; exit 2 ;;
  esac
  echo "==> $arch"
  docker run --rm --platform $platform \
    -v "$PWD":/src -w /src -v commitkiwi-cargo:/usr/local/cargo/registry \
    -e CARGO_TARGET_DIR=/src/target/docker-$arch \
    rust:alpine sh -c 'apk add --no-cache musl-dev >/dev/null && cargo build --release -p commitkiwi-agent'
  mkdir -p agents/linux-$arch
  cp target/docker-$arch/release/commitkiwi-agent agents/linux-$arch/commitkiwi-agent
done

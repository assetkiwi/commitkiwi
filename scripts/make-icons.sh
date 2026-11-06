#!/bin/sh
# Regenerate every app icon from app/src-tauri/icon-source/commitkiwi.svg (1024 viewBox, full-bleed rounded square).
# macOS does not mask app icons, so the artwork is shrunk to Apple's 824/1024 grid with transparent margins
# (otherwise it looks bigger than every other Dock icon). Needs rsvg-convert (brew install librsvg).
# usage: scripts/make-icons.sh
set -eu
cd "$(dirname "$0")/../app"
src=src-tauri/icon-source/commitkiwi.svg
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
{
  echo '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><g transform="translate(100 100) scale(0.8046875)">'
  grep -v '^<?xml' "$src"
  echo '</g></svg>'
} > "$tmp/padded.svg"
rsvg-convert -w 1024 -h 1024 "$tmp/padded.svg" -o src-tauri/app-icon.png
pnpm tauri icon src-tauri/app-icon.png
rm -rf src-tauri/icons/android src-tauri/icons/ios   # mobile targets are not built
cp "$src" public/favicon.svg                         # browser tab icon for `pnpm dev`
echo "icons written to app/src-tauri/icons/"

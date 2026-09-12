#!/usr/bin/env bash
# Builds the Chrome Web Store zip: extension files only, no backend, no docs.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -e 'process.stdout.write(require("./manifest.json").version)')
OUT="dist/bouncer-${VERSION}.zip"
mkdir -p dist
rm -f "$OUT"
zip -q -r "$OUT" manifest.json src vendor icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png -x '*.DS_Store'
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
unzip -Z1 "$OUT"

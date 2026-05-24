#!/usr/bin/env bash
# Qualify, then package the extension for the Chrome Web Store.
# Runs the unit + manifest qualification tests and only zips a clean build if
# they pass. Dev-only files (tests, docs, icon generator, README) are excluded;
# runtime lib/ is included.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)" # -> chrome-extension/
ROOT="$(cd "$HERE/.." && pwd)"           # repo root

echo "▶ Qualification: unit + manifest tests"
( cd "$ROOT" && node --experimental-vm-modules node_modules/jest/bin/jest.js chrome-extension )

VER="$(node -e "process.stdout.write(require('$HERE/manifest.json').version)")"
OUT="$ROOT/adhan-caster-pro-$VER.zip"
rm -f "$OUT"

( cd "$HERE" && zip -rq "$OUT" . \
  -x "README.md" -x "docs/*" -x "tests/*" -x "icons/generate-icons.cjs" \
  -x ".DS_Store" -x "*/.DS_Store" )

echo "✓ Qualified and packaged: $OUT"

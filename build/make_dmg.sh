#!/usr/bin/env bash
# Package dist/FeatherWatch.app into dist/FeatherWatch.dmg (run build.sh first).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d dist/FeatherWatch.app ] || { echo "dist/FeatherWatch.app missing - run build/build.sh"; exit 1; }
STAGE="$(mktemp -d)"
cp -R dist/FeatherWatch.app "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f dist/FeatherWatch.dmg
hdiutil create -volname FeatherWatch -srcfolder "$STAGE" -ov -format UDZO dist/FeatherWatch.dmg
rm -rf "$STAGE"
echo "Done: dist/FeatherWatch.dmg"

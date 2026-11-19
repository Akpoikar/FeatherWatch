#!/usr/bin/env bash
# Build FeatherWatch.app (macOS) / FeatherWatch folder (Linux). Output: dist/
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PYTHON:-python3}"
if [ ! -d .venv ]; then "$PY" -m venv .venv; fi
. .venv/bin/activate
python -m pip install --upgrade pip -q
python -m pip install -r requirements-dev.txt -q
pyinstaller --noconfirm --clean --distpath dist --workpath .pyi-build build/featherwatch.spec
rm -rf dist/FeatherWatch.zip
if [ -d dist/FeatherWatch.app ]; then
  ( cd dist && ditto -c -k --keepParent FeatherWatch.app FeatherWatch-mac.zip )
  echo "Done: dist/FeatherWatch.app (+ dist/FeatherWatch-mac.zip). Optional: build/make_dmg.sh"
else
  echo "Done: dist/FeatherWatch/"
fi

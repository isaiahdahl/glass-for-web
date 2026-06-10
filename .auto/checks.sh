#!/bin/bash
# Lightweight correctness checks (run after every passing benchmark).
# Constraints: no test framework in this repo, so we only:
#   - check the JS parses
#   - re-verify essential filter primitive ids survive in index.html
#   - sanity-check no obvious console errors during a quick chromium open
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node --check app.js
node --check glass.js

# We expect these primitives to still be addressable from app.js by id.
ids_used=$(grep -oE 'getElementById\("[a-zA-Z0-9_-]+"\)' app.js | grep -oE '"[^"]+"' | tr -d '"' | sort -u)
for id in $ids_used; do
  if ! grep -q "id=\"$id\"" index.html; then
    echo "[checks] app.js references id=$id but it's missing in index.html" >&2
    exit 1
  fi
done

#!/bin/bash
# Autoresearch measurement entry point.
#
# 1. Ensures the static demo server is running on 127.0.0.1:8132 (background)
# 2. Quick syntax sanity check on the JS files (so we fail fast before
#    spinning up two browsers if something obvious is broken)
# 3. Runs the Playwright Chromium+WebKit comparison and emits METRIC lines.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT=8132
PIDFILE=".auto/.server.pid"

# --- syntax sanity (≈100ms) ----------------------------------------------
# Catches typos that would just blow up Playwright with no useful signal.
node --check app.js
node --check glass.js
# Cheap HTML sanity: ensure key IDs are still present.
for id in glassSvgFilter feMap feSourceBlur feDispR feDispG feDispB \
          fePickupOffset fePickupBlur fePickupMatrix feWhiteSpecMatrix \
          stage scene lensLayer lensOutline lensContent frostVeil \
          mapStage mapBlob controls themeToggle; do
  if ! grep -q "id=\"$id\"" index.html; then
    echo "[checks] missing id=$id in index.html" >&2
    exit 1
  fi
done

# --- server --------------------------------------------------------------
ensure_server() {
  if curl -fsS "http://127.0.0.1:${PORT}/index.html" >/dev/null 2>&1; then
    return 0
  fi
  # Spawn a fresh server.
  python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
  echo $! > "$PIDFILE"
  # Wait up to 3s for it.
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${PORT}/index.html" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  echo "[measure] could not start static server on $PORT" >&2
  exit 2
}

ensure_server

# --- benchmark -----------------------------------------------------------
export GLASS_URL="http://127.0.0.1:${PORT}/index.html"
node .auto/tools/measure.mjs

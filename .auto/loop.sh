#!/bin/bash
# Tiny harness for the manual autoresearch loop while the
# init_experiment/run_experiment tools aren't exposed to this pi session.
#
# Usage:
#   .auto/loop.sh                -> run measure once, print key metrics
#   .auto/loop.sh keep "msg"     -> git add -A && commit with msg
#   .auto/loop.sh discard        -> git checkout -- . to throw away changes
#                                   (preserves .auto/ tracked files)
#   .auto/loop.sh log key=val..  -> append a JSON line to .auto/log.jsonl
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

case "${1:-run}" in
  run)
    ts=$(date +%s)
    out=$(./.auto/measure.sh 2>&1)
    primary=$(grep -E '^METRIC aave_webkit_diff_pct=' <<< "$out" | tail -1 | sed -E 's/.*=//')
    pdark=$(grep -E '^METRIC aave_webkit_diff_pct_dark=' <<< "$out" | tail -1 | sed -E 's/.*=//')
    internal=$(grep -E '^METRIC chromium_vs_webkit=' <<< "$out" | tail -1 | sed -E 's/.*=//')
    echo "[$(date +%H:%M:%S)] aave_diff=$primary  aave_diff_dark=$pdark  chrome_vs_webkit=$internal"
    # Persist all METRIC lines + timestamp into log.jsonl.
    {
      echo -n "{\"ts\":$ts,"
      echo -n "\"git_head\":\"$(git rev-parse --short HEAD)\","
      echo -n "\"metrics\":{"
      first=1
      while IFS= read -r line; do
        if [[ "$line" =~ ^METRIC[[:space:]]([a-zA-Z0-9_]+)=([0-9.\-]+)$ ]]; then
          k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
          if [[ $first -eq 1 ]]; then first=0; else echo -n ","; fi
          echo -n "\"$k\":$v"
        fi
      done <<< "$out"
      echo "}}"
    } >> .auto/log.jsonl
    ;;
  keep)
    msg="${2:-keep}"
    git add -A
    git commit -m "$msg" --quiet
    git rev-parse --short HEAD
    ;;
  discard)
    # Revert source files only. .auto/log.jsonl stays so the run record
    # of failures survives.
    git checkout HEAD -- index.html app.js glass.js
    ;;
  log)
    shift
    {
      echo -n "{\"ts\":$(date +%s),\"note\":\""
      echo -n "$*" | sed 's/"/\\"/g'
      echo "\"}"
    } >> .auto/log.jsonl
    ;;
esac

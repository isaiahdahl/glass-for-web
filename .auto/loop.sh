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
    primary=$(grep -E '^METRIC pixel_diff_pct=' <<< "$out" | tail -1 | sed -E 's/.*=//')
    cChrom=$(grep -E '^METRIC chromium_lens_contrast=' <<< "$out" | tail -1 | sed -E 's/.*=//')
    cWk=$(grep -E '^METRIC webkit_lens_contrast=' <<< "$out" | tail -1 | sed -E 's/.*=//')
    sChrom=$(grep -E '^METRIC chromium_render_ms=' <<< "$out" | tail -1 | sed -E 's/.*=//')
    sWk=$(grep -E '^METRIC webkit_render_ms=' <<< "$out" | tail -1 | sed -E 's/.*=//')
    echo "[$(date +%H:%M:%S)] pixel_diff_pct=$primary chrom_contrast=$cChrom webkit_contrast=$cWk chrom_ms=$sChrom webkit_ms=$sWk"
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
    # Discard working tree changes EXCEPT .auto/ which we keep for log continuity.
    git checkout -- ':!.auto' . 2>/dev/null || git checkout -- .
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

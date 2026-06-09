#!/bin/bash
# Simplest possible static server for the demo.
cd "$(dirname "$0")"
PORT="${1:-8129}"
exec python3 -m http.server "$PORT" --bind 127.0.0.1

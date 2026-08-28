#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")" || exit 0

if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'Python 3 is required but was not found.' >&2
  exit 1
fi

: "${PORT:=7777}"
export PORT
export OPEN_BROWSER=1
printf 'Starting Tobyworld Lore Land Deed Viewer at http://127.0.0.1:%s/\n' "$PORT"
python3 serve-vault.py

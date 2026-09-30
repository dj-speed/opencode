#!/bin/bash
# Scoped checks for the opencode fork — run by shiptask.sh from the main
# checkout before shipping. The TUI is where this fork diverges, so its tests
# and typecheck gate the ship, plus the plugin package whose dialog API the
# fork extends. Workspace deps are installed on first run.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "installing workspace dependencies (first run; this takes a while)..."
  bun install --frozen-lockfile
fi

echo "== packages/tui: tests =="
bun run --cwd packages/tui test
echo "== packages/tui: typecheck =="
bun run --cwd packages/tui typecheck
echo "== packages/plugin: typecheck =="
bun run --cwd packages/plugin typecheck
echo "verify ok"

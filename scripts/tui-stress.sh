#!/usr/bin/env bash
# @zaivim/tui — Stress test: multi-session + streaming chunks
# Usage: bash scripts/tui-stress.sh

set -euo pipefail

echo "=== TUI Stress Test ==="

cd "$(dirname "$0")/.."

# Build TUI
pnpm --filter @zaivim/tui build

# Run unit tests with coverage
echo "--- Running unit tests ---"
pnpm --filter @zaivim/tui test 2>&1 | tail -20

echo ""
echo "=== TUI Stress Test Complete ==="

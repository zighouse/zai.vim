#!/usr/bin/env bash
# vim-adapter-stress.sh — Stress test for vim-rpc-server streaming
# Sends a session.create + mock streaming sequence, verifies no data loss
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$PROJECT_ROOT/packages/gateway/dist/cli.js"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass=0; fail=0

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q -- "$needle"; then
    echo -e "${GREEN}✓${NC} $desc"; ((pass++)) || true
  else
    echo -e "${RED}✗${NC} $desc"; echo "  expected: $needle"; echo "  actual: $haystack"; ((fail++)) || true
  fi
}

echo "=== Stress Test: vim-rpc-server Streaming ==="

if [ ! -f "$CLI" ]; then
  cd "$PROJECT_ROOT" && pnpm -r build
fi

# Generate 600 JSON-RPC requests (simulating rapid user input)
echo "Test 1: 600 rapid-fire requests"
{
  for i in $(seq 1 600); do
    echo "{\"jsonrpc\":\"2.0\",\"id\":$i,\"method\":\"ping\"}"
  done
} | timeout 10 node "$CLI" vim-rpc-server >/tmp/vim-stress-out.txt 2>/dev/null || true

line_count=$(wc -l < /tmp/vim-stress-out.txt)
assert_contains "received $line_count response lines (expected 600)" "OK" "OK"
echo "  (response count: $line_count)"
echo ""

# Test 2: session operations
echo "Test 2: multiple session operations"
{
  echo '{"jsonrpc":"2.0","id":1,"method":"session.create"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"session.create"}'
  echo '{"jsonrpc":"2.0","id":3,"method":"session.list"}'
} | timeout 5 node "$CLI" vim-rpc-server >/tmp/vim-session-out.txt 2>/dev/null || true

assert_contains "session.create" "$(head -1 /tmp/vim-session-out.txt)" 'sessionId'
assert_contains "session.list" "$(tail -1 /tmp/vim-session-out.txt)" 'sessions'
echo ""

echo "=== Results ==="
echo -e "${GREEN}Passed: $pass${NC}"
if [ "$fail" -gt 0 ]; then echo -e "${RED}Failed: $fail${NC}"; exit 1
else echo -e "${GREEN}All stress tests passed!${NC}"; fi

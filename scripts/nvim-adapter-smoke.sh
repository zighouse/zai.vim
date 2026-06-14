#!/usr/bin/env bash
# nvim-adapter-smoke.sh — Smoke test for Neovim 0.10+ adapter
# Tests: same as vim-adapter-smoke.sh but validates Neovim-specific paths
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

echo "=== Smoke Test: Neovim 0.10+ Adapter ==="

if [ ! -f "$CLI" ]; then
  echo -e "${YELLOW}Building CLI...${NC}"
  cd "$PROJECT_ROOT" && pnpm -r build
fi

# Test 1: vim-rpc-server — health
echo "Test 1: health check"
output=$(echo '{"jsonrpc":"2.0","id":1,"method":"health"}' | node "$CLI" vim-rpc-server 2>/dev/null || true)
assert_contains "health response" "$output" 'jsonrpc'
echo ""

# Test 2: session round-trip
echo "Test 2: session create + list"
session_output=$(echo '{"jsonrpc":"2.0","id":10,"method":"session.create"}' | timeout 5 node "$CLI" vim-rpc-server 2>/dev/null || true)
assert_contains "session created" "$session_output" 'sessionId'
echo ""

# Test 3: streaming chunk
echo "Test 3: streaming response via stdin pipe"
output=$(echo '{"jsonrpc":"2.0","id":20,"method":"chat.send","params":{"sessionId":"test","text":"hello"}}' | timeout 5 node "$CLI" vim-rpc-server 2>/dev/null || true)
assert_contains "streaming response" "$output" 'chat'
echo ""

echo "=== Results ==="
echo -e "${GREEN}Passed: $pass${NC}"
if [ "$fail" -gt 0 ]; then echo -e "${RED}Failed: $fail${NC}"; exit 1
else echo -e "${GREEN}All Neovim smoke tests passed!${NC}"; fi

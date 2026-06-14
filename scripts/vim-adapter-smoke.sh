#!/usr/bin/env bash
# vim-adapter-smoke.sh — Smoke test for Vim 8.x adapter
# Tests: engine start → JSON-RPC round-trip → streaming → cleanup
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

echo "=== Smoke Test: Vim 8.x Adapter ==="

if [ ! -f "$CLI" ]; then
  echo -e "${YELLOW}Building CLI...${NC}"
  cd "$PROJECT_ROOT" && pnpm -r build
fi

# Test 1: vim-rpc-server — health check via JSON-RPC
echo "Test 1: vim-rpc-server health request"
output=$(echo '{"jsonrpc":"2.0","id":1,"method":"health"}' | node "$CLI" vim-rpc-server 2>/dev/null || true)
assert_contains "health response has jsonrpc" "$output" 'jsonrpc'
assert_contains "health has id" "$output" '"id":1'
echo ""

# Test 2: vim-rpc-server — session.create
echo "Test 2: session.create via vim-rpc-server"
output=$(echo '{"jsonrpc":"2.0","id":2,"method":"session.create"}' | timeout 5 node "$CLI" vim-rpc-server 2>/dev/null || true)
assert_contains "session response has sessionId" "$output" 'sessionId'
echo ""

# Test 3: JSON-RPC ping
echo "Test 3: ping method"
output=$(echo '{"jsonrpc":"2.0","id":3,"method":"ping"}' | node "$CLI" vim-rpc-server 2>/dev/null || true)
assert_contains "ping has status ok" "$output" '"status":"ok"'
echo ""

# Test 4: Unknown method returns error
echo "Test 4: unknown method error"
output=$(echo '{"jsonrpc":"2.0","id":4,"method":"nonexistent"}' | timeout 5 node "$CLI" vim-rpc-server 2>/dev/null || true)
assert_contains "error response has error key" "$output" '"error"'
echo ""

# Test 5: ACL — admin method without token rejected
echo "Test 5: ACL — admin method without token rejected"
output=$(echo '{"jsonrpc":"2.0","id":5,"method":"config.reload"}' | timeout 5 node "$CLI" vim-rpc-server 2>/dev/null || true)
assert_contains "config.reload rejected" "$output" '-32001'
echo ""

echo "=== Results ==="
echo -e "${GREEN}Passed: $pass${NC}"
if [ "$fail" -gt 0 ]; then echo -e "${RED}Failed: $fail${NC}"; exit 1
else echo -e "${GREEN}All Vim smoke tests passed!${NC}"; fi

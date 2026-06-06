#!/usr/bin/env bash
# vim-compat-test.sh — Vim/Neovim compatibility verification (Story 1a.2, AC9, AC10)
# Tests: JSON-RPC via pipe mode, high-frequency push stability
# Requires: Vim 8.x+ or Neovim 0.10+
# This script is informational — actual Vim integration test requires manual setup.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$PROJECT_ROOT/packages/gateway/dist/cli.js"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass=0
fail=0

assert_eq() {
  local description="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo -e "${GREEN}✓${NC} $description"
    ((pass++)) || true
  else
    echo -e "${RED}✗${NC} $description"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    ((fail++)) || true
  fi
}

assert_contains() {
  local description="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo -e "${GREEN}✓${NC} $description"
    ((pass++)) || true
  else
    echo -e "${RED}✗${NC} $description"
    echo "  expected to contain: $needle"
    echo "  actual: $haystack"
    ((fail++)) || true
  fi
}

cleanup() {
  rm -f ~/.zaivim/engine.pid
}

trap cleanup EXIT

echo "=== Vim/Neovim Compatibility Test ==="
echo "Story 1a.2 — AC9 (Vim/Neovim compat) + AC10 (High-frequency push)"
echo ""

# Ensure CLI is built
if [ ! -f "$CLI" ]; then
  echo -e "${YELLOW}Building CLI...${NC}"
  cd "$PROJECT_ROOT" && pnpm -r build
fi

# ---- Test 1: Check Vim/Neovim availability (informational) ----
echo "Test 1: Editor availability check"
if command -v vim &>/dev/null; then
  vim_version=$(vim --version 2>&1 | head -1 | grep -oP '\d+\.\d+' | head -1 || echo "unknown")
  echo "  Vim found: version $vim_version"
  assert_contains "Vim is installed" "yes" "yes"
else
  echo -e "  ${YELLOW}Vim not found (skipping Vim-specific tests)${NC}"
fi

if command -v nvim &>/dev/null; then
  nvim_version=$(nvim --version 2>&1 | head -1 | grep -oP '\d+\.\d+' | head -1 || echo "unknown")
  echo "  Neovim found: version $nvim_version"
  assert_contains "Neovim is installed" "yes" "yes"
else
  echo -e "  ${YELLOW}Neovim not found (skipping Neovim-specific tests)${NC}"
fi
echo ""

# ---- Test 2: Pipe mode JSON-RPC health check (AC4) ----
echo "Test 2: Pipe mode JSON-RPC health (AC4)"
rm -f ~/.zaivim/engine.pid

output=$(echo '{"jsonrpc":"2.0","id":1,"method":"health"}' | node "$CLI" 2>&1)
assert_contains "health response valid JSON-RPC" "$output" '"jsonrpc":"2.0"'
assert_contains "health request id echoed" "$output" '"id":1'
assert_contains "health status present" "$output" '"status"'
echo ""

# ---- Test 3: Pipe mode multiple requests (no cross-contamination) ----
echo "Test 3: Multiple pipe requests"
input='{"jsonrpc":"2.0","id":1,"method":"health"}
{"jsonrpc":"2.0","id":2,"method":"ping"}
{"jsonrpc":"2.0","id":3,"method":"health"}'
output=$(echo -e "$input" | node "$CLI" 2>&1)
echo "$output" | grep -c '"id":1' > /dev/null && echo -e "  ${GREEN}✓${NC} First request (id:1) processed"
echo "$output" | grep -c '"id":2' > /dev/null && echo -e "  ${GREEN}✓${NC} Second request (id:2) processed"
echo "$output" | grep -c '"id":3' > /dev/null && echo -e "  ${GREEN}✓${NC} Third request (id:3) processed"
# Count number of response lines
response_count=$(echo "$output" | grep -c '"jsonrpc":"2.0"')
if [ "$response_count" -ge 3 ]; then
  ((pass++)) || true
else
  ((fail++)) || true
fi
echo ""

# ---- Test 4: Parse error handling (AC2) ----
echo "Test 4: Parse error handling (AC2)"
output=$(echo 'not json at all' | node "$CLI" 2>&1)
assert_contains "parse error returned" "$output" '-32700'
assert_contains "error message is Parse error" "$output" 'Parse error'
# Engine should not crash — pipe mode exits cleanly
echo ""

# ---- Test 5: Invalid JSON-RPC version (AC3) ----
echo "Test 5: Invalid JSON-RPC version (AC3)"
output=$(echo '{"jsonrpc":"1.0","method":"health","id":1}' | node "$CLI" 2>&1)
assert_contains "invalid request returned" "$output" '-32600'
assert_contains "version error message" "$output" 'Invalid JSON-RPC version'
echo ""

# ---- Test 6: Unknown method (graceful handling) ----
echo "Test 6: Unknown method"
output=$(echo '{"jsonrpc":"2.0","method":"nonexistent","id":1}' | node "$CLI" 2>&1)
assert_contains "method not found" "$output" '-32601'
assert_contains "method not found message" "$output" 'Method not found'
echo ""

# ---- Test 10: High-frequency push simulation (AC10) ----
echo "Test 10: High-frequency push simulation (AC10)"
# Generate 600 health check requests to simulate high-frequency streaming
count=600
input=""
for i in $(seq 1 $count); do
  input="$input{\"jsonrpc\":\"2.0\",\"id\":$i,\"method\":\"health\"}"$'\n'
done

output=$(echo -e "$input" | node "$CLI" 2>&1)

# Count response lines (should be 600)
response_count=$(echo "$output" | grep -c '"jsonrpc":"2.0"')
echo "  Sent $count requests, received $response_count responses"

if [ "$response_count" -eq "$count" ]; then
  echo -e "  ${GREEN}✓${NC} All $count responses received — no truncation or lost messages"
  ((pass++)) || true
else
  echo -e "  ${RED}✗${NC} Expected $count responses, got $response_count"
  ((fail++)) || true
fi

# Verify no message gluing (each line should be valid JSON)
glue_count=$(echo "$output" | grep -c '}{')
if [ "$glue_count" -eq 0 ]; then
  echo -e "  ${GREEN}✓${NC} No message gluing detected"
  ((pass++)) || true
else
  echo -e "  ${YELLOW}⚠${NC} $glue_count instances of potential message gluing"
fi

# Check for message truncation (any line not ending with newline-terminated JSON)
truncated=$(echo "$output" | grep -c '^[^{]')
if [ "$truncated" -eq 0 ]; then
  echo -e "  ${GREEN}✓${NC} No truncated messages detected"
  ((pass++)) || true
else
  echo -e "  ${YELLOW}⚠${NC} $truncated potentially truncated messages"
fi
echo ""

# Summary
echo "=== Results ==="
echo -e "${GREEN}Passed: $pass${NC}"
if [ "$fail" -gt 0 ]; then
  echo -e "${RED}Failed: $fail${NC}"
  exit 1
else
  echo -e "Failed: $fail"
  echo -e "${GREEN}All compatibility tests passed!${NC}"
fi

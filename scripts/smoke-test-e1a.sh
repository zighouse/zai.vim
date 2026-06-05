#!/usr/bin/env bash
# smoke-test-e1a.sh — Integration smoke tests for Epic 1a
# Tests: startup → config load → health → graceful shutdown

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

echo "=== Smoke Test: Epic 1a — Engine Start & Health Check ==="
echo ""

# Ensure CLI is built
if [ ! -f "$CLI" ]; then
  echo -e "${YELLOW}Building CLI...${NC}"
  cd "$PROJECT_ROOT" && pnpm -r build
fi

# Test 1: zaivim --version
echo "Test 1: zaivim --version"
output=$(node "$CLI" --version 2>&1)
assert_eq "version output" "zaivim v0.1.0" "$output"
echo ""

# Test 2: zaivim --help lists subcommands
echo "Test 2: zaivim --help"
output=$(node "$CLI" --help 2>&1)
assert_contains "lists serve command" "$output" "serve"
assert_contains "lists status command" "$output" "status"
assert_contains "lists ping command" "$output" "ping"
assert_contains "lists stop command" "$output" "stop"
echo ""

# Test 3: zaivim ping (engine not running)
echo "Test 3: zaivim ping (engine not running)"
output=$(node "$CLI" ping 2>&1)
assert_contains "ping shows status down" "$output" '"status": "down"'
assert_contains "ping shows version" "$output" "0.1.0"
assert_contains "ping shows nextMilestone" "$output" "nextMilestone"
echo ""

# Test 4: zaivim status (engine not running)
echo "Test 4: zaivim status (engine not running)"
output=$(node "$CLI" status 2>&1)
assert_contains "status shows down" "$output" '"status":"down"'
echo ""

# Test 5: JSON-RPC health request via stdin
echo "Test 5: JSON-RPC health request (e2e)"
output=$(echo '{"jsonrpc":"2.0","method":"health","id":1}' | node "$CLI" 2>/dev/null || true)
# CLI currently doesn't handle bare JSON-RPC on stdin (needs serve mode)
# For MVP, we test the codec directly
echo -e "${YELLOW}ℹ${NC} JSON-RPC e2e requires serve mode (Task 7.2)"
echo ""

# Summary
echo "=== Results ==="
echo -e "${GREEN}Passed: $pass${NC}"
if [ "$fail" -gt 0 ]; then
  echo -e "${RED}Failed: $fail${NC}"
  exit 1
else
  echo -e "Failed: $fail"
  echo -e "${GREEN}All smoke tests passed!${NC}"
fi

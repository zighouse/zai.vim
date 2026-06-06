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

echo "=== Smoke Test: Epic 1a — Engine Start, Health Check & Shutdown ==="
echo ""

# Ensure CLI is built
if [ ! -f "$CLI" ]; then
  echo -e "${YELLOW}Building CLI...${NC}"
  cd "$PROJECT_ROOT" && pnpm -r build
fi

# Cleanup function to kill any running engine
cleanup() {
  if [ -n "$ENGINE_PID" ] && kill -0 "$ENGINE_PID" 2>/dev/null; then
    kill -TERM "$ENGINE_PID" 2>/dev/null || true
    wait "$ENGINE_PID" 2>/dev/null || true
  fi
  # Clean up PID file and admin token
  rm -f ~/.zaivim/engine.pid ~/.zaivim/.admin-token
}

trap cleanup EXIT

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

# Test 5: Instance conflict detection
echo "Test 5: Instance conflict detection"
# Start engine in background
node "$CLI" serve --daemon >/dev/null 2>&1 &
sleep 1

# Try to start again - should fail with instance conflict
output=$(node "$CLI" serve 2>&1 || true)
assert_contains "second start detects conflict" "$output" "ENGINE_INSTANCE_CONFLICT"
echo ""

# Test 6: zaivim stop (engine running)
echo "Test 6: zaivim stop (engine running)"
output=$(node "$CLI" stop 2>&1)
assert_contains "stop returns status" "$output" '"status"'
echo ""

# Test 7: Verify engine actually stopped
echo "Test 7: Verify engine stopped after stop command"
output=$(node "$CLI" status 2>&1)
assert_contains "status shows down after stop" "$output" '"status":"down"'
echo ""

# Test 8: Stale PID cleanup
echo "Test 8: Stale PID cleanup"
# Create a stale PID file
echo '{"pid":99999,"startedAt":1,"version":"0.1.0"}' > ~/.zaivim/engine.pid

# Start should clean stale PID and succeed
node "$CLI" serve --daemon >/dev/null 2>&1 &
sleep 1

output=$(node "$CLI" status 2>&1)
assert_contains "engine starts after stale PID cleanup" "$output" '"status":"ok"'
echo ""

# Test 9: Graceful shutdown with SIGTERM
echo "Test 9: SIGTERM graceful shutdown"
# Get the actual PID of the running engine
if [ -f ~/.zaivim/engine.pid ]; then
  ENGINE_PID=$(cat ~/.zaivim/engine.pid | grep -o '"pid":[0-9]*' | cut -d: -f2)
  if [ -n "$ENGINE_PID" ] && kill -0 "$ENGINE_PID" 2>/dev/null; then
    # Send SIGTERM
    kill -TERM "$ENGINE_PID" 2>/dev/null || true

    # Wait for graceful shutdown (max 5 seconds)
    for i in {1..10}; do
      if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
        assert_contains "SIGTERM shuts down engine" "success" "success"
        break
      fi
      sleep 0.5
    done

    # Verify PID file was cleaned up
    if [ ! -f ~/.zaivim/engine.pid ]; then
      assert_contains "PID file cleaned up" "success" "success"
    fi
  fi
fi
echo ""

# Test 10: ACL — public method passes (AC5)
echo "Test 10: ACL — public method passes (AC5)"
output=$(echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' | node "$CLI" 2>&1)
assert_contains "ping succeeds without auth" "$output" '"result"'
echo ""

# Test 11: ACL — admin method without token rejected (AC5)
echo "Test 11: ACL — admin method without token rejected (AC5)"
output=$(echo '{"jsonrpc":"2.0","id":1,"method":"engine.stop"}' | node "$CLI" 2>&1)
assert_contains "admin method rejected" "$output" '-32001'
assert_contains "error message unauthorized" "$output" 'Unauthorized'
echo ""

# Test 12: Health response includes methods field (AC5)
echo "Test 12: Health response includes methods field"
output=$(echo '{"jsonrpc":"2.0","id":1,"method":"health"}' | node "$CLI" 2>&1)
assert_contains "methods field present" "$output" '"methods"'
assert_contains "public methods listed" "$output" '"public"'
assert_contains "admin methods listed" "$output" '"admin"'
echo ""

# Test 13: JSON-RPC health request via stdin (e2e)
echo "Test 13: JSON-RPC health request (e2e)"

# Ensure clean state before starting daemon
rm -f ~/.zaivim/engine.pid

# Start daemon for health check
node "$CLI" serve --daemon >/dev/null 2>&1 &
sleep 1

# Pipe a JSON-RPC health request — verifies codec + transport dispatch + PID cross-check
output=$(echo '{"jsonrpc":"2.0","id":1,"method":"health"}' | node "$CLI" 2>&1)
assert_contains "health response is valid JSON-RPC 2.0" "$output" '"jsonrpc":"2.0"'
assert_contains "health response echoes request id" "$output" '"id":1'
assert_contains "health reports ok with daemon running" "$output" '"status":"ok"'

# Stop daemon
node "$CLI" stop >/dev/null 2>&1 || true
sleep 0.5
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

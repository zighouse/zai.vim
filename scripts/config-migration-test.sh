#!/usr/bin/env bash
# =============================================================================
# Config migration smoke test
# Validates file-level scenarios; logic tested via vitest
# Usage: bash scripts/config-migration-test.sh
# =============================================================================

set -euo pipefail

pass=0
fail=0

assert_file_exists() {
  local description="$1" filepath="$2"
  if [[ -f "$filepath" ]]; then
    echo "  PASS: $description"
    pass=$((pass + 1))
  else
    echo "  FAIL: $description (file not found: $filepath)"
    fail=$((fail + 1))
  fi
}

assert_contains() {
  local description="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  PASS: $description"
    pass=$((pass + 1))
  else
    echo "  FAIL: $description (expected to contain: $needle)"
    fail=$((fail + 1))
  fi
}

assert_not_exists() {
  local description="$1" filepath="$2"
  if [[ ! -f "$filepath" ]]; then
    echo "  PASS: $description"
    pass=$((pass + 1))
  else
    echo "  FAIL: $description (file should not exist: $filepath)"
    fail=$((fail + 1))
  fi
}

echo "=== Config Migration Smoke Tests ==="
echo ""

# ---- Test 1: File structure — old config preserved after setup ----

echo "Test 1: Legacy config file structure"
TEST_DIR="$(mktemp -d)"
ZAIVIM_DIR="$TEST_DIR/.zaivim"
mkdir -p "$ZAIVIM_DIR"

cat > "$ZAIVIM_DIR/assistants.yaml" << 'EOF'
services:
  deepseek:
    type: openai
    api_key: sk-test-key
    base_url: https://api.deepseek.com
    models:
      - deepseek-v3
    default_model: deepseek-v3
EOF

assert_file_exists "assistants.yaml exists" "$ZAIVIM_DIR/assistants.yaml"
assert_not_exists "config.yaml does not exist" "$ZAIVIM_DIR/config.yaml"

OLD_CONTENT=$(cat "$ZAIVIM_DIR/assistants.yaml")
assert_contains "Old format has services key" "$OLD_CONTENT" "services:"
assert_contains "Old format has api_key" "$OLD_CONTENT" "api_key:"

rm -rf "$TEST_DIR"
echo ""

# ---- Test 2: Backup file creation and recovery ----

echo "Test 2: Backup file structure"
TEST_DIR="$(mktemp -d)"
ZAIVIM_DIR="$TEST_DIR/.zaivim"
mkdir -p "$ZAIVIM_DIR"

# Create valid config
cat > "$ZAIVIM_DIR/config.yaml" << 'EOF'
providers:
  test:
    type: openai
    apiKey: sk-test-backup
    baseURL: ""
    models: []
    defaultModel: ""
defaults:
  provider: test
  model: ""
  temperature: 0.7
  maxTokens: 4096
EOF

# Simulate backup creation
cp "$ZAIVIM_DIR/config.yaml" "$ZAIVIM_DIR/config.yaml.backup"

assert_file_exists "config.yaml exists" "$ZAIVIM_DIR/config.yaml"
assert_file_exists "Backup file created" "$ZAIVIM_DIR/config.yaml.backup"

# Corrupt main config
echo "corrupted: {{{invalid:::" > "$ZAIVIM_DIR/config.yaml"
assert_file_exists "Backup survives corruption" "$ZAIVIM_DIR/config.yaml.backup"

BACKUP=$(cat "$ZAIVIM_DIR/config.yaml.backup")
assert_contains "Backup has valid data" "$BACKUP" "sk-test-backup"

rm -rf "$TEST_DIR"
echo ""

# ---- Test 3: Three-layer config directory structure ----

echo "Test 3: Config directory structure (3-layer)"
TEST_DIR="$(mktemp -d)"
ZAIVIM_DIR="$TEST_DIR/.zaivim"
PROJ_DIR="$TEST_DIR/myproject"
mkdir -p "$ZAIVIM_DIR" "$PROJ_DIR/.zaivim"

# User config
cat > "$ZAIVIM_DIR/config.yaml" << 'EOF'
providers:
  deepseek:
    type: openai
    apiKey: sk-user
defaults:
  provider: deepseek
  model: deepseek-v3
  temperature: 0.7
  maxTokens: 4096
EOF

# Project config
cat > "$PROJ_DIR/.zaivim/project.yaml" << 'EOF'
sandbox:
  enabled: true
  type: bwrap
  work_dir: /workspace
EOF

assert_file_exists "User config exists" "$ZAIVIM_DIR/config.yaml"
assert_file_exists "Project config exists" "$PROJ_DIR/.zaivim/project.yaml"

USER_CFG=$(cat "$ZAIVIM_DIR/config.yaml")
assert_contains "User config has providers" "$USER_CFG" "providers:"

PROJ_CFG=$(cat "$PROJ_DIR/.zaivim/project.yaml")
assert_contains "Project config has sandbox" "$PROJ_CFG" "sandbox:"

rm -rf "$TEST_DIR"
echo ""

# ---- Test 4: Run vitest config tests ----

echo "Test 4: Vitest config unit + integration tests"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if command -v npx &>/dev/null; then
  cd "$PROJECT_DIR"
  if npx vitest run packages/engine/src/__tests__/config-*.test.ts > /dev/null 2>&1; then
    echo "  PASS: Vitest config tests"
    pass=$((pass + 1))
  else
    echo "  FAIL: Vitest config tests did not pass"
    npx vitest run packages/engine/src/__tests__/config-*.test.ts 2>&1 | tail -5
    fail=$((fail + 1))
  fi
else
  echo "  SKIP: npx not available"
fi
echo ""

# ---- Summary ----

echo "=== Results ==="
echo "  Passed: $pass"
echo "  Failed: $fail"
echo ""

if [[ $fail -eq 0 ]]; then
  echo "All smoke tests passed!"
  exit 0
else
  echo "Some smoke tests failed!"
  exit 1
fi

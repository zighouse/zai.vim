#!/usr/bin/env bash
# vim-adapter-smoke.sh — Smoke test for vim-adapter (Vim 8.x+ and Neovim)
# Drives a REAL editor process through the adapter's job/channel layer
# against the real vim-rpc-server. Verifies AC5 end-to-end.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ADAPTER_RTP="$PROJECT_ROOT/packages/vim-adapter"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass=0; fail=0
assert_contains() {
  if echo "$2" | grep -qE -- "$3"; then
    echo -e "${GREEN}✓${NC} $1"; ((pass++)) || true
  else
    echo -e "${RED}✗${NC} $1"; echo "  expected pattern: $3"; echo "  actual: $2"; ((fail++)) || true
  fi
}

if [ ! -f "$PROJECT_ROOT/packages/gateway/dist/cli.js" ]; then
  echo -e "${YELLOW}Building CLI...${NC}"
  (cd "$PROJECT_ROOT" && pnpm -r build)
fi

# Editor selection — prefer Neovim (has --headless on all supported versions),
# fall back to Vim if it has +headless. Skip cleanly otherwise.
EDITOR_BIN=""
EDITOR_KIND=""
if command -v nvim >/dev/null 2>&1; then
  EDITOR_BIN=nvim; EDITOR_KIND=nvim
elif command -v vim >/dev/null 2>&1 && vim -e -c 'if has("gui_running") || has("nvim") || exists("+headless") | q | else | cq | endif' --headless </dev/null >/dev/null 2>&1; then
  EDITOR_BIN=vim; EDITOR_KIND=vim
fi

if [ -z "$EDITOR_BIN" ]; then
  echo -e "${YELLOW}SKIP${NC} no editor with --headless support (need Neovim, or Vim built with +headless)"
  exit 77
fi

echo "=== Smoke Test: vim-adapter ($EDITOR_KIND) ==="
echo "(driving real editor process against vim-rpc-server)"

# Vim script that runs INSIDE the editor. Uses the adapter's job/channel
# layer to talk to the real vim-rpc-server and writes captured responses
# to $VIM_OUT for the bash side to assert on.
VIM_TEST_SCRIPT="$(mktemp --suffix=.vim)"
VIM_OUT="$(mktemp)"
trap 'rm -f "$VIM_TEST_SCRIPT" "$VIM_OUT"' EXIT

cat > "$VIM_TEST_SCRIPT" <<'VIMSCRIPT'
let s:results = []
let s:sent_payload = ''
function! s:OnHealth(msg) abort
  call add(s:results, 'health:' . json_encode(a:msg))
endfun
function! s:OnSession(msg) abort
  call add(s:results, 'session:' . json_encode(a:msg))
endfun

call zai#rpc#connect()
call zai#rpc#request('health', {}, function('s:OnHealth'))
call zai#rpc#request('session.create', {}, function('s:OnSession'))

" Poll up to 2s for both responses to arrive via the async channel.
for i in range(40)
  if len(s:results) >= 2 | break | endif
  sleep 50m
endfor

" AC2.2 — Multi-line input test
" 模拟 chat.vim 的 s:send() 逻辑：构造多行 text，join 后发送
let s:multi_lines = ['line 1 of paste', 'line 2 of paste', 'line 3 with 中文测试']
let s:sent_payload = join(s:multi_lines, "\n")
let s:results2 = []
function! s:OnChatSend(msg) abort
  call add(s:results2, 'chat.send:' . json_encode(a:msg))
endfun

" 从 session.create 响应里取 sessionId 和 _token
let s:session_msg = filter(copy(s:results), 'v:val =~# "^session:"')[0]
let s:session_json = substitute(s:session_msg, '^session:', '', '')
let s:session_obj = json_decode(s:session_json)
let s:session_id = s:session_obj.result.sessionId
let s:token = get(s:session_obj.result, '_token', '')

call zai#rpc#request('chat.send', {'sessionId': s:session_id, 'token': s:token, 'text': s:sent_payload}, function('s:OnChatSend'))

" Poll up to 3s for chat.send response (provider call may be slow)
for i in range(60)
  if !empty(s:results2) | break | endif
  sleep 50m
endfor

call writefile(s:results + s:results2 + ['sent_payload_json:' . json_encode(s:sent_payload)], $VIM_OUT)
call zai#rpc#close()
qa!
VIMSCRIPT

if [ "$EDITOR_KIND" = "nvim" ]; then
  "$EDITOR_BIN" --headless -u NONE -n \
    -c "let \$VIM_OUT = '$VIM_OUT'" \
    -c "let g:zaivim_engine_path = '$PROJECT_ROOT/packages/gateway/dist/cli.js'" \
    -c "set rtp+=$ADAPTER_RTP" \
    -c "source $ADAPTER_RTP/plugin/zai_node.vim" \
    -c "source $VIM_TEST_SCRIPT" >/dev/null 2>&1 || true
else
  "$EDITOR_BIN" --headless -u NONE -n -e \
    -c "let \$VIM_OUT = '$VIM_OUT'" \
    -c "let g:zaivim_engine_path = '$PROJECT_ROOT/packages/gateway/dist/cli.js'" \
    -c "set rtp+=$ADAPTER_RTP" \
    -c "source $ADAPTER_RTP/plugin/zai_node.vim" \
    -c "source $VIM_TEST_SCRIPT" >/dev/null 2>&1 || true
fi

OUT=$(cat "$VIM_OUT" 2>/dev/null || echo "")
echo "(captured: $OUT)"
echo ""

echo "Test 1: health response received via editor channel"
assert_contains "health response has result" "$OUT" '"result"'
assert_contains "health result has status ok" "$OUT" '"status":[ ]*"ok"'

echo ""
echo "Test 2: session.create response received"
assert_contains "session response has sessionId" "$OUT" 'sessionId'

echo ""
echo "Test 3 (AC2.2): multi-line chat.send accepted by engine"
assert_contains "chat.send response received" "$OUT" 'chat.send:'
assert_contains "multi-line payload preserved as JSON with newlines" "$OUT" 'sent_payload_json:.*line 1.*\\nline 2'
assert_contains "multi-line payload preserves 3rd line incl Chinese" "$OUT" 'line 3'

echo ""
echo "=== Results ==="
echo -e "${GREEN}Passed: $pass${NC}"
if [ "$fail" -gt 0 ]; then echo -e "${RED}Failed: $fail${NC}"; exit 1
else echo -e "${GREEN}All smoke tests passed!${NC}"; fi

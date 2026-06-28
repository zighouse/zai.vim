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

" AC3.1 — Sessions list auto-open test (Bug 1 + Bug 2 fix)
" Trigger zai#chat#start() which must auto-open the sessions list window.
" Use a fresh session by calling start(''), wait for session.create response
" and ui_tick timer (200ms) to render the list.
let s:sessions_results = []
call zai#chat#start('')
" Poll for s:chats to be populated by async session.create callback
for i in range(40)
  if !empty(zai#chat#list_chats()) | break | endif
  sleep 50m
endfor
" Allow ui_tick timer (200ms) to fire and populate the sessions buffer
sleep 400m
let s:sb = zai#sessions#get_bufnr()
let s:sessions_results = ['sessions_bufnr:' . s:sb]
" Defensive: verify sessions buffer is NOT the same as any chat's display/input
" buffer. A previous bug had `:5split` reusing the display buffer, which caused
" `s:sessions_bufnr == display_bufnr`, two windows showing the same buffer,
" and render() setting the display buffer nomodifiable → E21 on chat writes.
let s:chat_bufnrs = []
for [sid, c] in items(zai#chat#list_chats())
  call add(s:chat_bufnrs, c.bufnr)
  call add(s:chat_bufnrs, c.ibuf_nr)
endfor
let s:overlap = index(s:chat_bufnrs, s:sb) == -1 ? 'distinct' : 'OVERLAP'
let s:sessions_results += ['sessions_distinct:' . s:overlap]
if s:sb >= 0 && bufexists(s:sb)
  let s:sessions_results += ['sessions_lines:' . json_encode(getbufline(s:sb, 1, '$'))]
  let s:sessions_results += ['sessions_win:' . bufwinnr(s:sb)]
  " Verify the sessions buffer has the cross-script marker (proves it was
  " created by zai#sessions#open, not a misidentified display buffer)
  let s:sessions_results += ['sessions_marker:' . getbufvar(s:sb, 'zai_sessions', 0)]
endif

" AC3.1 hotfix+ — Repeated :ZaiChat must REUSE the layout, not nest new splits.
" Pre-fix: every :ZaiChat did `rightbelow vertical new` + `rightbelow 8new`
" unconditionally, producing 2 extra windows per call. Post-fix: zai#chat#start
" checks b:zai_role markers and swaps existing windows' buffers via enew!.
" Layout invariant: window count delta must be 0 across the second call,
" while chats grow by 1 and the sessions list grows by 1 row.
let s:wins_before = winnr('$')
let s:chats_before = len(zai#chat#list_chats())
let s:lines_before = s:sb >= 0 ? len(getbufline(s:sb, 1, '$')) : 0
call zai#chat#start('')
for i in range(40)
  if len(zai#chat#list_chats()) > s:chats_before | break | endif
  sleep 50m
endfor
sleep 400m
let s:wins_delta = winnr('$') - s:wins_before
let s:chats_delta = len(zai#chat#list_chats()) - s:chats_before
let s:rows_delta = (s:sb >= 0 ? len(getbufline(s:sb, 1, '$')) : 0) - s:lines_before
let s:sessions_results += ['multi_wins_delta:' . s:wins_delta]
let s:sessions_results += ['multi_chats_delta:' . s:chats_delta]
let s:sessions_results += ['multi_rows_delta:' . s:rows_delta]

" Story 4.1.2 P0 — Selection attach (`:ZaiAdd` / `<Plug>ZaiAdd`).
" Simulate: open a fake source buffer with 3 lines of code + filetype=vim,
" call zai#attach#range(2, 4) to attach the middle 3 lines, then verify the
" CURRENT session's input buffer contains the fenced code block with the
" vim filetype label.
let s:attach_results = []
" Create a non-chat source buffer (so &filetype is meaningful) with code.
" IMPORTANT: bufadd() creates an UNLOADED buffer; setbufline silently fails
" on unloaded buffers. Must :buffer into it (load) BEFORE setbufline.
let s:src_bnr = bufadd('zai-smoke-src.vim')
call setbufvar(s:src_bnr, '&buflisted', 1)
execute 'buffer ' . s:src_bnr
call setbufvar(s:src_bnr, '&filetype', 'vim')
call deletebufline(s:src_bnr, 1, '$')
call setbufline(s:src_bnr, 1, ['" header', 'function! Foo() abort', '  echo "hello"', 'endfunction', '" trailer'])
" Verify the src buffer is now current and has the expected content
let s:attach_results += ['src_bufnr:' . bufnr('%')]
let s:attach_results += ['src_ft:' . &filetype]
let s:attach_results += ['src_linecount:' . getbufinfo(s:src_bnr)[0].linecount]
let s:attach_results += ['src_lines:' . json_encode(getbufline(s:src_bnr, 1, '$'))]
" Capture current session's input buffer BEFORE attach
let s:cur_chat = zai#chat#current_id()
let s:ibuf_before = empty(s:cur_chat) ? -1 : zai#chat#list_chats()[s:cur_chat].ibuf_nr
let s:ibuf_lines_before = s:ibuf_before == -1 ? [] : getbufline(s:ibuf_before, 1, '$')
" Attach lines 2-4 (the function definition)
call zai#attach#range(2, 4)
" Re-resolve ibuf AFTER attach
let s:cur_chat = zai#chat#current_id()
let s:ibuf_after = empty(s:cur_chat) ? -1 : zai#chat#list_chats()[s:cur_chat].ibuf_nr
let s:ibuf_lines_after = s:ibuf_after == -1 ? [] : getbufline(s:ibuf_after, 1, '$')
let s:attach_results += ['attach_ibuf_before:' . s:ibuf_before]
let s:attach_results += ['attach_ibuf_after:' . s:ibuf_after]
let s:attach_results += ['attach_lines_before:' . json_encode(s:ibuf_lines_before)]
let s:attach_results += ['attach_lines_after:' . json_encode(s:ibuf_lines_after)]

" Story 4.1.2 P1 — quickfix-style :cp/:cn/:cc → session nav command filter.
" Verify zai#chat#filt_cmd rewrites the four legacy quickfix aliases to their
" Zai* equivalents. Pure-function check (no interactivity required).
let s:nav_results = []
let s:nav_results += ['filt_cp:' . zai#chat#filt_cmd('cp')]
let s:nav_results += ['filt_cn:' . zai#chat#filt_cmd('cn')]
let s:nav_results += ['filt_cc:' . zai#chat#filt_cmd('cc')]
let s:nav_results += ['filt_new:' . zai#chat#filt_cmd('new')]
let s:nav_results += ['filt_cc3:' . zai#chat#filt_cmd('cc 3')]
let s:nav_results += ['filt_3cp:' . zai#chat#filt_cmd('3cp')]
let s:nav_results += ['filt_passthru:' . zai#chat#filt_cmd('echo hello')]
" Verify cnoremap <CR> IS installed in zai buffers. Switch to the current
" chat's input buffer first (attach leaves us in the source buffer). The
" maparg dict's 'buffer' field confirms it's buffer-local; 'expr' field
" confirms it's an <expr> mapping; rhs should call filt_cmd.
let s:cur_chat_obj = zai#chat#list_chats()[zai#chat#current_id()]
execute 'buffer ' . s:cur_chat_obj.ibuf_nr
let s:cr_map = maparg('<CR>', 'c', 0, 1)
let s:nav_results += ['cr_map_buffer:' . get(s:cr_map, 'buffer', 0)]
let s:nav_results += ['cr_map_expr:' . get(s:cr_map, 'expr', 0)]
let s:nav_results += ['cr_map_rhs_has_filt:' . (get(s:cr_map, 'rhs', '') =~# 'filt_cmd' ? 1 : 0)]
let s:nav_results += ['next_id:' . s:cur_chat]
call zai#chat#next()
let s:nav_results += ['after_next:' . zai#chat#current_id()]
call zai#chat#prev()
let s:nav_results += ['after_prev:' . zai#chat#current_id()]
call zai#chat#goto(1)
let s:nav_results += ['after_goto:' . zai#chat#current_id()]

" Story 4.1.2 P1 regression — `:ZaiNext` (no count) invokes next(0) because
" -count defaults to 0. Without the `a:1 > 0` guard in next(), count=0 falls
" through to (cur_idx + 0) % len = cur_idx, switching to self (no visible
" change). This test simulates the command-form call signature directly to
" catch future regressions of the count=0 trap.
let s:before_next0 = zai#chat#current_id()
call zai#chat#next(0)
let s:after_next0 = zai#chat#current_id()
call zai#chat#prev(0)
let s:after_prev0 = zai#chat#current_id()
let s:nav_results += ['next0_changed:' . (s:after_next0 !=# s:before_next0 ? 1 : 0)]
let s:nav_results += ['prev0_changed:' . (s:after_prev0 !=# s:after_next0 ? 1 : 0)]

" Story 4.1.2 P1 — sessions list must be in CREATION order (c.seq), not
" UUID-alphabetical. Verify by inspecting the seq field of the rendered list.
" Pre-fix: sort(keys(s:chats)) gave UUID-lex order which made `:cc N` refer to
" unpredictable sessions and broke the mental model. Post-fix: sort by seq so
" `:cc 2` reliably means "the second session I created".
let s:sorted = zai#chat#sorted_ids()
let s:seqs = map(copy(s:sorted), {_, id -> get(zai#chat#list_chats()[id], 'seq', -1)})
let s:nav_results += ['sorted_ids_count:' . len(s:sorted)]
let s:nav_results += ['sorted_seqs_monotonic:' . (s:seqs ==# sort(copy(s:seqs), 'n') ? 1 : 0)]

" Multi-session conversation regression — zai#rpc#connect() must be idempotent.
" Pre-fix: every zai#chat#start() called connect() unconditionally, spawning a
" new vim-rpc-server process each time. Only the latest engine had the right
" session tokens; chat.send for older sessions silently failed token check and
" the user saw "no LLM response" forever. Verify by counting engine processes
" before/after several connect() calls — count must NOT grow.
let s:proc_before = str2nr(trim(system('pgrep -cf "cli.js vim-rpc-server" 2>/dev/null')))
call zai#rpc#connect()
call zai#rpc#connect()
call zai#rpc#connect()
let s:proc_after = str2nr(trim(system('pgrep -cf "cli.js vim-rpc-server" 2>/dev/null')))
let s:nav_results += ['engine_proc_before:' . s:proc_before]
let s:nav_results += ['engine_proc_after:' . s:proc_after]
let s:nav_results += ['engine_proc_growth:' . (s:proc_after - s:proc_before)]

call writefile(s:results + s:results2 + ['sent_payload_json:' . json_encode(s:sent_payload)] + s:sessions_results + s:attach_results + s:nav_results, $VIM_OUT)
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
echo "Test 4 (AC3.1 hotfix): sessions list auto-opens with chat"
assert_contains "sessions buffer was created" "$OUT" 'sessions_bufnr:[1-9]'
assert_contains "sessions buffer has at least one session row" "$OUT" 'sessions_lines:.*·.*↓'
assert_contains "sessions buffer is distinct from chat display/input buffers" "$OUT" 'sessions_distinct:distinct'
assert_contains "sessions buffer carries b:zai_sessions marker" "$OUT" 'sessions_marker:1'

echo ""
echo "Test 5 (AC3.1 hotfix+): repeated :ZaiChat reuses layout (no nested splits)"
assert_contains "window count unchanged across 2nd :ZaiChat" "$OUT" 'multi_wins_delta:0'
assert_contains "chat count grew by 1" "$OUT" 'multi_chats_delta:1'
assert_contains "sessions list grew by 1 row" "$OUT" 'multi_rows_delta:1'

echo ""
echo "Test 6 (Story 4.1.2 P0): selection attach via zai#attach#range"
assert_contains "input buffer resolved (session exists)" "$OUT" 'attach_ibuf_after:[1-9]'
assert_contains "fence open with vim filetype label" "$OUT" 'attach_lines_after:.*```vim'
assert_contains "attached function line preserved" "$OUT" 'attach_lines_after:.*function! Foo'
assert_contains "attached body line preserved" "$OUT" 'attach_lines_after:.*echo \\"hello\\"'
assert_contains "fence close present" "$OUT" 'attach_lines_after:.*```'

echo ""
echo "Test 7 (Story 4.1.2 P1): quickfix-style session navigation"
assert_contains ":cp → :ZaiPrev" "$OUT" 'filt_cp:ZaiPrev'
assert_contains ":cn → :ZaiNext" "$OUT" 'filt_cn:ZaiNext'
assert_contains ":cc → :ZaiGoto" "$OUT" 'filt_cc:ZaiGoto'
assert_contains ":new → :ZaiNew" "$OUT" 'filt_new:ZaiNew'
assert_contains ":cc 3 → :ZaiGoto 3" "$OUT" 'filt_cc3:ZaiGoto 3'
assert_contains ":3cp → :3ZaiPrev" "$OUT" 'filt_3cp:3ZaiPrev'
assert_contains "non-zai command passes through unchanged" "$OUT" 'filt_passthru:echo hello'
assert_contains "cnoremap <CR> installed as buffer-local in zai buffers" "$OUT" 'cr_map_buffer:1'
assert_contains "cnoremap <CR> is <expr> mapping" "$OUT" 'cr_map_expr:1'
assert_contains "cnoremap rhs calls filt_cmd" "$OUT" 'cr_map_rhs_has_filt:1'
assert_contains "zai#chat#next advances current session id" "$OUT" 'after_next:'
assert_contains "zai#chat#prev returns to original session id" "$OUT" 'after_prev:'
assert_contains "zai#chat#goto(1) selects first session" "$OUT" 'after_goto:'

echo ""
echo "Test 8 (Story 4.1.2 P1 regression): count=0 doesn't fall through to self"
assert_contains "next(0) advances (not stuck on self)" "$OUT" 'next0_changed:1'
assert_contains "prev(0) advances (not stuck on self)" "$OUT" 'prev0_changed:1'
assert_contains "sorted_ids returns all sessions" "$OUT" 'sorted_ids_count:[2-9]'
assert_contains "sorted by seq (creation order, not UUID-lex)" "$OUT" 'sorted_seqs_monotonic:1'

echo ""
echo "Test 9 (multi-session regression): connect() must NOT spawn multiple engines"
assert_contains "no extra engine processes spawned across reconnects" "$OUT" 'engine_proc_growth:0'

echo ""
echo "=== Results ==="
echo -e "${GREEN}Passed: $pass${NC}"
if [ "$fail" -gt 0 ]; then echo -e "${RED}Failed: $fail${NC}"; exit 1
else echo -e "${GREEN}All smoke tests passed!${NC}"; fi

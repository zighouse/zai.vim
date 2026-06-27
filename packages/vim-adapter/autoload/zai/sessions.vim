scriptencoding utf-8

" AC3.1 phase → icon mapping (request/thinking/tool/response/done/error)
" Empty phase → ⏸ idle (per AC3.1 idle icon)
let s:icons = {'request':'📤','thinking':'🤔','tool':'🔧','response':'💬','done':'✅','error':'❌'}

" List buffer state — ported from old autoload/zai/chat.vim s:zai_lbuf pattern
" (stable bufnr integer, never a name lookup which silently fails for nofile
" buffers). Bug 1 fix: previous version used bufwinnr('zaivim-sessions') which
" never matched because no buffer was ever named that.
let s:sessions_bufnr = -1
let s:chat_signs = {}  " sessionId → sign_id (for cleanup)

" Define highlight groups + sign once per session (idempotent)
function! s:ensure_highlights() abort
  if exists('g:zai_sessions_signs_defined') | return | endif
  let g:zai_sessions_signs_defined = 1
  highlight default link ZaiSessionsSelLine Visual
  silent! execute 'sign define ZaiSessionsSel linehl=ZaiSessionsSelLine'
endfun

" Open sessions list window. Idempotent — safe to call from zai#chat#start()
" on every new chat. Layout: 5-row split ABOVE the current window (caller is
" expected to focus display buffer first). Ported from old s:goto_lwin().
"
" IMPORTANT: must branch on buffer-existence BEFORE issuing :split/:new.
" `:5split` without a file argument re-displays the CURRENT buffer in a new
" window — so if called from the display window, both windows would share
" the display buffer, and the subsequent `setlocal`/`let s:sessions_bufnr`
" would corrupt the display buffer (marking it as sessions, eventually
" setting it nomodifiable via render() → E21 on subsequent chat writes).
" Use `:5new` for fresh creation; `:5split | buffer N` only for re-show.
function! zai#sessions#open() abort
  call s:ensure_highlights()

  " Sanity check: tracked bufnr must still carry our marker; if not (e.g.
  " upgraded from buggy version where display buffer was misidentified),
  " reset and create fresh.
  if s:sessions_bufnr != -1 && (!bufexists(s:sessions_bufnr) || getbufvar(s:sessions_bufnr, 'zai_sessions') != 1)
    let s:sessions_bufnr = -1
  endif

  " Already visible — nothing to do
  if s:sessions_bufnr != -1 && bufwinnr(s:sessions_bufnr) != -1
    return
  endif

  if s:sessions_bufnr != -1
    " Buffer exists but no window (user closed it) — split then switch to it.
    " The transient split shows the current buffer briefly before `buffer`
    " switches the window to the sessions buffer; no persistent sharing.
    aboveleft 5split
    execute 'buffer ' . s:sessions_bufnr
  else
    " Fresh creation: 5new creates a brand-new buffer (NOT a re-show of
    " current buffer like 5split would).
    aboveleft 5new
    setlocal buftype=nofile bufhidden=hide nobuflisted noswapfile modifiable nowrap
    let s:sessions_bufnr = bufnr('%')
    let b:zai_sessions = 1  " cross-script marker (for tests + future integrations)
    let &l:statusline = '[Sessions]%=%-14.(%l,%c%V%) %P'
    nnoremap <buffer> <silent> <CR> :call zai#sessions#select_atpos()<CR>
    call zai#chat#setup_bufcmds()
  endif
endfun

" Public read-only access for tests + diagnostics
function! zai#sessions#get_bufnr() abort
  return s:sessions_bufnr
endfun

" Render the list. Called from s:ui_tick every 200ms with current chats dict
" and current selected session id. Ported from old s:update_chat_list().
"
" Poll-safe cursor preservation: writes lines IN-PLACE (only changed lines via
" setbufline, plus append or truncate tail). The old version did delete-all +
" set-all, which reset cursor to line 1 every 200ms — making j/k navigation
" impossible because the cursor snapped back faster than a key repeat.
" In-place writes leave the cursor line untouched as long as it still exists;
" Vim auto-clamps to last line only when the cursor's line is genuinely gone.
function! zai#sessions#render(chats, current_id) abort
  if s:sessions_bufnr == -1 || !bufexists(s:sessions_bufnr) | return | endif

  " Clear previous signs (avoids stale highlights when sessions close)
  for sid in keys(s:chat_signs)
    let sign_id = s:chat_signs[sid]
    if sign_id != -1
      silent! execute 'sign unplace' sign_id 'buffer=' . s:sessions_bufnr
    endif
  endfor
  let s:chat_signs = {}

  " Build content lines ordered by creation sequence (c.seq), NOT by id string.
  " Engine-issued sessionIds are random hex; sorting by them places new sessions
  " at unpredictable positions and breaks the mental model where `:cc 2` refers
  " to "the second session I created". seq is monotonic and preserved across
  " the p-N → UUID re-key in zai#chat#on_session. The 1-indexed position N in
  " this sorted list matches what `:cc N` selects, so we display it as `#N`.
  let ids = sort(keys(a:chats), {a, b -> get(a:chats[a], 'seq', 0) - get(a:chats[b], 'seq', 0)})
  let lines = []
  let line_num = 1

  for id in ids
    let c = a:chats[id]
    let phase = get(c, 'phase', '')
    let position_tag = '#' . line_num . ' '
    " Pending chats (engine not yet responded): show "启动中" instead of
    " empty stats. The placeholder id (p-N) is short and not user-meaningful.
    if phase ==# 'pending' || empty(get(c, 'sessionId', ''))
      call add(lines, position_tag . '⏳ 启动中…')
    else
      let icon = empty(phase) ? '⏸' : get(s:icons, phase, '⏸')
      let elapsed = printf('%.1f', get(c, 'elapsed_ms', 0) / 1000.0)
      let tokens = get(c, 'tokens_out', 0)
      let tool = get(c, 'tool_name', '')
      let suffix = !empty(tool) ? ' · ' . tool : ''
      call add(lines, position_tag . icon . ' ' . strpart(id, 0, 8) . ' · ' . elapsed . 's · ' . tokens . '↓' . suffix)
    endif

    " Place selection sign on current session's line
    if id ==# a:current_id
      let sign_id = line_num + 10000  " offset to avoid sign id conflicts
      silent! execute 'sign place' sign_id 'line=' . line_num 'name=ZaiSessionsSel' 'buffer=' . s:sessions_bufnr
      let s:chat_signs[id] = sign_id
    endif
    let line_num += 1
  endfor

  " In-place update — setbufline preserves cursor; only tail truncation can
  " move cursor, and only when cursor was on a now-deleted line (Vim clamps).
  call setbufvar(s:sessions_bufnr, '&modifiable', 1)
  let cur = getbufline(s:sessions_bufnr, 1, '$')
  let cur_n = len(cur)
  let new_n = len(lines)
  let n = min([cur_n, new_n])
  let i = 0
  while i < n
    if cur[i] !=# lines[i]
      call setbufline(s:sessions_bufnr, i + 1, lines[i])
    endif
    let i += 1
  endwhile
  if new_n > cur_n
    " cur_n could be 1 with cur=[''] when buffer was visually empty — that
    " single placeholder line was rewritten in the loop above, so we append
    " lines[cur_n:] which is correct in both cases.
    call appendbufline(s:sessions_bufnr, '$', lines[cur_n :])
  elseif cur_n > new_n
    " silent! — see chat.vim s:render_output comment. Truncating the sessions
    " list when a session closes can drop ml_line_count to 1, triggering the
    " same ml_delete keep_msg. Without this the list update leaves
    " "--No lines in buffer--" stuck on the cmdline for one tick.
    silent! call deletebufline(s:sessions_bufnr, new_n + 1, '$')
  endif
  call setbufvar(s:sessions_bufnr, '&modifiable', 0)
endfun

" Select session at cursor line. Bound to <CR> in sessions buffer.
" Ported from old s:select_chat_atpos(). No header row — line 1 is the first
" session, so the cursor's lnum maps directly to ids[lnum-1]. Sort by c.seq
" so the on-screen order matches what `:cc N` selects and what sessions#render
" displays — see render() comment for the rationale.
function! zai#sessions#select_atpos() abort
  let lnum = line('.')
  let chats = zai#chat#list_chats()
  let ids = sort(keys(chats), {a, b -> get(chats[a], 'seq', 0) - get(chats[b], 'seq', 0)})
  let idx = lnum - 1
  if idx < 0 || idx >= len(ids) | return | endif
  call zai#chat#switch(ids[idx])
endfun

" Close sessions list (called when last chat closes)
function! zai#sessions#close() abort
  if s:sessions_bufnr != -1 && bufexists(s:sessions_bufnr)
    let wn = bufwinnr(s:sessions_bufnr)
    if wn != -1 | execute wn . 'wincmd c' | endif
    silent! execute 'bwipeout! ' . s:sessions_bufnr
  endif
  let s:sessions_bufnr = -1
  let s:chat_signs = {}
endfun

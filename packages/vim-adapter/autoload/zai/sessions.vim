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
function! zai#sessions#open() abort
  call s:ensure_highlights()

  " Already visible — nothing to do
  if s:sessions_bufnr != -1 && bufexists(s:sessions_bufnr) && bufwinnr(s:sessions_bufnr) != -1
    return
  endif

  aboveleft 5split

  if s:sessions_bufnr != -1 && bufexists(s:sessions_bufnr)
    " Buffer exists but no window (user closed it) — re-show existing buffer
    execute 'buffer ' . s:sessions_bufnr
  else
    setlocal buftype=nofile bufhidden=hide nobuflisted noswapfile modifiable nowrap
    let s:sessions_bufnr = bufnr('%')
    let b:zai_sessions = 1  " cross-script marker (for tests + future integrations)
    let &l:statusline = '[Sessions]%=%-14.(%l,%c%V%) %P'
    nnoremap <buffer> <silent> <CR> :call zai#sessions#select_atpos()<CR>
  endif
endfun

" Public read-only access for tests + diagnostics
function! zai#sessions#get_bufnr() abort
  return s:sessions_bufnr
endfun

" Render the list. Called from s:ui_tick every 200ms with current chats dict
" and current selected session id. Ported from old s:update_chat_list().
"
" Poll-safe: does NOT move cursor (signs alone indicate selection). Old code
" moved cursor because updates were event-driven; with 200ms polling, cursor
" jumping would prevent the user from reading the list.
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

  " Build content lines (stable order: sort by sessionId string)
  let ids = sort(keys(a:chats))
  let lines = ['=== Sessions ===']
  let line_num = 2  " line 1 is header

  for id in ids
    let c = a:chats[id]
    let phase = get(c, 'phase', '')
    let icon = empty(phase) ? '⏸' : get(s:icons, phase, '⏸')
    let elapsed = printf('%.1f', get(c, 'elapsed_ms', 0) / 1000.0)
    let tokens = get(c, 'tokens_out', 0)
    let tool = get(c, 'tool_name', '')
    let suffix = !empty(tool) ? ' · ' . tool : ''
    call add(lines, icon . ' ' . strpart(id, 0, 8) . ' · ' . elapsed . 's · ' . tokens . '↓' . suffix)

    " Place selection sign on current session's line
    if id ==# a:current_id
      let sign_id = line_num + 10000  " offset to avoid sign id conflicts
      silent! execute 'sign place' sign_id 'line=' . line_num 'name=ZaiSessionsSel' 'buffer=' . s:sessions_bufnr
      let s:chat_signs[id] = sign_id
    endif
    let line_num += 1
  endfor

  " Atomic buffer content update
  call setbufvar(s:sessions_bufnr, '&modifiable', 1)
  call deletebufline(s:sessions_bufnr, 1, '$')
  call setbufline(s:sessions_bufnr, 1, lines)
  call setbufvar(s:sessions_bufnr, '&modifiable', 0)
endfun

" Select session at cursor line. Bound to <CR> in sessions buffer.
" Ported from old s:select_chat_atpos().
function! zai#sessions#select_atpos() abort
  let lnum = line('.')
  if lnum <= 1 | return | endif  " skip header
  let chats = zai#chat#list_chats()
  let ids = sort(keys(chats))
  let idx = lnum - 2
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

scriptencoding utf-8
let s:chats = {}
let s:timer = -1
let s:current_id = v:null
let s:client_seq = 0
let s:buf_seq = 0
let s:phase_icons = {'request':'📤','thinking':'🤔','tool':'🔧','response':'💬','done':'✅','error':'❌'}
let s:phase_labels = {'request':'发送中','thinking':'思考','tool':'','response':'生成','done':'完成','error':'错误'}
let s:spinner = ['◐', '◓', '◑', '◒']
let s:spinner_phase_labels = {'thinking':' 思考 ','tool':' 工具 '}
" Role prompt markers — 与旧 Python 版 autoload/zai/chat.vim:705 行为对齐：
" 用户消息和 AI 响应之间用空行 + 角色标记分隔，便于阅读区分
let s:user_prompt = get(g:, 'zaivim_chat_user_prompt', '**用户：**')
let s:assistant_prompt = get(g:, 'zaivim_chat_assistant_prompt', '**助手：**')

" DIAGNOSTIC: append msg to bufnr=1 (the empty unnamed buffer vim opens with
" when no file is given). Opt-in — set g:zaivim_debug_log = 1 to enable. Keeps
" bufnr=1 safe when the user opens vim with a real file (bufnr=1 = that file).
function! s:debug_log(msg) abort
  if !get(g:, 'zaivim_debug_log', 0) | return | endif
  if !bufexists(1) | return | endif
  let ts = strftime('%H:%M:%S')
  silent! call setbufvar(1, '&modifiable', 1)
  silent! call appendbufline(1, '$', ts . ' ' . a:msg)
  silent! call setbufvar(1, '&modifiable', 0)
endfun

" Window-role markers — `b:zai_role` value identifies output/input buffers
" across the layout. Used by s:find_window_by_role() to robustly locate the
" output/input window even when sessions have been switched (which changes
" the bufnr shown in that window). Ported from old autoload/zai/chat.vim's
" b:zai_buffer marker pattern, but split into role-specific markers.
let s:OUTPUT_ROLE = 'output'
let s:INPUT_ROLE = 'input'

" Allocate a fresh buffer with a unique name in the CURRENT window. Vim 9.1
" silently reuses an empty unnamed buffer when you call :enew! or :edit name
" on it (an optimization for scratch buffers), so all zaivim sessions ended up
" sharing bufnr=2 — chunk routing collapsed onto a single buffer. :badd creates
" a separate new buffer; :buffer then swaps the current window to it. Each
" session thus gets its own output AND input buffer.
function! s:alloc_role_buffer(role) abort
  let s:buf_seq += 1
  let l:name = 'zai://' . a:role . '/' . s:buf_seq
  execute 'badd ' . l:name
  let l:b = bufnr(l:name)
  execute 'buffer ' . l:b
  return l:b
endfun

" Find window showing a buffer with the given zai_role. Returns winnr or -1.
" Robust against session switching (bufnr changes per-session, but role marker
" is set on every new buffer in setup_output_buffer/setup_input_buffer).
function! s:find_window_by_role(role) abort
  for w in range(1, winnr('$'))
    if getbufvar(winbufnr(w), 'zai_role', '') ==# a:role
      return w
    endif
  endfor
  return -1
endfun

" Configure current buffer as an output (display) buffer. Idempotent — called
" both on first-time layout creation (vertical botright new) and on subsequent
" :ZaiChat calls (s:alloc_role_buffer in existing output window).
" Scroll the window showing {bufnr} to the bottom line. Uses win_execute (Vim
" 8.2+/Neovim) for non-intrusive scroll, falls back to window-switching.
function! s:scroll_bottom(bufnr) abort
  let wn = bufwinnr(a:bufnr)
  if wn == -1 | return | endif
  if exists('*win_execute')
    call win_execute(win_getid(wn), 'norm! G')
  elseif wn != winnr()
    let cur = winnr()
    execute wn . 'wincmd w' | norm! G
    execute cur . 'wincmd w'
  else
    norm! G
  endif
endfun

function! s:setup_output_buffer() abort
  setlocal buftype=nofile bufhidden=hide nobuflisted noswapfile modifiable wrap syntax=markdown
  let b:zai_role = s:OUTPUT_ROLE
  nnoremap <buffer><silent><nowait> <C-o> :call zai#chat#toggle_mode_internal()<CR>
  call zai#chat#setup_bufcmds()
  " BufWriteCmd allows :w <path> to save transcript even on nofile buffer
  augroup zai_chat_write
    autocmd! * <buffer>
    autocmd BufWriteCmd <buffer> call s:on_write()
  augroup END
endfun

" Configure current buffer as an input (compose) buffer. Mappings send the
" full multi-line content (AC2.2 hotfix — getline('.') was the original bug).
function! s:setup_input_buffer() abort
  setlocal buftype=nofile bufhidden=hide nobuflisted noswapfile modifiable wrap
  let b:zai_role = s:INPUT_ROLE
  nnoremap <buffer><silent><nowait> <CR> :call zai#chat#send_internal()<CR>
  nnoremap <buffer><silent><nowait> <C-c> :call zai#chat#cancel_internal()<CR>
  inoremap <buffer><silent><nowait> <C-CR> <Esc>:call zai#chat#send_internal()<CR>
  call zai#chat#setup_bufcmds()
endfun

" Open chat UI. Idempotent — first call builds 3-window layout (list + output
" + input); subsequent calls reuse the layout, switching output/input windows
" to fresh per-session buffers (so each session has its own output AND input
" buffer, per AC2.2 hotfix). Pattern ported from old autoload/zai/chat.vim
" s:ui_open() / s:goto_owin() / s:goto_iwin(), adapted for per-session ibuf.
function! zai#chat#start(args) abort
  call zai#rpc#connect()

  " Detect existing layout via role markers
  let ow = s:find_window_by_role(s:OUTPUT_ROLE)
  let iw = s:find_window_by_role(s:INPUT_ROLE)

  if ow == -1
    " First-time: build right-side stack — output (80w) on top, input (8h) below
    vertical botright new
    call s:setup_output_buffer()
    let disp_bnr = bufnr('%')
    vertical resize 80
    belowright 8new
    call s:setup_input_buffer()
    let in_bnr = bufnr('%')
  else
    " Layout exists — allocate a fresh uniquely-named buffer in the existing
    " output window. We can't use :enew! here because Vim 9.1 silently reuses
    " empty unnamed buffers (see s:alloc_role_buffer). Old buffer persists via
    " bufhidden=hide so prior sessions remain swappable.
    execute ow . 'wincmd w'
    let disp_bnr = s:alloc_role_buffer(s:OUTPUT_ROLE)
    call s:setup_output_buffer()
    let iw = s:find_window_by_role(s:INPUT_ROLE)
    if iw != -1
      execute iw . 'wincmd w'
      let in_bnr = s:alloc_role_buffer(s:INPUT_ROLE)
      call s:setup_input_buffer()
    else
      " Input window was closed by user — recreate below output
      execute bufwinnr(disp_bnr) . 'wincmd w'
      belowright 8new
      call s:setup_input_buffer()
      let in_bnr = bufnr('%')
    endif
  endif

  " Synchronously add a placeholder chat so the sessions list reflects the
  " new session IMMEDIATELY (parity with old autoload/zai/chat.vim s:ui_open
  " line 400: `let s:zai_chats[l:id] = l:chat` ran before job_start). The
  " real sessionId arrives async via s:on_session; we then re-key the entry
  " from the client-side placeholder id to the engine-provided UUID.
  let l:client_id = s:gen_client_id()
  " seq = creation order (monotonic, preserved across the p-N → UUID re-key in
  " s:on_session). Used to sort the sessions list and `:cc N` positional lookup
  " in CREATION order rather than UUID-alphabetical (which inserts new sessions
  " at random positions, masking the relationship between `:cc 2` and "the
  " second session I created").
  let s:chats[l:client_id] = {'bufnr': disp_bnr, 'ibuf_nr': in_bnr, 'sessionId': '', 'token': '', 'mode': get(g:,'zaivim_chat_default_mode','compact'), 'phase': 'pending', 'elapsed_ms': 0, 'tokens_out': 0, 'tool_name': '', 'events': [], 'thinking_ring': [], 'thinking_header_lnum': -1, 'thinking_phase': v:null, 'stats_tokens_in': 0, 'stats_speed': 0, 'stream_buf': [], 'spinner_idx': 0, 'spinner_lnum': -1, 'info_lnum': -1, 'stream_lnum': 0, 'seq': s:client_seq}
  " DIAGNOSTIC: log buffer allocation. If two sessions ever share the same
  " bufnr/ibuf_nr, that's the smoking gun for cross-session contamination.
  " Also list all existing chats' bufnrs so collisions are immediately visible.
  let l:others = []
  for [k, v] in items(s:chats)
    if k !=# l:client_id | call add(l:others, strpart(k, 0, 8) . ':' . v.bufnr . '/' . v.ibuf_nr) | endif
  endfor
  call s:debug_log('START placeholder=' . l:client_id . ' disp_bnr=' . disp_bnr . ' in_bnr=' . in_bnr . ' others=[' . join(l:others, ' ') . ']')
  let s:current_id = l:client_id
  call zai#rpc#request('session.create', {}, function('s:on_session', [l:client_id]))

  " Sessions list (idempotent — sessions#open checks bufwinnr internally).
  " Focus output window first so aboveleft 5new lands above output, not input.
  let disp_win = bufwinnr(disp_bnr)
  if disp_win != -1
    execute disp_win . 'wincmd w'
    call zai#sessions#open()
  endif

  " Focus input window so user can start typing immediately
  let in_win = bufwinnr(in_bnr)
  if in_win != -1 | execute in_win . 'wincmd w' | endif

  if s:timer == -1 | let s:timer = timer_start(200, function('s:ui_tick'), {'repeat': -1}) | endif
endfun

function! s:on_session(client_id, msg) abort
  if has_key(a:msg, 'error')
    " Engine rejected session.create — drop the placeholder so the user
    " isn't stuck looking at "启动中…" forever. Surface the error via :messages.
    if has_key(s:chats, a:client_id) | unlet s:chats[a:client_id] | endif
    if s:current_id ==# a:client_id | let s:current_id = v:null | endif
    echom '[zaivim] session.create error: ' . string(a:msg.error)
    return
  endif
  " User may have closed the chat while we were waiting — drop the response.
  if !has_key(s:chats, a:client_id) | return | endif
  let l:real_id = a:msg.result.sessionId
  let l:token = get(a:msg.result, '_token', '')
  let l:chat = remove(s:chats, a:client_id)
  let l:chat.sessionId = l:real_id
  let l:chat.token = l:token
  let l:chat.phase = v:null
  let s:chats[l:real_id] = l:chat
  let s:current_id = l:real_id
  call s:debug_log('SESSION_CREATE ' . a:client_id . ' -> ' . strpart(l:real_id, 0, 8) .
    \ ' bufnr=' . l:chat.bufnr . ' ibuf_nr=' . l:chat.ibuf_nr .
    \ ' chats_n=' . len(s:chats))
endfun

" Client-side placeholder ID generator. Uses 'p-' prefix to distinguish from
" engine-provided UUIDs (which are hex). Sequential within this Vim session.
function! s:gen_client_id() abort
  let s:client_seq += 1
  return 'p-' . s:client_seq
endfun

" 多行发送：读取整个 input buffer，join 为单个 text 字段，发送后清空。
" AC2.2 — Multi-line input support (hotfix for Story 4.1)
" 用户消息和 AI 响应之间用空行 + 角色标记分隔（与旧版 autoload/zai/chat.vim 一致）
function! s:send() abort
  if s:current_id == v:null | return | endif
  let c = s:chats[s:current_id]
  if empty(c.sessionId) | return | endif  " still pending; engine hasn't responded
  " Block send while engine is busy (streaming, thinking, tool use, or request in flight)
  if index(['response','thinking','tool','request'], c.phase) != -1
    echom '[zaivim] 请等待当前对话完成'
    return
  endif
  let lines = getbufline(c.ibuf_nr, 1, '$')
  while !empty(lines) && lines[-1] ==# '' | call remove(lines, -1) | endwhile
  if empty(lines) | return | endif
  let text = join(lines, "\n")
  let l:pre_lines = bufexists(c.bufnr) ? getbufinfo(c.bufnr)[0].linecount : -1
  let l:pre_stream_lnum = c.stream_lnum
  call s:debug_log('SEND sid=' . strpart(c.sessionId, 0, 8) .
    \ ' bufnr=' . c.bufnr .
    \ ' pre_stream_lnum=' . l:pre_stream_lnum .
    \ ' pre_buf_lines=' . l:pre_lines .
    \ ' text="' . strpart(substitute(text, "\n", '\\n', 'g'), 0, 40) . '"')
  call zai#rpc#request('chat.send', {'sessionId': c.sessionId, 'token': c.token, 'text': text})
  " 存入 events 以便 render_output 重放（保留用户/AI 边界）
  call add(c.events, {'type': 'user', 'content': text})
  " 增量渲染：display buffer 已有内容则前置空行作为分隔
  let existing = getbufline(c.bufnr, 1, '$')
  let has_content = !empty(filter(copy(existing), '!empty(v:val)'))
  let block = (has_content ? [''] : []) + [s:user_prompt] + lines + ['', s:assistant_prompt]
  call appendbufline(c.bufnr, '$', block)
  " silent! — see s:render_output comment for the ml_delete keep_msg rationale.
  " Clearing the input buffer after send empties it, which would otherwise
  " leave "--No lines in buffer--" on the cmdline after every <CR>-to-send.
  silent! call deletebufline(c.ibuf_nr, 1, '$')
endfun

function! s:cancel() abort
  if s:current_id == v:null | return | endif
  let c = s:chats[s:current_id]
  if empty(c.sessionId) | return | endif  " nothing to cancel while pending
  call zai#rpc#request('chat.cancel', {'id': c.sessionId, 'token': c.token})
endfun

function! s:toggle_mode() abort
  if s:current_id == v:null | return | endif
  let c = s:chats[s:current_id]
  let c.mode = c.mode ==# 'compact' ? 'verbose' : 'compact'
  call s:render_output(c)
endfun

" BufWriteCmd handler for acwrite chat buffers. Saves transcript to disk.
function! s:on_write() abort
  let path = expand('<afile>')
  if empty(path) | return | endif
  let lines = getbufline('%', 1, '$')
  call writefile(lines, path)
  setlocal nomodified
endfun

function! s:render_output(c) abort
  if !bufexists(a:c.bufnr) | return | endif
  " silent! suppresses Vim's ml_delete keep_msg. When deletebufline empties a
  " buffer, evalbuffer.c:611 calls ml_delete_flags(ML_DEL_MESSAGE), which in
  " memline.c:3908-3913 sets keep_msg to "--No lines in buffer--" via
  " set_keep_msg (message.c:1521-1530). set_keep_msg is a no-op when
  " msg_silent != 0, so :silent! call deletebufline(...) suppresses it. Without
  " this, switching sessions via :cp/:cn/:cc leaves a misleading residual
  " message on the cmdline (the actual ml_delete is intentional — we're about
  " to re-fill the buffer via appendbufline below).
  silent! call deletebufline(a:c.bufnr, 1, '$')
  let first_block = 1
  let l:thinking_rendered = 0
  let i = 0
  while i < len(a:c.events)
    let e = a:c.events[i]
    if e.type ==# 'user'
      let user_lines = split(get(e, 'content', ''), "\n", 1)
      while !empty(user_lines) && user_lines[-1] ==# '' | call remove(user_lines, -1) | endwhile
      let sep = first_block ? [] : ['']
      call appendbufline(a:c.bufnr, '$', sep + [s:user_prompt] + user_lines + ['', s:assistant_prompt])
      let first_block = 0
    elseif e.type ==# 'text'
      " Story 4.1.1: render thinking area before first text block in compact mode
      if a:c.mode ==# 'compact' && !l:thinking_rendered && !empty(a:c.thinking_ring)
        let l:thinking_rendered = 1
        call appendbufline(a:c.bufnr, '$', ['> 🤔 思考过程：'])
        for l:line in a:c.thinking_ring
          call appendbufline(a:c.bufnr, '$', '> ' . l:line)
        endfor
        call appendbufline(a:c.bufnr, '$', '---')
      endif
      let content = e.content
      let i += 1
      while i < len(a:c.events) && a:c.events[i].type ==# 'text'
        let content .= a:c.events[i].content
        let i += 1
      endwhile
      let lines = split(content, "\n", 1)
      if !empty(lines) && lines[-1] ==# '' | call remove(lines, -1) | endif
      for line in lines
        call appendbufline(a:c.bufnr, '$', line)
      endfor
      let first_block = 0
      continue
    elseif e.type ==# 'thinking'
      " Story 4.1.1: verbose mode shows full thinking content
      if a:c.mode ==# 'verbose'
        for l:line in split(get(e, 'content', ''), "\n", 1)
          call appendbufline(a:c.bufnr, '$', '> ' . l:line)
        endfor
        let first_block = 0
      endif
      " compact mode: skip — uses thinking_ring
    elseif e.type ==# 'stats'
      " skip — info bar rendered at end
    elseif e.type ==# 'tool_call'
      if a:c.mode ==# 'compact'
        call appendbufline(a:c.bufnr, '$', '🔧 ' . get(e,'name',''))
      else
        call appendbufline(a:c.bufnr, '$', '📎 ' . get(e,'name',''))
      endif
    elseif e.type ==# 'tool_result'
      if a:c.mode ==# 'compact'
        let last = getbufinfo(a:c.bufnr)[0].linecount
        let prev = getbufline(a:c.bufnr, last)[0]
        if prev =~# '^🔧'
          call setbufline(a:c.bufnr, last, prev . ' ✓')
        else
          call appendbufline(a:c.bufnr, '$', '✅ ' . get(e,'content',''))
        endif
      else
        call appendbufline(a:c.bufnr, '$', '✅ ' . get(e,'content',''))
      endif
    elseif e.type ==# 'error' | call appendbufline(a:c.bufnr, '$', '❌ ' . e.message)
    endif
    let i += 1
  endwhile
  " Story 4.1.1: info bar at end
  let l:info = s:format_info_bar(a:c)
  if !empty(l:info)
    call appendbufline(a:c.bufnr, '$', ['', l:info])
  endif
  let a:c.spinner_idx = 0 | let a:c.spinner_lnum = -1 | let a:c.stream_lnum = 0
  if exists('g:zaivim_debug_log') && g:zaivim_debug_log
    let l:post_lines = bufexists(a:c.bufnr) ? getbufinfo(a:c.bufnr)[0].linecount : -1
    call s:debug_log('RENDER sid=' . strpart(get(a:c,'sessionId',''), 0, 8) .
      \ ' bufnr=' . a:c.bufnr .
      \ ' post_stream_lnum=0' .
      \ ' post_buf_lines=' . l:post_lines .
      \ ' ev_n=' . len(a:c.events))
  endif
endfun

function! zai#chat#on_chunk(p) abort
  " AC3.1 hotfix: route by sessionId in chunk payload (Bug 3 fix). Concurrent
  " streams now append to their own session's display buffer. Falls back to
  " s:current_id for backward compat with older server.ts payloads.
  let l:chunk_sid = get(a:p, 'sessionId', '')
  let l:fallback = 0
  let sid = l:chunk_sid
  if empty(sid) || !has_key(s:chats, sid)
    let l:fallback = 1
    if s:current_id == v:null
      call s:debug_log('CHUNK type=' . get(a:p,'type','') . ' sid=EMPTY current=NULL DROP')
      return
    endif
    let sid = s:current_id
    if !has_key(s:chats, sid)
      call s:debug_log('CHUNK type=' . get(a:p,'type','') . ' sid=EMPTY current=' . strpart(s:current_id, 0, 8) . ' NOT_IN_CHATS DROP')
      return
    endif
  endif
  let c = s:chats[sid]
  let l:pre_lnum = c.stream_lnum
  let l:pre_lines = bufexists(c.bufnr) ? getbufinfo(c.bufnr)[0].linecount : -1
  call add(c.events, a:p)
  let t = get(a:p,'type','')
  if exists('g:zaivim_debug_log') && g:zaivim_debug_log
    let l:preview = substitute(get(a:p,'content',get(a:p,'message','')), '\n', '\\n', 'g')
    let l:preview = strpart(l:preview, 0, 40)
    call s:debug_log('CHUNK type=' . t . (l:fallback ? ' FALLBACK' : '') .
      \ ' chunk_sid=' . strpart(l:chunk_sid, 0, 8) .
      \ ' cur=' . (s:current_id == v:null ? 'NULL' : strpart(s:current_id, 0, 8)) .
      \ ' resolved=' . strpart(sid, 0, 8) .
      \ ' bufnr=' . c.bufnr .
      \ ' pre_stream_lnum=' . l:pre_lnum .
      \ ' pre_buf_lines=' . l:pre_lines .
      \ ' ev_n=' . len(c.events) .
      \ (empty(l:preview) ? '' : ' content="' . l:preview . '"'))
  endif
  if t ==# 'text'
    call add(c.stream_buf, get(a:p,'content',''))
    let content = get(a:p,'content','')
    let parts = split(content, "\n", 1)
    " 移除末尾由 \n 产生的空字符串——它不应显示为独立空行
    let trailing_nl = 0
    if content =~# "\n$"
      let trailing_nl = 1
      if !empty(parts) && parts[-1] ==# ''
        call remove(parts, -1)
      endif
    endif
    if c.stream_lnum > 0 && !empty(parts)
      let first = remove(parts, 0)
      " STREAM_LNUM 越界检测：stream_lnum 可能因为前一次 render_output
      " 清空 buffer 但 stream_lnum 没同步重置而指向不存在的行。此时
      " getbufline 返回空 list，[0] 越界。防御性 fallback：跳过拼接，
      " 直接走 append 新行分支。
      let gl = getbufline(c.bufnr, c.stream_lnum)
      if empty(gl)
        call s:debug_log('CHUNK stream_lnum=' . c.stream_lnum . ' OUT_OF_RANGE buf_lines=' . l:pre_lines . ' — append-only')
        call appendbufline(c.bufnr, '$', first)
      else
        let cur = gl[0]
        call setbufline(c.bufnr, c.stream_lnum, cur . first)
      endif
    endif
    for part in parts
      call appendbufline(c.bufnr, '$', part)
      let c.stream_lnum = getbufinfo(c.bufnr)[0].linecount
    endfor
    if trailing_nl
      let c.stream_lnum = 0
    endif
    if sid ==# s:current_id
      call s:scroll_bottom(c.bufnr)
    endif
  elseif t ==# 'done'
    " Story 4.1.1: Append info bar at stream end if stats available
    let l:info = s:format_info_bar(c)
    if !empty(l:info)
      call appendbufline(c.bufnr, '$', ['', l:info])
    endif
    let c.stream_lnum = 0
    let c.thinking_header_lnum = -1
    let c.thinking_phase = v:null
    return
  elseif t ==# 'thinking'
    " Story 4.1.1: thinking chunk — update ring buffer + events
    " Note: raw chunk already added to c.events at line 393.
    let c.stream_lnum = 0
    let l:content = get(a:p, 'content', '')
    let l:phase = get(a:p, 'phase', 'delta')
    if l:phase ==# 'start'
      call s:thinking_ring_clear(c)
    elseif l:phase ==# 'delta'
      let l:first_delta = empty(c.thinking_ring) && c.thinking_header_lnum == -1
      call s:thinking_ring_push(c, l:content)
      if l:first_delta && bufexists(c.bufnr)
        call appendbufline(c.bufnr, '$', '> 🤔 思考中...')
        let c.thinking_header_lnum = getbufinfo(c.bufnr)[0].linecount
      endif
    elseif l:phase ==# 'end'
      let c.thinking_phase = 'end'
      if c.thinking_header_lnum > 0 && bufexists(c.bufnr)
        call setbufline(c.bufnr, c.thinking_header_lnum, '> ✅ 思考完成')
      endif
    endif
    return
  elseif t ==# 'stats'
    " Story 4.1.1: stats chunk — store fields for info bar
    " Note: raw chunk already added to c.events at line 393.
    let c.stream_lnum = 0
    let c.stats_tokens_in = get(a:p, 'tokensIn', c.stats_tokens_in)
    let c.tokens_out = get(a:p, 'tokensOut', c.tokens_out)
    let c.elapsed_ms = get(a:p, 'elapsedMs', c.elapsed_ms)
    let c.stats_speed = get(a:p, 'speed', c.stats_speed)
    return
  else
    let c.stream_lnum = 0
    if t ==# 'error'
      call appendbufline(c.bufnr, '$', '❌ ' . get(a:p,'message',''))
    elseif t ==# 'tool_call'
      if c.mode ==# 'compact'
        call appendbufline(c.bufnr, '$', '🔧 ' . get(a:p,'name',''))
      else
        call appendbufline(c.bufnr, '$', '📎 ' . json_encode(a:p))
      endif
    elseif t ==# 'tool_result'
      if c.mode ==# 'compact'
        let last = getbufinfo(c.bufnr)[0].linecount
        let prev = getbufline(c.bufnr, last)[0]
        if prev =~# '^🔧'
          call setbufline(c.bufnr, last, prev . ' ✓')
        endif
      else
        call appendbufline(c.bufnr, '$', '✅ ' . get(a:p,'content',''))
      endif
    endif
  endif
endfun

function! zai#chat#on_notification(p) abort
  let t = get(a:p,'type','')
  let d = get(a:p,'data',{})
  if t ==# 'phase'
    " AC3.1 hotfix: route phase by sessionId so non-current sessions still
    " update their phase/elapsed/tokens fields (visible in sessions list).
    " Spinner only renders for current session to avoid cross-session
    " display buffer pollution.
    let sid = get(d, 'sessionId', '')
    if empty(sid) || !has_key(s:chats, sid)
      if s:current_id == v:null | return | endif
      let sid = s:current_id
      if !has_key(s:chats, sid) | return | endif
    endif
    let c = s:chats[sid]
    let p = get(d,'phase','')
    if !empty(p) && has_key(s:phase_icons, p)
      let c.phase = p | let c.elapsed_ms = get(d,'elapsed',c.elapsed_ms) | let c.tokens_out = get(d,'tokens',c.tokens_out) | let c.tool_name = get(d,'toolName',c.tool_name)
    endif
    if sid ==# s:current_id
      if p ==# 'thinking' || p ==# 'tool'
        call appendbufline(c.bufnr, '$', s:phase_icons[p] . get(s:spinner_phase_labels, p, ' ') . s:spinner[0])
        let c.spinner_lnum = getbufinfo(c.bufnr)[0].linecount
      elseif p ==# 'done' || p ==# 'error'
        let c.spinner_lnum = -1
      endif
    endif
    return
  endif
  if t ==# 'agent.progress'
    let sid = get(d, 'sessionId', s:current_id)
    if !has_key(s:chats, sid) | return | endif
    let c = s:chats[sid]
    if sid ==# s:current_id
      call appendbufline(c.bufnr, '$', '🔄 ' . get(d,'status','running'))
    endif
  endif
endfun

function! s:render_statusline(c) abort
  if a:c.phase == v:null | return '🟢 zaivim engine' | endif
  let icon = get(s:phase_icons, a:c.phase, '🟢')
  let label = get(s:phase_labels, a:c.phase, '')
  if a:c.phase ==# 'thinking' | return icon . ' 思考 ' . printf('%.1f', a:c.elapsed_ms/1000.0) . 's'
  elseif a:c.phase ==# 'response' | return icon . ' 生成 ' . printf('%.1f', a:c.tokens_out/1000.0) . 'k'
  elseif a:c.phase ==# 'tool' | return icon . ' ' . a:c.tool_name
  endif | return icon . ' ' . label
endfun

function! s:ui_tick(timer) abort
  if empty(s:chats) && s:timer != -1 | call timer_stop(s:timer) | let s:timer = -1 | return | endif
  for [_, c] in items(s:chats)
    if bufexists(c.bufnr)
      let wn = bufwinnr(c.bufnr)
      if wn != -1 | call setwinvar(wn, '&statusline', s:render_statusline(c)) | endif
      " Animate spinner during thinking/tool phases
      if c.spinner_lnum > 0
        let c.spinner_idx = (c.spinner_idx + 1) % len(s:spinner)
        call setbufline(c.bufnr, c.spinner_lnum, s:phase_icons[c.phase] . get(s:spinner_phase_labels, c.phase, ' ') . s:spinner[c.spinner_idx])
      endif
      " Story 4.1.1: Update thinking header with latest ring buffer content
      if c.thinking_header_lnum > 0 && c.thinking_phase ==# 'delta' && !empty(c.thinking_ring)
        call setbufline(c.bufnr, c.thinking_header_lnum, '> 🤔 ' . c.thinking_ring[-1])
      endif
    endif
  endfor
  call zai#sessions#render(s:chats, s:current_id)
endfun

" Public accessor for sessions.vim to read chat state (avoid <SID> cross-file
" scope issues). Used by zai#sessions#select_atpos() to map line → sessionId.
function! zai#chat#list_chats() abort
  return s:chats
endfunction

" Sort chat ids by creation order (c.seq), NOT by UUID string. The UUIDs are
" randomly distributed hex, so lexicographic sort inserts new sessions at
" random positions — masking which session `:cc 2` refers to. seq is monotonic
" and preserved across the p-N → UUID re-key in s:on_session.
function! zai#chat#sorted_ids() abort
  return sort(keys(s:chats), {a, b -> get(s:chats[a], 'seq', 0) - get(s:chats[b], 'seq', 0)})
endfunction

" Public read-only access to the current session id. Returns v:null when no
" session is active. Used by attach.vim (and future P1 modules) to address
" the active session's input buffer without reaching into script-local state.
function! zai#chat#current_id() abort
  return s:current_id
endfunction

" Story 4.1.1: Clear thinking ring buffer (called on thinking phase:start).
function! s:thinking_ring_clear(chat) abort
  let a:chat.thinking_ring = []
  let a:chat.thinking_phase = 'start'
endfun

" Story 4.1.1: Push content lines into 5-line FIFO ring buffer.
" Content arrives pre-sanitized from Node-side sanitizeForVim (AC4).
function! s:thinking_ring_push(chat, content) abort
  let a:chat.thinking_phase = 'delta'
  for l:line in split(a:content, "\n", 1)
    call add(a:chat.thinking_ring, l:line)
    if len(a:chat.thinking_ring) > 5
      call remove(a:chat.thinking_ring, 0)
    endif
  endfor
endfun

" Story 4.1.1: Format stats info bar string from chat fields.
" Returns empty string when no stats data collected.
function! s:format_info_bar(chat) abort
  if a:chat.stats_tokens_in == 0 && a:chat.tokens_out == 0 | return '' | endif
  let l:in_k = a:chat.stats_tokens_in > 0 ? printf('%.1f', a:chat.stats_tokens_in / 1000.0) : '?'
  let l:out_k = a:chat.tokens_out > 0 ? printf('%.1f', a:chat.tokens_out / 1000.0) : '?'
  let l:el = a:chat.elapsed_ms > 0 ? printf('%.1f', a:chat.elapsed_ms / 1000.0) : '?'
  let l:spd = a:chat.stats_speed > 0 ? printf('%d', a:chat.stats_speed) : '?'
  return '📊 ↑' . l:in_k . 'k · ↓' . l:out_k . 'k · ' . l:el . 's · ' . l:spd . 't/s'
endfun

function! zai#chat#close() abort
  if s:current_id != v:null && has_key(s:chats, s:current_id)
    let c = s:chats[s:current_id]
    call zai#rpc#request('session.close', {'sessionId': c.sessionId, 'token': c.token})
    if bufexists(c.bufnr) | execute 'bwipeout! ' . c.bufnr | endif
    if bufexists(c.ibuf_nr) | execute 'bwipeout! ' . c.ibuf_nr | endif
    unlet s:chats[s:current_id]
  endif | let s:current_id = v:null
  " AC3.1 hotfix: tear down sessions list when no chats remain
  if empty(s:chats) | call zai#sessions#close() | endif
endfun

" Public wrappers for buffer-local mappings — avoid <SID>/<SNR> which break
" when the mapping is defined from a channel-callback context.
function! zai#chat#send_internal() abort
  call s:send()
endfunction
function! zai#chat#cancel_internal() abort
  call s:cancel()
endfunction
function! zai#chat#toggle_mode_internal() abort
  call s:toggle_mode()
endfunction

" Switch to session {id}: swap the output window's buffer to that session's
" display buffer, and the input window's buffer to its input buffer. Layout
" (window count/positions) is preserved; only the displayed buffers change.
" This is the wholesale port of old s:goto_owin() + s:goto_iwin() for the
" per-session-ibuf era (AC2.2 hotfix).
function! zai#chat#switch(id) abort
  if !has_key(s:chats, a:id)
    call s:debug_log('SWITCH target=' . strpart(a:id, 0, 8) . ' NOT_IN_CHATS — skip')
    return | endif
  let c = s:chats[a:id]
  let l:prev_current = s:current_id
  let l:pre_lines = bufexists(c.bufnr) ? getbufinfo(c.bufnr)[0].linecount : -1
  let s:current_id = a:id
  let ow = s:find_window_by_role(s:OUTPUT_ROLE)
  call s:debug_log('SWITCH from=' . (l:prev_current == v:null ? 'NULL' : strpart(l:prev_current, 0, 8)) .
    \ ' to=' . strpart(a:id, 0, 8) .
    \ ' bufnr=' . c.bufnr .
    \ ' pre_stream_lnum=' . c.stream_lnum .
    \ ' pre_buf_lines=' . l:pre_lines .
    \ ' ev_n=' . len(c.events) .
    \ ' ow=' . ow)
  if ow != -1 && bufexists(c.bufnr)
    execute ow . 'wincmd w'
    execute 'buffer ' . c.bufnr
    call s:render_output(c)
    norm! G
  endif
  let iw = s:find_window_by_role(s:INPUT_ROLE)
  if iw != -1 && bufexists(c.ibuf_nr)
    execute iw . 'wincmd w'
    execute 'buffer ' . c.ibuf_nr
  endif
endfun

" Create a new chat session (alias for zai#chat#start('')).
function! zai#chat#new() abort
  call zai#chat#start('')
endfun

" Advance to next session in sorted-id order. {count} optional, default 1.
" Wraps around at the end. No-op if s:current_id isn't in s:chats.
"
" Count handling must check `a:1 > 0`, not just `a:0 > 0`: Vim's -count command
" flag defaults <count> to 0 when no count is given, so `:ZaiNext` invokes
" next(0). Without the `> 0` guard, count=0 advances by zero (switches to
" self, no visible change). Parity with old autoload/zai/chat.vim:1007
" `let l:count = a:count > 0 ? a:count : 1`.
function! zai#chat#next(...) abort
  let l:count = (a:0 > 0 && a:1 > 0) ? a:1 : 1
  let l:ids = zai#chat#sorted_ids()
  if empty(l:ids) | return | endif
  let l:cur_idx = empty(s:current_id) ? -1 : index(l:ids, s:current_id)
  let l:next_idx = (l:cur_idx + l:count) % len(l:ids)
  call zai#chat#switch(l:ids[l:next_idx])
endfun

" Advance to previous session in sorted-id order. {count} optional, default 1.
" Wraps around at the beginning. Same count=0 guard as next() — see comment
" there for the rationale.
function! zai#chat#prev(...) abort
  let l:count = (a:0 > 0 && a:1 > 0) ? a:1 : 1
  let l:ids = zai#chat#sorted_ids()
  if empty(l:ids) | return | endif
  let l:cur_idx = empty(s:current_id) ? -1 : index(l:ids, s:current_id)
  " +len to keep modulo positive when cur_idx is -1 and count > 0
  let l:prev_idx = (l:cur_idx - l:count + len(l:ids)) % len(l:ids)
  call zai#chat#switch(l:ids[l:prev_idx])
endfun

" Jump to session by 1-indexed position in creation-order list. {nr} is a
" string (from command-line <args>); silently ignores out-of-range indices.
function! zai#chat#goto(nr) abort
  let l:idx = str2nr(a:nr) - 1
  let l:ids = zai#chat#sorted_ids()
  if l:idx < 0 || l:idx >= len(l:ids) | return | endif
  call zai#chat#switch(l:ids[l:idx])
endfun

" Command-line filter: rewrites quickfix-style commands to session navigation
" when invoked from a zai buffer. Returns the substituted cmdline, or the
" original if no match. Ported from old autoload/zai/chat.vim zai#chat#FiltCmd
" (line 1143). Handles count prefix (3cn → 3ZaiNext) and cc-with-arg
" (cc 3 / cc3 → ZaiGoto 3). Skipped 'help' (no zai.txt for new adapter yet).
function! zai#chat#filt_cmd(cmdline) abort
  let l:command_map = {'new': 'ZaiNew', 'cn': 'ZaiNext', 'cp': 'ZaiPrev', 'cc': 'ZaiGoto'}
  for [l:abbr, l:full] in items(l:command_map)
    if a:cmdline =~# '^\d*' . l:abbr . '$'
      return substitute(a:cmdline, l:abbr, l:full, '')
    endif
    if l:abbr ==# 'cc' && a:cmdline =~# '^cc\s*\d\+$'
      let l:param = substitute(a:cmdline, '^cc\s*\(\d\+\)$', '\1', '')
      return l:full . ' ' . l:param
    endif
  endfor
  return a:cmdline
endfun

" Install buffer-local Zai* commands + cnoremap <expr> <CR> in the current
" buffer (any zai-related buffer: output/input/sessions). Idempotent via
" b:zai_bufcmds flag. Must be called DIRECTLY from setup_output_buffer /
" setup_input_buffer / sessions#open — a BufEnter autocmd would fire BEFORE
" those setup functions set b:zai_role / b:zai_sessions (because :new and
" enew! fire BufEnter synchronously during their own execution), so the
" condition would never match on first creation.
"
" Verbatim port of old autoload/zai/chat.vim:1232 s:setup_buffer_commands +
" the cnoremap <expr> pattern from line 1243. The <expr> returns a string of
" keys that's fed to typeahead; because this is a cnoremap (noremap), the
" returned keys are NOT re-processed through mappings — so the trailing \<CR>
" executes the rewritten cmdline instead of recursing. Single-line to dodge
" \ line-continuation fragility in -e Ex mode.
function! zai#chat#setup_bufcmds() abort
  if exists('b:zai_bufcmds') && b:zai_bufcmds | return | endif
  command! -buffer ZaiNew call zai#chat#new()
  command! -buffer -count ZaiNext call zai#chat#next(<count>)
  command! -buffer -count ZaiPrev call zai#chat#prev(<count>)
  command! -buffer -nargs=1 ZaiGoto call zai#chat#goto(<args>)
  cnoremap <silent> <expr> <buffer> <CR> getcmdtype() ==# ':' ? "\<C-u>" . zai#chat#filt_cmd(getcmdline()) . "\<CR>" : "\<CR>"
  let b:zai_bufcmds = 1
endfun

scriptencoding utf-8
let s:chats = {}
let s:timer = -1
let s:current_id = v:null
let s:pending = v:null
let s:phase_icons = {'request':'📤','thinking':'🤔','tool':'🔧','response':'💬','done':'✅','error':'❌'}
let s:phase_labels = {'request':'发送中','thinking':'思考','tool':'','response':'生成','done':'完成','error':'错误'}
let s:spinner = ['◐', '◓', '◑', '◒']
let s:spinner_phase_labels = {'thinking':' 思考 ','tool':' 工具 '}
" Role prompt markers — 与旧 Python 版 autoload/zai/chat.vim:705 行为对齐：
" 用户消息和 AI 响应之间用空行 + 角色标记分隔，便于阅读区分
let s:user_prompt = get(g:, 'zaivim_chat_user_prompt', '**用户：**')
let s:assistant_prompt = get(g:, 'zaivim_chat_assistant_prompt', '**助手：**')

" Window-role markers — `b:zai_role` value identifies output/input buffers
" across the layout. Used by s:find_window_by_role() to robustly locate the
" output/input window even when sessions have been switched (which changes
" the bufnr shown in that window). Ported from old autoload/zai/chat.vim's
" b:zai_buffer marker pattern, but split into role-specific markers.
let s:OUTPUT_ROLE = 'output'
let s:INPUT_ROLE = 'input'

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
" :ZaiChat calls (enew! in existing output window).
function! s:setup_output_buffer() abort
  setlocal buftype=nofile bufhidden=hide nobuflisted noswapfile modifiable wrap syntax=markdown
  let b:zai_role = s:OUTPUT_ROLE
  nnoremap <buffer><silent><nowait> <C-o> :call zai#chat#toggle_mode_internal()<CR>
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
    " Layout exists — enew! swaps current window's buffer for a fresh one
    " without disturbing the window layout (old buffer persists via bufhidden=hide)
    execute ow . 'wincmd w'
    enew!
    call s:setup_output_buffer()
    let disp_bnr = bufnr('%')
    let iw = s:find_window_by_role(s:INPUT_ROLE)
    if iw != -1
      execute iw . 'wincmd w'
      enew!
      call s:setup_input_buffer()
      let in_bnr = bufnr('%')
    else
      " Input window was closed by user — recreate below output
      execute bufwinnr(disp_bnr) . 'wincmd w'
      belowright 8new
      call s:setup_input_buffer()
      let in_bnr = bufnr('%')
    endif
  endif

  let s:pending = {'bufnr': disp_bnr, 'ibuf_nr': in_bnr}
  call zai#rpc#request('session.create', {}, function('s:on_session'))

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

function! s:on_session(msg) abort
  if has_key(a:msg, 'error') | return | endif
  if s:pending is v:null | return | endif
  let id = a:msg.result.sessionId
  let token = get(a:msg.result, '_token', '')
  let bnr = s:pending.bufnr
  let ibuf = s:pending.ibuf_nr
  unlet s:pending
  let s:chats[id] = {'bufnr': bnr, 'ibuf_nr': ibuf, 'sessionId': id, 'token': token, 'mode': get(g:,'zaivim_chat_default_mode','compact'), 'phase': v:null, 'elapsed_ms': 0, 'tokens_out': 0, 'tool_name': '', 'events': [], 'thinking_ring': [], 'stream_buf': [], 'spinner_idx': 0, 'spinner_lnum': -1, 'info_lnum': -1, 'stream_lnum': 0}
  let s:current_id = id
endfun

" 多行发送：读取整个 input buffer，join 为单个 text 字段，发送后清空。
" AC2.2 — Multi-line input support (hotfix for Story 4.1)
" 用户消息和 AI 响应之间用空行 + 角色标记分隔（与旧版 autoload/zai/chat.vim 一致）
function! s:send() abort
  if s:current_id == v:null | return | endif
  let c = s:chats[s:current_id]
  let lines = getbufline(c.ibuf_nr, 1, '$')
  while !empty(lines) && lines[-1] ==# '' | call remove(lines, -1) | endwhile
  if empty(lines) | return | endif
  let text = join(lines, "\n")
  call zai#rpc#request('chat.send', {'sessionId': c.sessionId, 'token': c.token, 'text': text})
  " 存入 events 以便 render_output 重放（保留用户/AI 边界）
  call add(c.events, {'type': 'user', 'content': text})
  " 增量渲染：display buffer 已有内容则前置空行作为分隔
  let existing = getbufline(c.bufnr, 1, '$')
  let has_content = !empty(filter(copy(existing), '!empty(v:val)'))
  let block = (has_content ? [''] : []) + [s:user_prompt] + lines + ['', s:assistant_prompt]
  call appendbufline(c.bufnr, '$', block)
  call deletebufline(c.ibuf_nr, 1, '$')
endfun

function! s:cancel() abort
  if s:current_id == v:null | return | endif
  let c = s:chats[s:current_id]
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
  call deletebufline(a:c.bufnr, 1, '$')
  let first_block = 1
  let i = 0
  while i < len(a:c.events)
    let e = a:c.events[i]
    if e.type ==# 'user'
      let user_lines = split(get(e, 'content', ''), "\n", 1)
      while !empty(user_lines) && user_lines[-1] ==# '' | call remove(user_lines, -1) | endwhile
      let sep = first_block ? [] : ['']
      call appendbufline(a:c.bufnr, '$', sep + [s:user_prompt] + user_lines + ['', s:assistant_prompt])
      let first_block = 0
      let i += 1
    elseif e.type ==# 'text'
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
  let a:c.spinner_idx = 0 | let a:c.spinner_lnum = -1 | let a:c.stream_lnum = 0
endfun

function! zai#chat#on_chunk(p) abort
  " AC3.1 hotfix: route by sessionId in chunk payload (Bug 3 fix). Concurrent
  " streams now append to their own session's display buffer. Falls back to
  " s:current_id for backward compat with older server.ts payloads.
  let sid = get(a:p, 'sessionId', '')
  if empty(sid) || !has_key(s:chats, sid)
    if s:current_id == v:null | return | endif
    let sid = s:current_id
    if !has_key(s:chats, sid) | return | endif
  endif
  let c = s:chats[sid]
  call add(c.events, a:p)
  let t = get(a:p,'type','')
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
      let cur = getbufline(c.bufnr, c.stream_lnum)[0]
      call setbufline(c.bufnr, c.stream_lnum, cur . first)
    endif
    for part in parts
      call appendbufline(c.bufnr, '$', part)
      let c.stream_lnum = getbufinfo(c.bufnr)[0].linecount
    endfor
    if trailing_nl
      let c.stream_lnum = 0
    endif
  elseif t ==# 'done'
    let c.stream_lnum = 0
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
    endif
  endfor
  call zai#sessions#render(s:chats, s:current_id)
endfun

" Public accessor for sessions.vim to read chat state (avoid <SID> cross-file
" scope issues). Used by zai#sessions#select_atpos() to map line → sessionId.
function! zai#chat#list_chats() abort
  return s:chats
endfunction

" Public read-only access to the current session id. Returns v:null when no
" session is active. Used by attach.vim (and future P1 modules) to address
" the active session's input buffer without reaching into script-local state.
function! zai#chat#current_id() abort
  return s:current_id
endfunction

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
  if !has_key(s:chats, a:id) | return | endif
  let c = s:chats[a:id]
  let s:current_id = a:id
  let ow = s:find_window_by_role(s:OUTPUT_ROLE)
  if ow != -1 && bufexists(c.bufnr)
    execute ow . 'wincmd w'
    execute 'buffer ' . c.bufnr
    call s:render_output(c)
  endif
  let iw = s:find_window_by_role(s:INPUT_ROLE)
  if iw != -1 && bufexists(c.ibuf_nr)
    execute iw . 'wincmd w'
    execute 'buffer ' . c.ibuf_nr
  endif
endfun

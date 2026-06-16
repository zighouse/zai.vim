scriptencoding utf-8
let s:chats = {}
let s:timer = -1
let s:current_id = v:null
let s:pending = v:null
let s:phase_icons = {'request':'📤','thinking':'🤔','tool':'🔧','response':'💬','done':'✅','error':'❌'}
let s:phase_labels = {'request':'发送中','thinking':'思考','tool':'','response':'生成','done':'完成','error':'错误'}
let s:spinner = ['◐', '◓', '◑', '◒']
let s:spinner_phase_labels = {'thinking':' 思考 ','tool':' 工具 '}

function! zai#chat#start(args) abort
  call zai#rpc#connect()
  " Create buffer in main-loop context where :nnoremap is known to work.
  rightbelow vertical new
  setlocal buftype=nofile bufhidden=hide nobuflisted noswapfile
  setlocal modifiable wrap
  setlocal syntax=markdown
  let bnr = bufnr('%')
  nnoremap <buffer><silent><nowait> <CR> :call zai#chat#send_internal()<CR>
  nnoremap <buffer><silent><nowait> <C-c> :call zai#chat#cancel_internal()<CR>
  nnoremap <buffer><silent><nowait> <C-o> :call zai#chat#toggle_mode_internal()<CR>
  inoremap <buffer><silent><nowait> <C-CR> <Esc>:call zai#chat#send_internal()<CR>
  execute 'autocmd BufWriteCmd <buffer=' . bnr . '> call s:on_write()'
  " Store pending buffer info — s:on_session fills session details on response.
  let s:pending = {'bufnr': bnr}
  call zai#rpc#request('session.create', {}, function('s:on_session'))
  if s:timer == -1 | let s:timer = timer_start(200, function('s:ui_tick'), {'repeat': -1}) | endif
endfun

function! s:on_session(msg) abort
  if has_key(a:msg, 'error') | return | endif
  if s:pending is v:null | return | endif
  let id = a:msg.result.sessionId
  let token = get(a:msg.result, '_token', '')
  let bnr = s:pending.bufnr
  unlet s:pending
  let s:chats[id] = {'bufnr': bnr, 'sessionId': id, 'token': token, 'mode': get(g:,'zaivim_chat_default_mode','compact'), 'phase': v:null, 'elapsed_ms': 0, 'tokens_out': 0, 'tool_name': '', 'events': [], 'thinking_ring': [], 'stream_buf': [], 'spinner_idx': 0, 'spinner_lnum': -1, 'info_lnum': -1, 'stream_lnum': 0}
  let s:current_id = id
endfun

function! s:send() abort
  if s:current_id == v:null | return | endif
  let c = s:chats[s:current_id]
  let line = getline('.')
  if empty(line) | return | endif
  call zai#rpc#request('chat.send', {'sessionId': c.sessionId, 'token': c.token, 'text': line})
  call appendbufline(c.bufnr, '$', '> ' . line)
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
  let i = 0
  while i < len(a:c.events)
    let e = a:c.events[i]
    if e.type ==# 'text'
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
  if s:current_id == v:null | return | endif
  let c = s:chats[s:current_id]
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
  if s:current_id == v:null | return | endif
  let c = s:chats[s:current_id]
  let t = get(a:p,'type','')
  if t ==# 'phase'
    let d = get(a:p,'data',{})
    let p = get(d,'phase','')
    if !empty(p) && has_key(s:phase_icons, p)
      let c.phase = p | let c.elapsed_ms = get(d,'elapsed',c.elapsed_ms) | let c.tokens_out = get(d,'tokens',c.tokens_out) | let c.tool_name = get(d,'toolName',c.tool_name)
    endif
    if p ==# 'thinking' || p ==# 'tool'
      call appendbufline(c.bufnr, '$', s:phase_icons[p] . get(s:spinner_phase_labels, p, ' ') . s:spinner[0])
      let c.spinner_lnum = getbufinfo(c.bufnr)[0].linecount
    elseif p ==# 'done' || p ==# 'error'
      let c.spinner_lnum = -1
    endif
    return
  endif
  if t ==# 'agent.progress'
    call appendbufline(c.bufnr, '$', '🔄 ' . get(get(a:p,'data',{}),'status','running'))
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
  call zai#sessions#render(s:chats)
endfun

function! zai#chat#close() abort
  if s:current_id != v:null && has_key(s:chats, s:current_id)
    let c = s:chats[s:current_id]
    call zai#rpc#request('session.close', {'sessionId': c.sessionId, 'token': c.token})
    if bufexists(c.bufnr) | execute 'bwipeout! ' . c.bufnr | endif
    unlet s:chats[s:current_id]
  endif | let s:current_id = v:null
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

function! zai#chat#switch(id) abort
  if !has_key(s:chats, a:id) | return | endif
  let c = s:chats[a:id]
  let s:current_id = a:id
  if bufexists(c.bufnr)
    execute 'buffer ' . c.bufnr
    call s:render_output(c)
  endif
endfun

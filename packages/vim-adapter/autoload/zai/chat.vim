scriptencoding utf-8
let s:chats = {}
let s:timer = -1
let s:current_id = v:null
let s:phase_icons = {'request':'📤','thinking':'🤔','tool':'🔧','response':'💬','done':'✅','error':'❌'}
let s:phase_labels = {'request':'发送中','thinking':'思考','tool':'','response':'生成','done':'完成','error':'错误'}

function! zai#chat#start(args) abort
  call zai#rpc#connect()
  call zai#rpc#request('session.create', {}, function('s:on_session'))
endfun

function! s:on_session(msg) abort
  if has_key(a:msg, 'error') | return | endif
  let id = a:msg.result.sessionId
  rightbelow vertical new
  setlocal buftype=nofile bufhidden=hide nobuflisted noswapfile filetype=markdown
  let s:chats[id] = {'bufnr': bufnr('%'), 'sessionId': id, 'mode': get(g:,'zaivim_chat_default_mode','compact'), 'phase': v:null, 'elapsed_ms': 0, 'tokens_out': 0, 'tool_name': '', 'events': [], 'thinking_ring': [], 'stream_buf': []}
  let s:current_id = id
  nnoremap <buffer> <CR> :call <SID>send()<CR>
  nnoremap <buffer> <C-c> :call <SID>cancel()<CR>
  nnoremap <buffer> <silent> <C-o> :call <SID>toggle_mode()<CR>
  if s:timer == -1 | let s:timer = timer_start(200, function('s:ui_tick'), {'repeat': -1}) | endif
endfun

function! s:send() abort
  if s:current_id == v:null | return | endif
  let c = s:chats[s:current_id]
  let line = getline('.')
  if empty(line) | return | endif
  call zai#rpc#request('chat.send', {'sessionId': c.sessionId, 'text': line})
  call appendbufline(c.bufnr, '$', '> ' . line)
endfun

function! s:cancel() abort
  if s:current_id == v:null | return | endif
  call zai#rpc#request('chat.cancel', {'id': s:chats[s:current_id].sessionId})
endfun

function! s:toggle_mode() abort
  if s:current_id == v:null | return | endif
  let c = s:chats[s:current_id]
  let c.mode = c.mode ==# 'compact' ? 'verbose' : 'compact'
  call s:render_output(c)
endfun

function! s:render_output(c) abort
  if !bufexists(a:c.bufnr) | return | endif
  call deletebufline(a:c.bufnr, 1, '$')
  for e in a:c.events
    if e.type ==# 'text' | call appendbufline(a:c.bufnr, '$', e.content)
    elseif e.type ==# 'tool_call' | call appendbufline(a:c.bufnr, '$', '📎 ' . e.name)
    elseif e.type ==# 'error' | call appendbufline(a:c.bufnr, '$', '❌ ' . e.message)
    endif
  endfor
  if !empty(a:c.stream_buf) | call appendbufline(a:c.bufnr, '$', a:c.stream_buf[-1]) | endif
endfun

function! zai#chat#on_chunk(p) abort
  if s:current_id == v:null | return | endif
  let c = s:chats[s:current_id]
  call add(c.events, a:p)
  let t = get(a:p,'type','')
  if t ==# 'text'
    call add(c.stream_buf, get(a:p,'content',''))
    call appendbufline(c.bufnr, '$', get(a:p,'content',''))
  elseif t ==# 'error'
    call appendbufline(c.bufnr, '$', '❌ ' . get(a:p,'message',''))
  elseif t ==# 'done' | return
  else
    call appendbufline(c.bufnr, '$', c.mode ==# 'compact' ? '…' : json_encode(a:p))
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
  if a:c.phase ==# 'thinking' | return icon . ' 思考 ' . (a:c.elapsed_ms/1000) . 's'
  elseif a:c.phase ==# 'response' | return icon . ' 生成 ' . (a:c.tokens_out/1000) . 'k'
  elseif a:c.phase ==# 'tool' | return icon . ' ' . a:c.tool_name
  endif | return icon . ' ' . label
endfun

function! s:ui_tick(timer) abort
  if empty(s:chats) && s:timer != -1 | call timer_stop(s:timer) | let s:timer = -1 | return | endif
  for [_, c] in items(s:chats)
    if bufexists(c.bufnr) | let &l:statusline = s:render_statusline(c) | endif
  endfor
endfun

function! zai#chat#close() abort
  if s:current_id != v:null && has_key(s:chats, s:current_id)
    let c = s:chats[s:current_id]
    call zai#rpc#request('session.close', {'sessionId': c.sessionId})
    if bufexists(c.bufnr) | execute 'bwipeout! ' . c.bufnr | endif
    unlet s:chats[s:current_id]
  endif | let s:current_id = v:null
endfun

function! zai#chat#switch(id) abort
  if !has_key(s:chats, a:id) | return | endif
  let c = s:chats[a:id]
  let s:current_id = a:id
  if bufexists(c.bufnr)
    execute 'buffer ' . c.bufnr
    call s:render_output(c)
  endif
endfun

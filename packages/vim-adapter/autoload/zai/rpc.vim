let s:job = v:null | let s:channel = v:null | let s:pending = {} | let s:next_id = 1
let s:vim_buf = ''
let s:ready = 0
let s:queue = []

function! s:enc(msg) abort
  return &encoding !=# 'utf-8' && has('iconv') ? iconv(json_encode(a:msg), &encoding, 'utf-8') : json_encode(a:msg)
endfun
function! s:dec(line) abort
  return &encoding !=# 'utf-8' && has('iconv') ? iconv(a:line, 'utf-8', &encoding) : a:line
endfun

function! s:handle_msg(raw) abort
  let line = s:dec(a:raw)
  try | let msg = json_decode(line) | catch | return | endtry
  if type(msg) != v:t_dict | return | endif
  if has_key(msg, 'id') && (has_key(msg, 'result') || has_key(msg, 'error'))
    let Cb = get(s:pending, msg.id, v:null)
    if Cb != v:null | call Cb(msg) | unlet s:pending[msg.id] | endif
  elseif has_key(msg, 'method')
    if msg.method ==# '$/chat/chunk' | call zai#chat#on_chunk(msg.params)
    elseif msg.method ==# '$/notification' | call zai#chat#on_notification(msg.params)
    elseif msg.method ==# 'agent.progress' | call zai#agent#on_progress(msg.params)
    elseif msg.method ==# 'agent.error' | call zai#agent#on_progress({'status': 'error'})
    elseif msg.method ==# 'agent.tool_budget_exhausted' | call zai#agent#on_progress({'status': 'tool_budget_exhausted'})
    elseif msg.method ==# '$/ready' | call s:on_ready()
    endif
  endif
endfun

" Vim 8.x out_cb delivers complete lines (trailing \n stripped by Vim itself,
" since Vim's job pipe reader buffers by newline). Each call is one line.
" Defensive: if a future Vim version preserves \n, still split correctly.
function! s:vim_stdout(ch, data) abort
  if empty(a:data) | return | endif
  " If data contains a newline, split + buffer the last (partial) part.
  if a:data =~# "\n"
    let parts = split(s:vim_buf . a:data, "\n", 1)
    let s:vim_buf = remove(parts, -1)
    for line in parts
      if !empty(line) | call s:handle_msg(line) | endif
    endfor
  else
    " No newline → Vim already split for us. Prepend any pending buffer.
    let line = empty(s:vim_buf) ? a:data : s:vim_buf . a:data
    let s:vim_buf = ''
    if !empty(line) | call s:handle_msg(line) | endif
  endif
endfun

function! zai#rpc#connect_vim() abort
  if !has('job') || !has('channel')
    echom '[zaivim] this Vim lacks +job or +channel; cannot start engine'
    return
  endif
  if empty(g:zaivim_engine_path)
    echom '[zaivim] g:zaivim_engine_path is empty; set it to the zaivim CLI path'
    return
  endif
  if !executable(g:zaivim_engine_path)
    echom '[zaivim] engine binary not executable: ' . g:zaivim_engine_path . ' (check PATH or set g:zaivim_engine_path)'
    return
  endif
  let s:ready = 0
  let s:vim_buf = ''
  let opts = {'out_cb': function('s:vim_stdout'), 'err_cb': function('s:err_cb'), 'exit_cb': function('s:exit_cb'), 'in_io': 'pipe', 'out_io': 'pipe', 'err_io': 'pipe'}
  let s:job = job_start([g:zaivim_engine_path, 'vim-rpc-server'], opts)
  if job_status(s:job) !=# 'run'
    echom '[zaivim] job_start failed for: ' . g:zaivim_engine_path . ' vim-rpc-server'
    let s:job = v:null | return
  endif
  let s:channel = job_getchannel(s:job)
endfun

function! zai#rpc#connect_nvim() abort
  if empty(g:zaivim_engine_path)
    echom '[zaivim] g:zaivim_engine_path is empty; set it to the zaivim CLI path'
    return
  endif
  if !executable(g:zaivim_engine_path)
    echom '[zaivim] engine binary not executable: ' . g:zaivim_engine_path . ' (check PATH or set g:zaivim_engine_path)'
    return
  endif
  let s:ready = 0
  let s:nvim_buf = ''
  let s:job = jobstart([g:zaivim_engine_path, 'vim-rpc-server'], {'on_stdout': function('s:nvim_stdout'), 'on_stderr': function('s:err_cb'), 'on_exit': function('s:exit_cb')})
endfun

" Neovim on_stdout delivers data as a list of lines (newlines stripped).
" The LAST element is the partial line buffered for the next call (often
" empty if data ended on a line boundary). The previous implementation
" split by "\n", but Neovim's list elements don't contain newlines — so
" the response was getting buffered in s:nvim_buf forever and never
" dispatched to handlers.
function! s:nvim_stdout(j, d, e) abort
  if empty(a:d) | return | endif
  let l:lines = a:d[:-2]
  if !empty(s:nvim_buf) && !empty(l:lines)
    let l:lines[0] = s:nvim_buf . l:lines[0]
  endif
  let s:nvim_buf = a:d[-1]
  for l:line in l:lines
    if !empty(l:line) | call s:handle_msg(l:line) | endif
  endfor
endfun

" Log stderr from vim-rpc-server to message history (:messages to view)
function! s:err_cb(...) abort
  if a:0 < 2 | return | endif
  let data = type(a:2) == v:t_list ? join(a:2, '') : a:2
  if !empty(data) | echom '[zaivim:stderr] ' . data | endif
endfun
function! s:exit_cb(...) abort
  let s:job = v:null
  let s:channel = v:null
  let s:pending = {}
endfunction

function! zai#rpc#connect() abort
  if has('nvim') | call zai#rpc#connect_nvim() | else | call zai#rpc#connect_vim() | endif
endfun

function! s:send_raw(raw) abort
  if has('nvim') && s:job != v:null | call jobsend(s:job, a:raw)
  elseif s:channel != v:null | call ch_sendraw(s:channel, a:raw) | endif
endfun

function! s:on_ready() abort
  let s:ready = 1
  echom '[zaivim] engine ready'
  for item in s:queue
    call s:send_raw(item)
  endfor | let s:queue = []
endfun

function! zai#rpc#request(method, params, ...) abort
  let id = s:next_id | let s:next_id += 1
  if a:0 > 0 | let s:pending[id] = a:1 | endif
  let msg = s:enc({'jsonrpc': '2.0', 'id': id, 'method': a:method, 'params': a:params}) . "\n"
  if s:ready | call s:send_raw(msg) | else | call add(s:queue, msg) | endif
endfun

function! zai#rpc#notify(method, params) abort
  let msg = s:enc({'jsonrpc': '2.0', 'method': a:method, 'params': a:params}) . "\n"
  if s:ready | call s:send_raw(msg) | else | call add(s:queue, msg) | endif
endfun

function! zai#rpc#close() abort
  if s:job != v:null
    if has('nvim') | call jobstop(s:job) | else | call job_stop(s:job) | endif
  endif | let s:job = v:null | let s:channel = v:null | let s:pending = {}
endfun
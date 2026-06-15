let s:job = v:null | let s:channel = v:null | let s:pending = {} | let s:next_id = 1

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
    endif
  endif
endfun

" Wrapper for Vim 8.x JSON mode: out_cb(channel, msg) where msg is
" already a decoded dict. Normalize back to JSON string for handle_msg.
function! s:vim_out_cb(ch, msg) abort
  let raw = type(a:msg) == v:t_dict ? json_encode(a:msg) : a:msg
  call s:handle_msg(raw)
endfun

function! zai#rpc#connect_vim() abort
  if !has('job') || !has('channel') | return | endif
  let s:job = job_start([g:zaivim_engine_path, 'vim-rpc-server'], {'mode': 'json', 'out_cb': function('s:vim_out_cb'), 'err_cb': function('s:err_cb'), 'exit_cb': function('s:exit_cb')})
  let s:channel = job_getchannel(s:job)
endfun

function! zai#rpc#connect_nvim() abort
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

function! zai#rpc#request(method, params, ...) abort
  let id = s:next_id | let s:next_id += 1
  if a:0 > 0 | let s:pending[id] = a:1 | endif
  let msg = {'jsonrpc': '2.0', 'id': id, 'method': a:method, 'params': a:params}
  if has('nvim') && s:job != v:null | call jobsend(s:job, s:enc(msg) . "\n")
  elseif s:channel != v:null | call ch_sendexpr(s:channel, msg) | endif
endfun

function! zai#rpc#notify(method, params) abort
  let msg = {'jsonrpc': '2.0', 'method': a:method, 'params': a:params}
  if has('nvim') && s:job != v:null | call jobsend(s:job, s:enc(msg) . "\n")
  elseif s:channel != v:null | call ch_sendexpr(s:channel, msg) | endif
endfun

function! zai#rpc#close() abort
  if s:job != v:null
    if has('nvim') | call jobstop(s:job) | else | call job_stop(s:job) | endif
  endif | let s:job = v:null | let s:channel = v:null | let s:pending = {}
endfun
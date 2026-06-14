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
    let cb = get(s:pending, msg.id, v:null)
    if cb != v:null | call cb(msg) | unlet s:pending[msg.id] | endif
  elseif has_key(msg, 'method')
    if msg.method ==# '$/chat/chunk' | call zai#chat#on_chunk(msg.params)
    elseif msg.method ==# '$/notification' | call zai#chat#on_notification(msg.params)
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
  let s:job = job_start([g:zaivim_engine_path, 'vim-rpc-server'], {'mode': 'json', 'out_cb': function('s:vim_out_cb'), 'err_cb': function('s:err_cb'), 'exit_cb': function('s:exit_cb'), 'in_io': 'file', 'in_name': '/dev/null'})
  let s:channel = job_getchannel(s:job)
endfun

function! zai#rpc#connect_nvim() abort
  let s:nvim_buf = ''
  let s:job = jobstart([g:zaivim_engine_path, 'vim-rpc-server'], {'on_stdout': function('s:nvim_stdout'), 'on_stderr': function('s:err_cb'), 'on_exit': function('s:exit_cb')})
endfun

function! s:nvim_stdout(j, d, e) abort
  let s:nvim_buf .= join(a:d, '')
  let lines = split(s:nvim_buf, "\n", 1)
  let s:nvim_buf = remove(lines, -1)
  for l in lines | call s:handle_msg(l) | endfor
endfun

function! s:err_cb(...) abort | endfun
function! s:exit_cb(j, s) abort | let s:job = v:null | let s:channel = v:null | endfun

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
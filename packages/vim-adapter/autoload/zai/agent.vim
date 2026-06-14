scriptencoding utf-8
let s:agents = {} | let s:current_id = v:null

function! zai#agent#start(args) abort
  call zai#rpc#connect()
  call zai#rpc#request('agent.create', {'persona': empty(a:args) ? {} : {'name': a:args}}, function('s:on_created'))
endfun

function! s:on_created(msg) abort
  if has_key(a:msg, 'error') | return | endif
  let id = a:msg.result.agentId
  belowright 10new
  setlocal buftype=nofile bufhidden=hide nobuflisted noswapfile filetype=zaivim-agent
  let s:agents[id] = {'bufnr': bufnr('%'), 'agentId': id, 'status': 'idle'}
  let s:current_id = id
  nnoremap <buffer> <C-c> :call <SID>cancel()<CR>
  call appendbufline(bufnr('%'), '$', '🤖 Agent ' . id)
  call appendbufline(bufnr('%'), '$', '--- Activity ---')
endfun

function! zai#agent#on_progress(event) abort
  if s:current_id == v:null || !has_key(s:agents, s:current_id) | return | endif
  let a = s:agents[s:current_id]
  let a.status = get(a:event, 'status', 'running')
  call appendbufline(a.bufnr, '$', '🔄 ' . a.status)
endfun

function! zai#agent#cancel(id) abort
  if a:id == v:null | return | endif
  call zai#rpc#request('agent.cancel', {'agentId': a:id})
  if has_key(s:agents, a:id)
    call appendbufline(s:agents[a:id].bufnr, '$', '❌ 已取消')
  endif
endfun

function! s:cancel() abort
  call zai#agent#cancel(s:current_id)
endfun
scriptencoding utf-8
let s:icons = {'request':'📤','thinking':'🤔','tool':'🔧','response':'💬','done':'✅','error':'❌'}

function! zai#sessions#open() abort
  belowright 8new
  setlocal buftype=nofile bufhidden=hide nobuflisted noswapfile filetype=zaivim-sessions
  call setline(1, '=== Sessions ===')
  nnoremap <buffer> <silent> <CR> :call <SID>select()<CR>
endfun

function! zai#sessions#render(chats) abort
  let winid = bufwinnr('zaivim-sessions')
  if winid == -1 | return | endif
  let lines = ['=== Sessions ===']
  for [id, c] in items(a:chats)
    call add(lines, get(s:icons,get(c,'phase',v:null),'⏸') . ' ' . id . ' · ' . (get(c,'elapsed_ms',0)/1000) . 's · ' . get(c,'tokens_out',0) . '↓')
  endfor
  execute winid . 'wincmd w' | setlocal modifiable
  call setline(1, lines) | setlocal nomodifiable
endfun

function! s:select() abort
  let parts = split(getline('.'), ' · ')
  if len(parts) < 1 | return | endif
  call zai#chat#switch(substitute(parts[0], '^[^ ]\+ ', '', ''))
endfun
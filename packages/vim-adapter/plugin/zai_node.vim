" zai.vim Node.js adapter — plugin entry
" Growth phase: full VimScript integration with JSON-RPC over job_start
if exists('g:loaded_zai_node')
  finish
endif
let g:loaded_zai_node = 1

command! -nargs=* ZaiChat call zai#chat#start(<q-args>)
command! -nargs=* ZaiAgent call zai#agent#start(<q-args>)

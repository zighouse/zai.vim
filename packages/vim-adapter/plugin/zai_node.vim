if exists('g:loaded_zai_node') | finish | endif | let g:loaded_zai_node = 1
if !exists('g:zaivim_engine_path') | let g:zaivim_engine_path = executable('zaivim') ? 'zaivim' : '' | endif
if !exists('g:zaivim_backend') | let g:zaivim_backend = 'node' | endif
if !exists('g:zaivim_chat_default_mode') | let g:zaivim_chat_default_mode = 'compact' | endif
command! -nargs=* ZaiChat call zai#chat#start(<q-args>)
command! -nargs=* ZaiAgent call zai#agent#start(<q-args>)
command! -nargs=0 ZaiSessions call zai#sessions#open()
command! -nargs=0 ZaiImportConfig call zai#rpc#notify('config.reload', {})
augroup zaivim_cleanup | autocmd! | autocmd VimLeavePre * call zai#rpc#close() | augroup END
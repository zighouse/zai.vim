if exists('g:loaded_zai_node') | finish | endif | let g:loaded_zai_node = 1
if !exists('g:zaivim_engine_path') | let g:zaivim_engine_path = executable('zaivim') ? 'zaivim' : '' | endif
if !exists('g:zaivim_backend') | let g:zaivim_backend = 'node' | endif
if !exists('g:zaivim_chat_default_mode') | let g:zaivim_chat_default_mode = 'compact' | endif
" When 0 (default), the plugin installs <leader>z* convenience mappings that
" match the legacy autoload/zai/ plugin so users migrating from the Python
" version keep their muscle memory. Set to 1 to disable and bind manually
" via the <Plug>Zai* targets below.
if !exists('g:zaivim_no_default_mappings') | let g:zaivim_no_default_mappings = 0 | endif

" `:Zai` is the legacy alias for `:ZaiChat` — keeps muscle memory from the
" old Python plugin (`plugin/zai.vim` defined `:Zai call zai#Open()`).
" Story 4.1.2 P1 Q1 decision.
command! -nargs=* Zai call zai#chat#start(<q-args>)
command! -nargs=* ZaiChat call zai#chat#start(<q-args>)
command! -nargs=* ZaiAgent call zai#agent#start(<q-args>)
command! -nargs=0 ZaiSessions call zai#sessions#open()
command! -nargs=0 ZaiImportConfig call zai#rpc#notify('config.reload', {})

" Story 4.1.2 P0 — selection/buffer/file attach. Legacy `:ZaiAdd` family.
" `:ZaiAdd` is a -range command so both visual selection and `:line1,line2`
" invocations work; without a range it acts on the current line only (the
" user typically invokes via `:'<,'>ZaiAdd` from visual mode).
command! -range ZaiAdd call zai#attach#range(<line1>, <line2>)
command! -range ZaiAddRange call zai#attach#range(<line1>, <line2>)
command! -nargs=0 ZaiAddBuffer call zai#attach#buffer()
command! -nargs=1 -complete=file ZaiAddFile call zai#attach#file(<f-args>)

" <Plug> mapping targets — users can rebind freely. These mirror the legacy
" autoload/zai/plugin/zai.vim mapping names so vimrc configs migrate intact.
vnoremap <Plug>ZaiAdd :<C-u>call zai#attach#range(line("'<"), line("'>"))<CR>

if !g:zaivim_no_default_mappings
  vmap <silent> <leader>za <Plug>ZaiAdd
endif

augroup zaivim_cleanup | autocmd! | autocmd VimLeavePre * call zai#rpc#close() | augroup END
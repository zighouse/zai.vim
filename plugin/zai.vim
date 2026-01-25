if exists('g:loaded_zai') || &compatible
    finish
endif
let g:loaded_zai = 1

" Load helptags
let s:doc = expand('<sfile>:p:h:h') . '/doc/zai.txt'
if filereadable(s:doc)
    execute 'helptags' fnameescape(fnamemodify(s:doc, ':h'))
endif

" Check and install dependencies
function! s:CheckDependencies() abort
    if !executable('python3')
        echohl WarningMsg
        echomsg "Zai is dependent on Python3. Please install Python3 first."
        echohl None
        return
    endif

    let s:install_script = expand('<sfile>:p:h:h') . '/install.py'
    if filereadable(s:install_script)
        silent! call system('python3 ' . shellescape(s:install_script))
    endif
endfunction

if !exists('g:zai_auto_install_deps')
    let g:zai_auto_install_deps = 1
endif

if g:zai_auto_install_deps
    call s:CheckDependencies()
endif

command! Zai call zai#Open()
command! -range ZaiAdd call zai#AddRange(<line1>, <line2>)
command! ZaiGo call zai#Go()
command! ZaiClose call zai#Close()
command! -nargs=1 ZaiComplete call zai#Complete(<args>)
command! ZaiLoad call zai#Load()
command! ZaiConfig call zai#EditConfig()
command! ZaiOpenLog call zai#OpenLog()
command! -nargs=1 ZaiGrepLog call zai#GrepLog('<args>')
command! -bang -nargs=+ -complete=dir ZaiRg call zai#util#Rg(<q-args>)
command! ZaiGotoURL call zai#chat#GotoURL()
command! ZaiDownloadURL call zai#chat#DownloadURL()
command! ZaiOpenPath call zai#chat#OpenPath()

nmap <Plug>Zai :Zai<CR>
nmap <Plug>ZaiGo :ZaiGo<CR>
vmap <Plug>ZaiAdd :<C-u>call zai#Add()<CR>
nmap <Plug>ZaiComplete :ZaiComplete<CR>
nmap <Plug>ZaiLoad :ZaiLoad<CR>
nmap <Plug>ZaiGotoURL :ZaiGotoURL<CR>
nmap <Plug>ZaiDownloadURL :ZaiDownloadURL<CR>
nmap <Plug>ZaiOpenPath :ZaiOpenPath<CR>

nmap <silent> <leader>zo <Plug>Zai
nmap <silent> <leader>zg <Plug>ZaiGotoURL
nmap <silent> <leader>zX :call zai#Close()<CR>
vmap <silent> <leader>za <Plug>ZaiAdd
nmap <silent> <leader>zf :call zai#Complete(0)<CR>
inoremap <silent> <C-F> <C-O>:call zai#Complete(1)<CR>
nmap <silent> <leader>zl <Plug>ZaiLoad
nmap <silent> <leader>zd <Plug>ZaiDownloadURL
nmap <silent> <leader>zv <Plug>ZaiOpenPath

" ASR (Automatic Speech Recognition) setup
if !exists('g:zai_auto_enable_asr')
    let g:zai_auto_enable_asr = 0
endif

if g:zai_auto_enable_asr
    " Auto-enable ASR functionality
    silent! call zai#asr#setup()
endif

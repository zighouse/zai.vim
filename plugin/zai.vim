" Zai.Vim - AI Assistant Integration for Vim
" Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
"
" Licensed under the MIT License
"
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
    if executable('python3')
        let s:python_cmd = 'python3'
    elseif executable('python')
        let s:python_version = systemlist('python --version')[0]
        if s:python_version =~ '^Python 3\.'
            let s:python_cmd = 'python'
        else
        echohl WarningMsg
            echomsg "Zai requires Python 3.x. Found: " . s:python_version . ". Please install Python 3."
            echohl None
            return
        endif
    else
        echohl WarningMsg
        echomsg "Zai is dependent on Python 3.x. Please install Python 3 first."
        echohl None
        return
    endif

    let s:install_script = expand('<sfile>:p:h:h') . '/install.py'
    if filereadable(s:install_script)
        silent! call system(s:python_cmd . ' ' . shellescape(s:install_script))
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
nmap <Plug>ZaiLoad :ZaiLoad<CR>
nmap <Plug>ZaiGotoURL :ZaiGotoURL<CR>
nmap <Plug>ZaiDownloadURL :ZaiDownloadURL<CR>
nmap <Plug>ZaiOpenPath :ZaiOpenPath<CR>

nmap <silent> <leader>zo <Plug>Zai
nmap <silent> <leader>zg <Plug>ZaiGotoURL
nmap <silent> <leader>zX :call zai#Close()<CR>
vmap <silent> <leader>za <Plug>ZaiAdd
nmap <silent> <leader>zl <Plug>ZaiLoad
nmap <silent> <leader>zd <Plug>ZaiDownloadURL
nmap <silent> <leader>zv <Plug>ZaiOpenPath

" :AI command group — shell status, audit query, policy display
function! s:AICommand(cmd, ...) abort
    if a:cmd ==# 'shell' && a:0 >= 1 && a:1 ==# 'status'
        call zai#shell#Status()
    elseif a:cmd ==# 'audit'
        call call('zai#shell#Audit', a:000[1:])
    elseif a:cmd ==# 'policy'
        call zai#shell#Policy()
    else
        echohl WarningMsg
        echomsg 'Usage: :AI shell status | :AI audit [session_id] | :AI policy'
        echohl None
    endif
endfunction

command! -nargs=* AI call s:AICommand(<f-args>)

" Skill system commands
command! -nargs=? -complete=customlist,zai#skill#CompleteNames ZaiSkillList call zai#skill#List(<f-args>)
command! -nargs=1 -complete=customlist,zai#skill#CompleteNames ZaiSkillInfo call zai#skill#Info(<f-args>)
command! -nargs=1 -complete=customlist,zai#skill#CompleteNames ZaiSkillEnable call zai#skill#Enable(<f-args>)
command! -nargs=1 -complete=customlist,zai#skill#CompleteNames ZaiSkillDisable call zai#skill#Disable(<f-args>)
command! -nargs=1 -complete=customlist,zai#skill#CompleteNames ZaiSkillUninstall call zai#skill#Uninstall(<f-args>)

" ASR (Automatic Speech Recognition) setup
if !exists('g:zai_auto_enable_asr')
    let g:zai_auto_enable_asr = 0
endif

if g:zai_auto_enable_asr
    " Auto-enable ASR functionality
    silent! call zai#asr#setup()
endif

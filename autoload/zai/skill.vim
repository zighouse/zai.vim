" zai/skill.vim — Skill system Vim commands
" Provides :ZaiSkillList, :ZaiSkillInfo, :ZaiSkillEnable, :ZaiSkillDisable,
"           :ZaiSkillUninstall, :ZaiSkillInstall

let s:script = expand('<sfile>:h:h:h') . '/python3/skills/skill_vim.py'
let s:py = executable('python3') ? 'python3' : 'python'

function! s:sys_call(args) abort
    let l:cmd = s:py . ' ' . shellescape(s:script) . ' ' . a:args
    let l:out = system(l:cmd)
    if v:shell_error != 0
        echohl ErrorMsg
        echomsg trim(l:out)
        echohl None
        return ''
    endif
    return trim(l:out)
endfunction

" ---------------------------------------------------------------------------
" :ZaiSkillList [domain]
" ---------------------------------------------------------------------------
function! zai#skill#List(...) abort
    let l:domain = a:0 > 0 ? shellescape(a:1) : ''
    let l:out = s:sys_call('list ' . l:domain)
    if empty(l:out)
        return
    endif
    echo l:out
endfunction

" ---------------------------------------------------------------------------
" :ZaiSkillInfo <name>
" ---------------------------------------------------------------------------
function! zai#skill#Info(name) abort
    let l:out = s:sys_call('info ' . shellescape(a:name))
    if empty(l:out)
        return
    endif
    echo l:out
endfunction

" ---------------------------------------------------------------------------
" :ZaiSkillEnable <name>
" ---------------------------------------------------------------------------
function! zai#skill#Enable(name) abort
    let l:out = s:sys_call('enable ' . shellescape(a:name))
    if empty(l:out)
        return
    endif
    echohl MoreMsg
    echom l:out
    echohl None
endfunction

" ---------------------------------------------------------------------------
" :ZaiSkillDisable <name>
" ---------------------------------------------------------------------------
function! zai#skill#Disable(name) abort
    let l:out = s:sys_call('disable ' . shellescape(a:name))
    if empty(l:out)
        return
    endif
    echohl MoreMsg
    echom l:out
    echohl None
endfunction

" ---------------------------------------------------------------------------
" :ZaiSkillUninstall <name>
" ---------------------------------------------------------------------------
function! zai#skill#Uninstall(name) abort
    let l:confirm = input('Uninstall skill ''' . a:name . '''? [y/n] ')
    if l:confirm !~? '^y\%[es]$'
        echohl WarningMsg
        echom 'Uninstall cancelled.'
        echohl None
        return
    endif
    let l:out = s:sys_call('uninstall ' . shellescape(a:name))
    if empty(l:out)
        return
    endif
    echohl MoreMsg
    echom l:out
    echohl None
endfunction

" ---------------------------------------------------------------------------
" :ZaiSkillInstall <url> [checksum]
" ---------------------------------------------------------------------------
function! zai#skill#Install(url, ...) abort
    " If no checksum provided, warn and require confirmation (AC #7, NFR10)
    if a:0 == 0 || empty(a:1)
        echohl WarningMsg
        let l:confirm = input('No integrity checksum provided. Install at your own risk? [y/n] ')
        echohl None
        if l:confirm !~? '^y\%[es]$'
            echohl WarningMsg
            echom 'Install cancelled.'
            echohl None
            return
        endif
    endif
    let l:args = 'install ' . shellescape(a:url)
    if a:0 > 0 && !empty(a:1)
        let l:args .= ' ' . shellescape(a:1)
    endif
    let l:out = s:sys_call(l:args)
    if empty(l:out)
        return
    endif
    echohl MoreMsg
    echom l:out
    echohl None
endfunction
" ---------------------------------------------------------------------------
function! zai#skill#CompleteNames(arglead, cmdline, cursorpos) abort
    let l:out = s:sys_call('list')
    if empty(l:out)
        return []
    endif
    let l:names = []
    for l:line in split(l:out, "\n")[1:]
        let l:trimmed = substitute(l:line, '^\s*\(\[.*\]\)\?', '', '')
        let l:name = split(l:trimmed)[0]
        " Use stridx for literal prefix match (no regex injection)
        if !empty(l:name) && stridx(l:name, a:arglead) == 0
            call add(l:names, l:name)
        endif
    endfor
    return l:names
endfunction

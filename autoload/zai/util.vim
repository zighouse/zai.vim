let s:plugin_root = expand('<sfile>:h:h:h')
let s:path_sep = has('win32') ? '\' : '/'
let s:extra_fzf_opts = [
                        \ '--bind', 'ctrl-h:preview-top,ctrl-l:preview-bottom',
                        \ '--bind', 'ctrl-p:preview-page-up,ctrl-n:preview-page-down',
                        \ '--bind', 'ctrl-e:preview-up,ctrl-y:preview-down',
                        \ '--bind', 'ctrl-g:first,ctrl-d:last',
                        \ '--bind', 'ctrl-b:page-up,ctrl-f:page-down',
                        \ '--bind', 'ctrl-j:down,ctrl-k:up',
                        \ '--bind', 'ctrl-/:toggle-preview',
                        \ ]

if exists('g:zai_log_dir')
    let s:log_dir = fnameescape(g:zai_log_dir)
else
    if has('win32')
        let s:log_dir = expand('~/AppData/Local/Zighouse/Zai/Log')
    else
        let s:log_dir = expand('~/.local/share/zai/log')
    endif
endif

function! zai#util#log_path()
    return s:log_dir
endfunction

function! zai#util#get_file_type()
   if !empty(&filetype)
       return &filetype
   elseif !empty(&syntax)
       return &syntax
   else
       return expand('%:e')
   endif
endfunction

" Define available character sets for block markers
let s:fence_chars = ['`', '\"', "\'", '~', '#', '%', '@', '-', '+', '=', '*', '^', '_']

" Generate a mixed character marker for fenced block quoting
function! s:generate_mixed_fence(length)
    let l:marker = ''
    for i in range(a:length)
        let l:marker .= s:fence_chars[rand() % len(s:fence_chars)]
    endfor
    return l:marker
endfunction

" Check if the marker conflicts with the quoting text
function! s:is_marker_conflicted(text, marker)
    if type(a:text) == v:t_list
        let l:meet = 0
        for l:line in a:text
            if trim(l:line) == a:marker
                let l:meet = 1
                break
            endif
        endfor
        return l:meet
    else
        return stridx(a:text, a:marker) != -1
    endif
endfunction

" Generate a unique fence marker for markdown code block
function! zai#util#get_fence_marker(text)
    let l:length = 3
    while 1
        " First try repeating characters
        for l:char in s:fence_chars
            let l:marker = repeat(l:char, l:length)
            if !s:is_marker_conflicted(a:text, l:marker)
                return l:marker
            endif
        endfor

        " Secondly, try mixed characters
        let l:marker = s:generate_mixed_fence(l:length)
        if !s:is_marker_conflicted(a:text, l:marker)
            return l:marker
        endif

        " Increase length and retry
        let l:length += 1
    endwhile
endfunction

let s:sig_chars = [
            \ 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
            \ 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
            \ '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
            \ ]
" Generate a unique signature for shell style block-mode quotation.
function! zai#util#get_block_sign(text)
    let l:length = 5
    while 1
        " Capital the fist letter
        let l:marker = s:sig_chars[rand() % 26]
        " the rest can be any \w character
        for i in range(l:length - 1)
            let l:marker .= s:sig_chars[rand() % len(s:sig_chars)]
        endfor

        if !s:is_marker_conflicted(a:text, l:marker)
            return l:marker
        endif

        " Increase length and retry
        let l:length += 1
    endwhile
endfunction

" remove leading and trailing empty strings of a list
function! zai#util#strip_list(lst)
	let l:lst = copy(a:lst)
    " remove leading empty strings
    while !empty(l:lst) && (l:lst[0] ==# '' || matchstr(l:lst[0], '\S') ==# '')
        call remove(l:lst, 0)
    endwhile

    " remove trailing empty strings
    while !empty(l:lst) && (l:lst[-1] ==# '' || matchstr(l:lst[-1], '\S') ==# '')
        call remove(l:lst, -1)
    endwhile

    return l:lst
endfunction

function! s:assistants_path()
    let l:python_lines = [
                \ 'import sys',
                \ 'sys.path.insert(0, \"' . s:plugin_root . s:path_sep . 'python3\")',
                \ 'from config import config_path_assistants',
                \ 'print(config_path_assistants())'
                \]
    let l:python_code = join(l:python_lines, "\n")
    let l:config_path = trim(system('python3 -c "' . l:python_code . '"'))
    return l:config_path
endfunction

function! zai#util#EditAssistants()
    let l:config_file = s:assistants_path()
    execute 'new ' . l:config_file
    if !filereadable(l:config_file)
        setfiletype json
    endif
endfunction

function! s:fzf_window_opts(list_width)
    " smart showing preview
    let l:term_width = &columns
    let l:term_height = &lines
    let l:list_width = a:list_width
    let l:max_list_height = 30
    let l:min_preview_width = 50
    let l:max_preview_width = 120
    let l:border_width = 10
    let l:border_height = 4
    if l:term_width < l:list_width + l:min_preview_width + l:border_width
        let l:preview_width = 0
        let l:preview_window = 'hidden,right:70%'
    else
        if l:term_width < l:list_width + l:max_preview_width + l:border_width
            let l:preview_width = l:term_width - l:list_width - l:border_width
            let l:preview_window = 'right:' . l:preview_width . ',nohidden'
        else
            let l:preview_width = l:max_preview_width
            let l:preview_window = 'right:' . l:preview_width . ',nohidden'
        endif
    endif
    let l:opts = fzf#vim#with_preview()
    let l:opts.options = l:opts.options + [ 
                \ '--preview-window', l:preview_window,
                \ '--prompt', 'Zai Grep> '
                \ ]
    if !has_key(l:opts, 'window')
        let l:opts.window = {}
    endif
    let l:opts.window.width = l:list_width + l:preview_width + l:border_width
    let l:opts.window.height = min([l:term_height, l:max_list_height + l:border_height])
    if !exists('$FZF_DEFAULT_OPTS') || $FZF_DEFAULT_OPTS !~# '--bind'
        let l:opts.options = l:opts.options + s:extra_fzf_opts
    endif
    return l:opts
endfunction

function! s:open_fzf_files(dir) abort
    if !exists('g:loaded_fzf')
        echohl ErrorMsg
        echo 'Error: fzf.vim is required but not installed.'
        echohl None
        return
    endif

    try
        call fzf#vim#files(a:dir, s:fzf_window_opts(30))
    catch /^Vim\%((\a\+)\)\=:E/
        echohl ErrorMsg
        echo 'Failed to open fzf: ' . v:exception
        echohl None
    endtry
endfunction

function! s:open_fzf_grep(dir, pat) abort
    if empty(a:pat) | return | endif
    if !exists('g:loaded_fzf')
        echohl ErrorMsg
        echo 'Error: fzf.vim is required but not installed.'
        echohl None
        return
    endif

    try
        let l:cmd = 'rg --column --line-number --no-heading --color=always --smart-case '
                    \ . shellescape(a:pat)
        let l:opts = extend(s:fzf_window_opts(40), {'dir': a:dir})
        call fzf#vim#grep(l:cmd, 1, l:opts, 1)
    catch /^Vim\%((\a\+)\)\=:E/
        echohl ErrorMsg
        echo 'Failed to open fzf: ' . v:exception
        echohl None
    endtry
endfunction

function zai#util#OpenLog() abort
    try
        if exists('g:loaded_fzf') && exists('*fzf#run')
            call s:open_fzf_files(s:log_dir)
        elseif exists('g:loaded_nerd_tree') && exists(':NERDTree') == 2
            execute 'NERDTree ' . s:log_dir
        else
            execute 'edit ' . s:log_dir
        endif
    catch /^Vim\%((\a\+)\)\=:E/
        echohl ErrorMsg
        echomsg 'Filed open log directory: ' . v:exception
        echohl None
        execute 'edit ' . s:log_dir
    endtry
endfunction

function s:grep_dir(pat, dir) abort
    if exists('g:loaded_fzf') && exists('*fzf#run')
        call s:open_fzf_grep(a:dir, a:pat)
        return
    endif

    if executable('rg')
        let l:cmd  = 'rg --vimgrep --smart-case '.shellescape(a:pat)
        let l:parser = 'rg'
    elseif executable('grep')
        let l:cmd  = 'grep -rn '.shellescape(a:pat)
        let l:parser = 'grep'
    elseif has('win32') && executable('findstr')
        " /n for line-num; findstr uses regexp, should escape key-words
        let l:esc = substitute(a:pat, '[\\^$.*+?()|{}]', '\\\\&', 'g')
        let l:cmd  = 'findstr /n /r /c:"'.l:esc.'"'
        let l:parser = 'findstr'
    else
        echohl ErrorMsg
        echomsg 'No rg/grep/findstr found!'
        echohl None
        return
    endif
    let l:cmd .= ' '.fnameescape(a:dir)

    let l:lines = systemlist(l:cmd)
    if v:shell_error || empty(l:lines)
        echohl ErrorMsg
        echomsg 'No match: '.a:pat
        echohl None
        return
    endif

    let l:qfl = []
    for l:line in l:lines
        if l:parser ==# 'rg'
            let p = matchlist(l:line, '^\(.\+\):\(\d\+\):\(\d\+\):\(.*\)')
            if !empty(p)
                call add(l:qfl, {'filename':p[1],'lnum':str2nr(p[2]),'col':str2nr(p[3]),'text':p[4]})
            endif

        elseif l:parser ==# 'grep'
            let p = matchlist(l:line, '^\(.\+\):\(\d\+\):\(.*\)')
            if !empty(p)
                call add(l:qfl, {'filename':p[1],'lnum':str2nr(p[2]),'col':1,'text':p[3]})
            endif

        else " findstr
            let p = matchlist(l:line, '^\(.\+\):\(\d\+\):\(.*\)')
            if !empty(p)
                call add(l:qfl, {'filename':p[1],'lnum':str2nr(p[2]),'col':1,'text':p[3]})
            endif
        endif
    endfor

    call setqflist(l:qfl, 'r')
    copen | execute 'silent! wincmd J'
endfunction

function! zai#util#GrepLog(pat) abort
    call s:grep_dir(a:pat, s:log_dir)
endfunction

function! zai#util#Rg(args)
    " uses shellslash parse args for quoes and escapes
    let l:opts = []
    let l:arg = ''
    let l:escaping = 0
    let l:quoting = 0

    for l:char in split(a:args, '\zs')
        if l:escaping
            let l:arg .= l:char
            let l:escaping = 0
        elseif l:char == '\'
            let l:escaping = 1
        elseif l:char == '"'
            let l:quoting = !l:quoting
        elseif l:char == ' ' && !l:quoting
            if l:arg != ''
                let l:opts += [l:arg]
                let l:arg = ''
            endif
        else
            let l:arg .= l:char
        endif
    endfor
    
    if l:arg != ''
        let l:opts += [l:arg]
    endif

    if len(l:opts) > 1
        let l:pat = join(l:opts[0:-2], ' ')
        let l:dir = l:opts[-1]
    elseif len(l:opts) == 1
        let l:pat = l:opts[0]
        let l:dir = '.'
    else
        let l:pat = ''
        let l:dir = '.'
    endif

    call s:grep_dir(l:pat, l:dir)
endfunction

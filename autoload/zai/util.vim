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
        let l:win_width = l:list_width + l:max_preview_width + l:border_width
        if l:term_width < l:win_width
            let l:preview_width = l:term_width - l:list_width - l:border_width
            let l:preview_window = 'right:' . l:preview_width . ',nohidden'
        elseif l:win_width < l:term_width * 0.62
            let l:rate = (l:term_width - l:border_width) * 0.62 / (l:win_width - l:border_width)
            let l:list_width = float2nr(l:list_width * l:rate)
            let l:max_preview_width = float2nr(l:max_preview_width * l:rate)
            let l:preview_width = l:max_preview_width
            let l:preview_window = 'right:' . l:preview_width . ',nohidden'
        else
            let l:preview_width = l:max_preview_width
            let l:preview_window = 'right:' . l:preview_width . ',nohidden'
        endif
    endif
    if l:max_list_height + l:border_height < l:term_height * 0.62
        let l:max_list_height = float2nr(l:term_height * 0.62 - l:border_height)
    endif
    let l:opts = fzf#vim#with_preview()
    let l:preview_cmd = 'filename=$(echo {} | cut -d: -f1); ' .
                \ 'if command -v enca >/dev/null 2>&1; then ' .
                \ 'encoding=$(enca -L chinese -i "$filename" 2>/dev/null); ' .
                \ 'iconv -c -f "$encoding" -t utf-8 "$filename" | bat --color=always --style=numbers -l "$(basename "$filename" | sed "s/.*\.//")" - || ' .
                \ 'bat --color=always --style=numbers "$filename" 2>/dev/null || cat "$filename"; ' .
                \ 'else ' .
                \ 'bat --color=always --style=numbers "$filename" 2>/dev/null || cat "$filename"; ' .
                \ 'fi'

    let l:opts.options = l:opts.options + [ 
                \ '--preview-window', 'right:70%',
                \ '--prompt', 'Zai Grep> ',
                \ '--preview', l:preview_cmd
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
        call fzf#vim#grep(l:cmd, 1, l:opts, 0)
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

function! zai#util#GetURL()
    " get url under cursor
    let line_text = getline('.')
    let col_pos = col('.')
    let url_pattern = '\v(https?|ftp|file)://[[:alnum:]-._~:/?#\[\]@!$&''*+,;%=]+[^[:space:]()]'
    let start = 0
    while 1
        let match_start = match(line_text, url_pattern, start)
        if match_start == -1
            return ''
        endif
        let match_end = matchend(line_text, url_pattern, start)
        " check cursor range
        if col_pos >= match_start + 1 && col_pos <= match_end
            let url = matchstr(line_text, url_pattern, start)
            return url
        endif
        let start = match_end
    endwhile
endfunction

" 主函数：智能提取光标处的路径并检查是否存在
function! zai#util#GetPath()
    "let path = GetPathUnderCursor()
    let path = GetEnhancedPathUnderCursor()
    if empty(path)
        return ''
    endif
    if filereadable(path) || filewritable(path) || isdirectory(path)
        return path
    endif
    return ''
endfunction

" 核心函数：提取光标处的路径字符串
function! GetPathUnderCursor()
    let line_text = getline('.')
    let col_pos = col('.') - 1  " 转换为 0-based
    
    " 定义路径模式
    " 匹配以 / 开头的绝对路径，或包含 ~/ 的家目录路径
    let path_pattern = '\v(/\S+|~/\S+)'
    
    " 尝试匹配更复杂的路径（包含空格需要用引号包裹）
    let quoted_path_pattern = '\v[''"](\S+)[''"]'
    
    " 首先检查是否在引号内的路径
    let start = 0
    while 1
        let match_start = match(line_text, quoted_path_pattern, start)
        if match_start == -1
            break
        endif
        
        let match_end = matchend(line_text, quoted_path_pattern, start)
        
        " 检查光标是否在匹配范围内
        if col_pos >= match_start && col_pos < match_end
            let quoted = matchstr(line_text, quoted_path_pattern, start)
            " 去掉引号
            let path = substitute(quoted, '\v[''"](\S+)[''"]', '\1', '')
            return path
        endif
        
        let start = match_end
    endwhile
    
    " 如果没有在引号内，尝试普通路径匹配
    let start = 0
    while 1
        let match_start = match(line_text, path_pattern, start)
        if match_start == -1
            return ''
        endif
        
        let match_end = matchend(line_text, path_pattern, start)
        
        " 检查光标是否在匹配范围内
        if col_pos >= match_start && col_pos < match_end
            let path = matchstr(line_text, path_pattern, start)
            
            " 扩展 ~ 到用户家目录
            if path =~# '^~/'
                let path = expand(path)
            endif
            
            return path
        endif
        
        let start = match_end
    endwhile
endfunction

" 增强版：支持更多路径格式
function! GetEnhancedPathUnderCursor()
    let line_text = getline('.')
    let col_pos = col('.') - 1
    
    " 支持多种路径格式：
    " 1. 绝对路径: /path/to/file
    " 2. 家目录: ~/path/to/file
    " 3. Windows 路径: C:\path\to\file 或 \\server\share
    " 4. 带空格和特殊字符的引号路径
    " 5. 相对路径: ./file 或 ../dir/file
    
    "let patterns = [
    "    \ '\v[''"](\S[^''"]+\S)[''"]',           " 引号包裹的路径
    "    \ '\v(/\S[^[:space:]]*)',                " Unix 绝对路径
    "    \ '\v(~/\S[^[:space:]]*)',               " 家目录路径
    "    \ '\v([A-Za-z]:\\[^[:space:]]*)',        " Windows 驱动器路径
    "    \ '\v(\\\\[^[:space:]]+)',               " Windows 网络路径
    "    \ '\v(\.{1,2}/\S[^[:space:]]*)',         " 相对路径
    "    \ '\v(\w[^[:space:]]*/\S[^[:space:]]*)', " 可能包含特殊字符的路径
    "    \]
    let patterns = [
        \ '\v[''"](\S[^''"]+\S)[''"]',
        \ '\v(/\S[^[:space:]]*)',
        \ '\v(~/\S[^[:space:]]*)',
        \ '\v([A-Za-z]:\\[^[:space:]]*)',
        \ '\v(\\\\[^[:space:]]+)',
        \ '\v(\.{1,2}/\S[^[:space:]]*)',
        \ '\v(\w[^[:space:]]*/\S[^[:space:]]*)',
        \]
    
    for pattern in patterns
        let start = 0
        while 1
            let match_start = match(line_text, pattern, start)
            if match_start == -1
                break
            endif
            
            let match_end = matchend(line_text, pattern, start)
            
            if col_pos >= match_start && col_pos < match_end
                let path = matchstr(line_text, pattern, start)
                
                " 清理引号
                if path =~# '^[''"]' && path =~# '[''"]$'
                    let path = path[1:-2]
                endif
                
                " 扩展 ~
                if path =~# '^~/'
                    let path = expand(path)
                endif
                
                return path
            endif
            
            let start = match_end
        endwhile
    endfor
    
    return ''
endfunction


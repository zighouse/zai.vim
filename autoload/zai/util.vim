let s:plugin_root = expand('<sfile>:h:h:h')
let s:path_sep = has('win32') ? '\' : '/'

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

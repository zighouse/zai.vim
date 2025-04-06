let s:home = expand('<sfile>:h:h')
let s:path_sep = has('win32') ? '\' : '/'
let g:zai_input_mode = 'text' " json, text

let s:script_path = s:home . '/python3/deepseek.py'

if exists('g:zai_log_dir')
    let s:log_dir = g:zai_log_dir
else
    if has('win32')
        let s:log_dir = expand('~/AppData/Local/Zighouse/Zai/Log')
    else
        let s:log_dir = expand('~/.local/share/zai/log')
    endif
endif

let s:python_cmd = has('win32') ? 'python' : '/usr/bin/env python3' 
if has('win32')
    let s:base_url = exists('g:zai_base_url') ? ['--base-url', g:zai_base_url] : []
    let s:api_key_name = exists('g:zai_api_key_name') ? ['--api-key-name', g:zai_api_key_name] : []
    let s:opt_model = exists('g:zai_default_model') ? ['--model=', g:zai_default_model] : []
    let g:zai_cmd = [ s:python_cmd, s:script_path, '--log-dir', s:log_dir,
                \ '--' . g:zai_input_mode] + s:base_url + s:api_key_name + s:opt_model
else
    let s:opt_script = ' "' . s:script_path . '"'
    let s:opt_dir = ' --log-dir="' . s:log_dir . '"'
    let s:opt_input_mode = ' --' . g:zai_input_mode
    let s:base_url = exists('g:zai_base_url') ? ' --base-url=' . g:zai_base_url : ''
    let s:api_key_name = exists('g:zai_api_key_name') ? ' --api-key-name=' . g:zai_api_key_name : ''
    let s:opt_model = exists('g:zai_default_model') ? ' --model="' . g:zai_default_model . '"' : ''
    let g:zai_cmd = [ s:python_cmd . s:opt_script . s:opt_dir . s:opt_input_mode
                \ . s:base_url . s:api_key_name . s:opt_model ]
endif

if !exists('g:zai_print_prompt')
    let g:zai_print_prompt = ['**User:**', '**Assistant:**']
endif

let s:chats = {}  " Dictionary to store all chat sessions
let s:current_chat_id = 0  " ID of the current chat session

" generate a unique chat ID
function! zai#generate_chat_id()
    let s:current_chat_id += 1
    return s:current_chat_id
endfunction

let s:zai_task = 0
let s:zai_obuf = -1  " output buffer
let s:zai_ibuf = -1  " input buffer

" remove leading and trailing empty strings of a list
function! zai#strip(lst)
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

" move the cursor to the end of a window
function! zai#move_last(bufnr) abort
    let l:win = bufwinid(a:bufnr)
    if l:win != -1
        call win_execute(l:win, 'normal! G')
    endif
endfunction

" print raw content to the buffer
function! zai#print_raw(bufnr, raw_lines) abort
    " ensure the buffer is loaded
    if !bufloaded(a:bufnr)
        echoerr "Buffer " .. a:bufnr .. " is not loaded."
        return
    endif

    " enable write mode
    let l:mod = getbufvar(a:bufnr, '&modifiable')
    if !l:mod
        call setbufvar(a:bufnr, '&modifiable', 1)
    endif

    " write content
    if type(a:raw_lines) == v:t_list
        for l:line in a:raw_lines
            call appendbufline(a:bufnr, '$', l:line)
        endfor
    else
        call appendbufline(a:bufnr, '$', a:raw_lines)
    endif

    " restore read-only mode
    if !l:mod
        call setbufvar(a:bufnr, '&modifiable', 0)
    endif

    call zai#move_last(a:bufnr)
endfunction

" convert content to channel-data format
function! zai#raw_to_channel_data(content) abort
    " Simulate job's channel-lines, need to add line break indicators ('')
    let l:new_content = []
    for l:line in a:content
        if l:line == ''
            let l:new_content += ['']
        else
            let l:new_content += [l:line, '']
        endif
    endfor
    return l:new_content
endfunction

" print channel data to the buffer
function! zai#print_channel_data(bufnr, channel_data) abort
    " ensure the buffer is loaded
    if !bufloaded(a:bufnr)
        echoerr "Buffer " .. a:bufnr .. " is not loaded."
        return
    endif

    " enable write mode
    let l:mod = getbufvar(a:bufnr, '&modifiable')
    if !l:mod
        call setbufvar(a:bufnr, '&modifiable', 1)
    endif

    " write content
    let l:end = getbufinfo(a:bufnr)[0].linecount
    if type(a:channel_data) == v:t_list

        "
        " Format explanation:
        "     Start\n\nAbove.
        "     After passing through the channel, it is converted to as:
        "     [1:Start][2:][2:][2:][3:Above][4:.][5:][5:]
        "

        " iterate through the string array
        let l:nf_count = 0
        for l:line in a:channel_data
            if l:line == ''
                let l:nf_count += 1
                if l:nf_count == 2
                    " two consecutive ('') count as one empty line
                    let l:nf_count = 0
                else
                    " add an empty line at the end of the buffer
                    let l:end += 1
                    call setbufline(a:bufnr, l:end, '')
                endif
            else
                " append to the last line of the buffer
                let l:cur = getbufline(a:bufnr, l:end)[0]
                call setbufline(a:bufnr, l:end, l:cur .. l:line)
                let l:nf_count = 0
            endif
        endfor
    else
        call appendbufline(a:bufnr, l:end, a:channel_data)
    endif

    " restore read-only mode
    if !l:mod
        call setbufvar(a:bufnr, '&modifiable', 0)
    endif

    "call zai#move_last(a:bufnr)
endfunction

" task response callback
function! zai#task_on_response(channel, msg) abort
    if !bufexists(s:zai_obuf)
        call zai#ui_open()
    endif
    let l:out_msg = iconv(a:msg, 'utf-8', &encoding)
    call zai#print_channel_data(s:zai_obuf, l:out_msg)
endfunction

" task exit callback
function! zai#task_on_exit(job, status) abort
    if empty(s:zai_task)
        return
    endif
    call zai#print_raw(s:zai_obuf, 'Zai task is exited, status: ' .. a:status)
    call zai#task_stop()
    let s:zai_task = 0
endfunction

" start the task
function! zai#task_start() abort
    if empty(s:zai_task)
        let l:shell = has('win32') ? ['cmd', '/c'] : ['/bin/sh', '-c']
        if has('nvim')
            " for Neovim
            let s:zai_task = jobstart(l:shell + g:zai_cmd, {
                        \ 'on_stdout': {_, data, __ -> zai#task_on_response(0, data)},
                        \ 'on_stderr': {_, data, __ -> zai#task_on_response(0, data)},
                        \ 'on_exit': {_, status, __ -> zai#task_on_exit(0, status)},
                        \ 'err_msg': "Zai: There is an error.",
                        \ 'env': { 'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1' },
                        \ 'in_io': 'pipe',
                        \ 'out_io': 'pipe',
                        \ 'err_io': 'pipe',
                        \ })
        else
            " for Vim
            let s:zai_task = job_start(l:shell + g:zai_cmd, {
                        \ 'out_cb': function('zai#task_on_response'),
                        \ 'err_cb': function('zai#task_on_response'),
                        \ 'exit_cb': function('zai#task_on_exit'),
                        \ 'err_msg': "Zai: There is an error.",
                        \ 'env': { 'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1' },
                        \ 'in_io': 'pipe',
                        \ 'out_io': 'pipe',
                        \ 'err_io': 'pipe',
                        \ })
        endif
    endif
endfunction

" stop the task
function! zai#task_stop() abort
    if empty(s:zai_task)
        return
    endif

    if has('nvim')
        " for Neovim
        try
            " send the exit command and wait 200ms for its responce
            call jobsend(s:zai_task, "exit\n")
            sleep 200m
        catch 
            echo 'caught: ' .. v:exception
        endtry
        call jobstop(s:zai_task)
    else
        " for Vim
        let l:channel = job_getchannel(s:zai_task)
        if string(l:channel) == 'channel fail'
            return
        endif

        try
            " send the exit command and wait 200ms for its responce
            call ch_sendraw(l:channel, "exit\n")
            sleep 200m
        catch 
            echo 'caught: ' .. v:exception
        endtry
        " force stop the chat_task
        call job_stop(s:zai_task)
    endif
endfunction

" open the plugin interface
function! zai#ui_open() abort
    " Create a new vertical window at the bottom right and take its buffer as
    " the output buffer.
    if s:zai_obuf == -1 || !bufexists(s:zai_obuf)
        vertical botright new
        let s:zai_obuf = bufnr('%')
        setlocal buftype=nofile
        setlocal bufhidden=hide
        setlocal noswapfile
        setlocal nobuflisted
        setlocal nomodifiable
        setlocal wrap
        setlocal syntax=markdown
        let &l:statusline = "[Zai-Log]%=%-14.(%l,%c%V%) %P"
        execute 'wincmd L'
        normal! zR
    else
        " jump to the output window
        let l:owin = bufwinnr(s:zai_obuf)
        if l:owin == -1
            " check if the input window exists
            let l:iwin = -1
            if s:zai_ibuf != -1
                let l:iwin = bufwinnr(s:zai_ibuf)
            endif
            if l:iwin != -1
                " enter the input window and split a window above for output
                execute l:iwin .. 'wincmd w'
                aboveleft split
                execute 'buffer' s:zai_obuf
                " adjust the height
                call win_execute(bufwinid(s:zai_ibuf), 'resize 10')
            else
                " no input window, create one at right side for output
                vertical botright split
                execute 'buffer' s:zai_obuf
                execute 'wincmd L'
                normal! zR
            endif
        else
            " if there is the output window, focus it
            execute l:owin .. 'wincmd w'
            normal! zR
        endif
    endif
    vertical resize 80 " height
    normal! G

    " Split a new horizontal one (at bottom) in the original vertical window
    " and take its buffer as input
    if s:zai_ibuf == -1 || !bufexists(s:zai_ibuf)
        belowright new
        let s:zai_ibuf = bufnr('%')
        setlocal buftype=nofile
        setlocal bufhidden=hide
        setlocal noswapfile
        setlocal nobuflisted
        setlocal modifiable
        setlocal wrap
        setlocal syntax=markdown
        let &l:statusline = '[Zai] Submit:normal+[Enter]%=%-14.(%l,%c%V%) %P'
        resize 10  " window height
        normal! G
        nnoremap <buffer><silent><nowait> <CR> call zai#Go()<CR>
    else
        let l:iwin = bufwinnr(s:zai_ibuf)
        if l:iwin == -1
            " open the input window
            belowright split
            execute 'buffer' s:zai_ibuf
            resize 10  " set height
            normal! G
        else
            " jump focus to the input window
            execute l:iwin .. 'wincmd w'
            normal! G
        endif
    endif

    " register the close operation
    autocmd WinClosed * call zai#on_ui_closed()
endfunction

function! zai#Open()
    call zai#ui_open()
    call zai#task_start()
endfunction

" Define available character sets for block markers
let s:fence_chars = ['`', '\"', "\'", '~', '#', '%', '@', '-', '+', '=', '*', '^', '_']

" Generate a mixed character marker for fenced block quoting
function! zai#generate_mixed_fence(length)
    let l:marker = ''
    for i in range(a:length)
        let l:marker .= s:fence_chars[rand() % len(s:fence_chars)]
    endfor
    return l:marker
endfunction

" Check if the marker conflicts with the quoting text
function! zai#is_marker_conflicted(text, marker)
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
function! zai#generate_unique_fence(text)
    let l:length = 3
    while 1
        " First try repeating characters
        for l:char in s:fence_chars
            let l:marker = repeat(l:char, l:length)
            if !zai#is_marker_conflicted(a:text, l:marker)
                return l:marker
            endif
        endfor

        " Secondly, try mixed characters
        let l:marker = zai#generate_mixed_fence(l:length)
        if !zai#is_marker_conflicted(a:text, l:marker)
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
function! zai#generate_unique_signature(text)
    let l:length = 5
    while 1
        " Capital the fist letter
        let l:marker = s:sig_chars[rand() % 26]
        " the rest can be any \w character
        for i in range(l:length - 1)
            let l:marker .= s:sig_chars[rand() % len(s:sig_chars)]
        endfor

        if !zai#is_marker_conflicted(a:text, l:marker)
            return l:marker
        endif

        " Increase length and retry
        let l:length += 1
    endwhile
endfunction

function! zai#append(selected) abort
    " get the extension name before focus moved
    let l:ext = expand('%:e')

    " Remove leading and trailing blank lines
    if type(a:selected) == v:t_list
        let l:content = zai#strip(a:selected)
    else
        let l:content = zai#strip(split(a:selected, '\n'))
    endif
    if empty(l:content)
        return
    endif

    " Ensure the window and task are open
    call zai#ui_open()
    call zai#task_start()

    " Write to the input buffer
    let l:win = win_findbuf(s:zai_ibuf)
    call win_execute(l:win[0], 'setlocal modifiable')
    let l:end = getbufinfo(s:zai_ibuf)[0].linecount

    " Prepare a quoting mark to enclose the copied content
    let l:fence_marker = zai#generate_unique_fence(l:content)
    call appendbufline(s:zai_ibuf, l:end, l:fence_marker .. l:ext)
    let l:end += 1
    for l:line in l:content
        call appendbufline(s:zai_ibuf, l:end, l:line)
        let l:end += 1
    endfor
    call appendbufline(s:zai_ibuf, l:end, l:fence_marker)
endfunction

" Precisely select content to the input box
function! zai#Add() abort
    " Get the currently selected content
    let l:saved_register = @"
    " gv -- reselect the previous visual area
    " y  -- yank text into register
    normal! gvy
    let l:sel = @"
    let @" = l:saved_register

    call zai#append(l:sel)
endfunction

" Get content by line number range to the input box
function! zai#AddRange(line1, line2) range abort
    let l:sel = getbufline(bufnr('%'), a:line1, a:line2)
    call zai#append(l:sel)
endfunction

function! zai#Go() abort
    " Ensure the windows and task are open
    call zai#ui_open()
    call zai#task_start()

    " Check if the input window is open
    if s:zai_ibuf == -1 || !bufexists(s:zai_ibuf)
        echo "open chat input buffer failed."
        return
    endif

    " Send the content to chat_task
    let l:content = getbufline(s:zai_ibuf, 0, line('$'))
    if empty(l:content)
        return
    endif

    if g:zai_input_mode == 'json'
        " for json input mode
        let l:request = json_encode(l:content)
    else
        " for text input mode
        if len(l:content) > 1
            " use quotation signature to make content a quotated block.
            let l:signature = zai#generate_unique_signature(l:content)
            let l:request = join(['<<' .. l:signature] + l:content + [l:signature], "\n")
        else
            let l:request = join(l:content, "\n")
        endif
    endif

    let l:req_msg = iconv(l:request . "\n", &encoding, 'utf-8')
    if has('nvim')
        " for Neovim
        call jobsend(s:zai_task, l:req_msg)
    else
        " for Vim
        let l:channel = job_getchannel(s:zai_task)
        call ch_sendraw(l:channel, l:req_msg)
    endif

    " Also write to the output box
    let l:content = ['', g:zai_print_prompt[0]] + l:content + ['', g:zai_print_prompt[1]]
    call zai#ui_open()
    call zai#print_raw(s:zai_obuf, l:content)

    " Clear the input buffer
    call deletebufline(s:zai_ibuf, 1, '$')
endfunction

function! zai#Close() abort
    if s:zai_obuf == -1 || !bufexists(s:zai_obuf)
        return
    endif

    call zai#task_stop()

    " Close the buffer and related windows of Zai.
    execute 'bdelete! ' .. s:zai_ibuf .. ' ' .. s:zai_obuf
    let s:zai_ibuf = -1
    let s:zai_obuf = -1
endfunction

function! zai#on_ui_closed()
    let l:last = str2nr(expand('<amatch>'))
    if bufwinid(s:zai_obuf) == l:last
        if bufwinid(s:zai_ibuf) != -1
            execute bufwinnr(s:zai_ibuf) .. 'wincmd c'
        endif
    elseif bufwinid(s:zai_ibuf) == l:last
        if bufwinid(s:zai_obuf) != -1
            execute bufwinnr(s:zai_obuf) .. 'wincmd c'
        endif
    endif
endfunction

scriptencoding utf-8

let s:chats = {}  " Dictionary to store all chat sessions
let s:current_chat_id = 0  " ID of the current chat session

" generate a unique chat ID
function! s:generate_chat_id()
    let s:current_chat_id += 1
    return s:current_chat_id
endfunction

let s:zai_task = 0
let s:zai_obuf = -1  " output buffer
let s:zai_ibuf = -1  " input buffer

" move the cursor to the end of a window
function! s:move_cursor_last(bufnr) abort
    let l:win = bufwinid(a:bufnr)
    if l:win != -1
        call win_execute(l:win, 'normal! G')
    endif
endfunction

" print raw content to the buffer
function! s:print_raw(bufnr, raw_lines) abort
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

    call s:move_cursor_last(a:bufnr)
endfunction

" convert content to channel-data format
function! s:raw_to_channel_data(content) abort
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
function! s:print_channel_data(bufnr, channel_data) abort
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
        let l:row = 0
        let l:break = v:false
        for l:line in a:channel_data
            let l:row += 1
            if l:row == 1 && l:line == ''
                let l:break = v:true
            endif
            if l:break
                let l:end += 1
                call setbufline(a:bufnr, l:end, l:line)
            else
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
            endif
        endfor
    else
        call appendbufline(a:bufnr, l:end, a:channel_data)
    endif

    " restore read-only mode
    if !l:mod
        call setbufvar(a:bufnr, '&modifiable', 0)
    endif

    "call s:move_cursor_last(a:bufnr)
endfunction

" task response callback
function! s:task_on_response(channel, msg) abort
    if !bufexists(s:zai_obuf)
        call s:ui_open()
    endif
    if type(a:msg) == v:t_list
        let l:out_msg = []
        for l:line in a:msg
            let l:out_msg += [iconv(l:line, 'utf-8', &encoding)]
        endfor
    else
        let l:out_msg = iconv(a:msg, 'utf-8', &encoding)
    endif
    call s:print_channel_data(s:zai_obuf, l:out_msg)
endfunction

" task exit callback
function! s:task_on_exit(job, status) abort
    if empty(s:zai_task)
        return
    endif
    call s:print_raw(s:zai_obuf, 'Zai task is exited, status: ' .. a:status)
    call s:task_stop()
    let s:zai_task = 0
endfunction

" start the task
function! s:task_start() abort
    if empty(s:zai_task)
        let l:shell = has('win32') ? ['cmd', '/c'] : ['/bin/sh', '-c']
        let l:env = { 'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1' }
        if exists('g:zai_lang')
            let l:env['LANG'] = g:zai_lang
        endif
        if has('nvim')
            " for Neovim
            let s:zai_task = jobstart(l:shell + g:zai_cmd, {
                        \ 'on_stdout': {_, data, __ -> s:task_on_response(0, data)},
                        \ 'on_stderr': {_, data, __ -> s:task_on_response(0, data)},
                        \ 'on_exit': {_, status, __ -> s:task_on_exit(0, status)},
                        \ 'err_msg': "Zai: There is an error.",
                        \ 'env': l:env,
                        \ 'in_io':  'pipe',
                        \ 'out_io': 'pipe',
                        \ 'err_io': 'pipe',
                        \ })
        else
            " for Vim
            let s:zai_task = job_start(l:shell + g:zai_cmd, {
                        \ 'out_cb':  function('s:task_on_response'),
                        \ 'err_cb':  function('s:task_on_response'),
                        \ 'exit_cb': function('s:task_on_exit'),
                        \ 'err_msg': "Zai: There is an error.",
                        \ 'env': l:env,
                        \ 'in_io': 'pipe',
                        \ 'out_io': 'pipe',
                        \ 'err_io': 'pipe',
                        \ })
        endif
    endif
endfunction

" stop the task
function! s:task_stop() abort
    if empty(s:zai_task)
        return
    endif

    if has('nvim')
        " for Neovim
        try
            " send the exit command and wait 200ms for its responce
            call jobsend(s:zai_task, ":exit\n")
            sleep 100m
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
            call ch_sendraw(l:channel, ":exit\n")
            sleep 100m
        catch 
            echo 'caught: ' .. v:exception
        endtry
        " force stop the chat_task
        call job_stop(s:zai_task)
    endif
endfunction

" open the plugin interface
function! s:ui_open() abort
    call zai#init()

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
        nnoremap <buffer><silent><nowait> <CR> :call zai#Go()<CR>
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
    autocmd WinClosed * call s:on_ui_closed()
endfunction

function! zai#chat#Open() abort
    call s:ui_open()
    call s:task_start()
endfunction

function! s:append(selected) abort
    let l:file_type = zai#util#get_file_type()

    " Remove leading and trailing blank lines
    if type(a:selected) == v:t_list
        let l:content = zai#util#strip_list(a:selected)
    else
        let l:content = zai#util#strip_list(split(a:selected, '\n'))
    endif
    if empty(l:content)
        return
    endif

    " Ensure the window and task are open
    call s:ui_open()
    call s:task_start()

    " Write to the input buffer
    let l:win = win_findbuf(s:zai_ibuf)
    call win_execute(l:win[0], 'setlocal modifiable')
    let l:end = getbufinfo(s:zai_ibuf)[0].linecount

    " Prepare a quoting mark to enclose the copied content
    let l:fence_marker = zai#util#get_fence_marker(l:content)
    call appendbufline(s:zai_ibuf, l:end, l:fence_marker .. l:file_type)
    let l:end += 1
    for l:line in l:content
        call appendbufline(s:zai_ibuf, l:end, l:line)
        let l:end += 1
    endfor
    call appendbufline(s:zai_ibuf, l:end, l:fence_marker)
endfunction

" Precisely select content to the input box
function! zai#chat#Add() abort
    " Get the currently selected content
    let l:saved_register = @"
    " gv -- reselect the previous visual area
    " y  -- yank text into register
    normal! gvy
    let l:sel = @"
    let @" = l:saved_register

    call s:append(l:sel)
endfunction

" Get content by line number range to the input box
function! zai#chat#AddRange(line1, line2) range abort
    let l:sel = getbufline(bufnr('%'), a:line1, a:line2)
    call s:append(l:sel)
endfunction

function! zai#chat#Go() abort
    " Ensure the windows and task are open
    call s:ui_open()
    call s:task_start()

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
            let l:signature = zai#util#get_block_sign(l:content)
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
    call s:ui_open()
    call s:print_raw(s:zai_obuf, l:content)

    " Clear the input buffer
    call deletebufline(s:zai_ibuf, 1, '$')
endfunction

function! zai#chat#Close() abort
    if s:zai_obuf == -1 || !bufexists(s:zai_obuf)
        return
    endif

    call s:task_stop()

    " Close the buffer and related windows of Zai.
    if bufwinid(s:zai_ibuf) != -1
        execute bufwinnr(s:zai_ibuf) .. 'wincmd c'
    endif
    call setbufvar(s:zai_obuf, '&modifiable', 1)
    silent! call deletebufline(s:zai_obuf, 1, '$')
    call setbufvar(s:zai_obuf, '&modifiable', 0)
endfunction

function! s:on_ui_closed()
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


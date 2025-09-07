scriptencoding utf-8

let s:zai_chats = {}  " dictionary to store all chats: {id: {id, obuf, job, name, status}}
let s:zai_chat_id = -1 " id of current showing chat session
let s:zai_jobs = {}   " dictionary to store all chat jobs: {job: {id}}
let s:zai_ibuf = -1   " input buffer (shared by all chats)
let s:zai_lbuf = -1   " list buffer

if exists('g:zai_lang') && match(g:zai_lang, 'zh') != -1
    let s:zh_lang = 1
elseif match(get(environ(), 'LANG', ''), 'zh') != -1 || match(get(environ(), 'LANGUAGE', ''), 'zh') != -1
    let s:zh_lang = 1
else
    let s:zh_lang = 0
endif
let s:title_exp = '^### \(建议标题：\|Title: \)\[\(.\+\)\]\s*$'

let s:zai_status_name = {
            \ 'ready':     s:zh_lang ? '就绪' : 'listen',
            \ 'asking':    s:zh_lang ? '请求' : 'asking',
            \ 'waiting':   s:zh_lang ? '等待' : 'waitng',
            \ 'thinking':  s:zh_lang ? '思考' : 'thnkng',
            \ 'answering': s:zh_lang ? '回答' : 'answer',
            \ 'complete':  s:zh_lang ? '完成' : 'complt',
            \ }

" for debug
function! s:GetVar(var_name) abort
    return get(s:, a:var_name, 'UNDEFINED')
endfunction
command! -nargs=1 ZaiShowVar echo s:GetVar(<f-args>)
function! ZaiGetVar(var_name) abort
    return s:GetVar(a:var_name)
endfunction
function! s:EchoError(msg) abort
    echohl ErrorMsg
    echo a:msg
    echohl None
endfunction

" get current chat which its obuf is showing.
function! s:current_chat() abort
    if has_key(s:zai_chats, s:zai_chat_id)
        return s:zai_chats[s:zai_chat_id]
    endif
    if !empty(s:zai_chats)
        let l:chat = items(s:zai_chats)[0]
        let s:zai_chat_id = l:chat.id
        return l:chat
    endif
    let s:zai_chat_id = -1
    return {}
endfunction

" get chat by id, job, channel.
function! s:get_chat(id) abort
    let l:type = type(a:id)
    if l:type == v:t_number
        return get(s:zai_chats, a:id, {})
    elseif l:type == v:t_job
        if has_key(s:zai_jobs, a:id)
            let l:id = s:zai_jobs[a:id].id
            return get(s:zai_chats, l:id, {})
        endif
    elseif l:type == v:t_channel
        let l:job = ch_getjob(a:id)
        if has_key(s:zai_jobs, l:job)
            let l:id = s:zai_jobs[l:job].id
            return get(s:zai_chats, l:id, {})
        endif
    endif
    return {}
endfunction

" generate a unique chat ID
let s:zai_last_chat_id = -1
function! s:generate_chat_id()
    let s:zai_last_chat_id += 1
    return s:zai_last_chat_id
endfunction

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
        echohl ErrorMsg
        echo "Buffer " .. a:bufnr .. " is not loaded."
        echohl None
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

function! s:update_status_on_channel_data(chat, line) abort
    let l:status_map = {
        \ '^<think>\s*$':  s:zai_status_name.thinking,
        \ '^</think>\s*$': s:zai_status_name.answering,
        \ '^</small>\s*$': s:zai_status_name.complete
    \ }

    for [l:pattern, l:status] in items(l:status_map)
        if a:line =~# l:pattern
            let a:chat.status = l:status
            call s:update_chat_status(a:chat)
            return
        else
            let l:title_match = matchlist(a:line, s:title_exp)
            if !empty(l:title_match)
                let a:chat.title = l:title_match[2]
                call s:update_chat_status(a:chat)
            endif
        endif
    endfor
endfunction

" print channel data to the buffer
function! s:print_channel_data(chat, bufnr, channel_data) abort
    " ensure the buffer is loaded
    if !bufloaded(a:bufnr)
        echohl ErrorMsg
        echo "Buffer " .. a:bufnr .. " is not loaded."
        echohl None
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
                call s:update_status_on_channel_data(a:chat, l:line)
            endif
        endfor
    else
        call appendbufline(a:bufnr, l:end, a:channel_data)
        call s:update_status_on_channel_data(a:chat, a:channel_data)
    endif

    " restore read-only mode
    if !l:mod
        call setbufvar(a:bufnr, '&modifiable', 0)
    endif

    "call s:move_cursor_last(a:bufnr)
endfunction

" task response callback
function! s:task_on_response(channel, msg) abort
    let l:chat = s:get_chat(a:channel)
    if empty(l:chat)
        return
    endif
    let l:obuf = l:chat.obuf
    if !bufexists(l:obuf)
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
    if l:chat.status ==# s:zai_status_name.waiting
        let l:chat.status = s:zai_status_name.answering
        call s:update_chat_status(l:chat)
    endif
    call s:print_channel_data(l:chat, l:obuf, l:out_msg)
endfunction

" task exit callback
function! s:task_on_exit(job, status) abort
    let l:chat = s:get_chat(a:job)
    if empty(l:chat)
        return
    endif
    let l:obuf = l:chat.obuf
    unlet s:zai_jobs[a:job]
    if empty(l:chat.job)
        return
    endif
    call s:print_raw(l:obuf, 'Zai task is exited, status: ' .. a:status)
    call s:task_stop()
    let l:chat.job = 0
endfunction

" start the task
function! s:task_start() abort
    let l:chat = s:current_chat()
    if empty(l:chat.job)
        let l:shell = has('win32') ? ['cmd', '/c'] : ['/bin/sh', '-c']
        let l:env = { 'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1' }
        if exists('g:zai_lang')
            let l:env['LANG'] = g:zai_lang
        endif
        if has('nvim')
            " for Neovim
            let l:task = jobstart(l:shell + g:zai_cmd, {
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
            let l:task = job_start(l:shell + g:zai_cmd, {
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
        let s:zai_jobs[l:task] = {'id': l:chat.id}
        let l:chat.job = l:task
        let l:chat.status = s:zai_status_name.ready
    endif
endfunction

" stop the task
function! s:task_stop() abort
    let l:chat = s:current_chat()
    if empty(l:chat.job)
        return
    endif

    if has('nvim')
        " for Neovim
        try
            " send the exit command and wait 200ms for its responce
            call jobsend(l:chat.job, ":exit\n")
            sleep 100m
        catch
            echo 'caught: ' .. v:exception
        endtry
        call jobstop(l:chat.job)
    else
        " for Vim
        let l:channel = job_getchannel(l:chat.job)
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
        call job_stop(l:chat.job)
    endif
endfunction

" open the plugin interface
function! s:ui_open() abort
    call zai#init()

    let l:chat = s:current_chat()

    " Create a new vertical window at the bottom right and take its buffer as
    " the output buffer.
    if empty(l:chat)
        vertical botright new
        let b:zai_buffer = 0
        let l:id = s:generate_chat_id()
        let l:obuf = bufnr('%')
        call setbufline('%', 1, 'chat-id:' . l:id)
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
        let s:zai_chats[l:id] = {
                    \ 'id': l:id,
                    \ 'obuf': l:obuf,
                    \ 'job': 0,
                    \ 'name': strftime("%H:%M:%S"),
                    \ 'status': s:zai_status_name.ready,
                    \ 'title': '',
                    \ 'usertitle': '',
                    \ }
        let s:zai_chat_id = l:id
    else
        let l:id = l:chat.id
        let l:obuf = l:chat.obuf
        " jump to the output window
        let l:owin = bufwinnr(l:obuf)
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
                execute 'buffer' l:obuf
                " adjust the height
                call win_execute(bufwinid(s:zai_ibuf), 'resize 10')
            else
                " no input window, create one at right side for output
                vertical botright split
                execute 'buffer' l:obuf
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
        let b:zai_buffer = 0
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

    call s:goto_lwin()
    call s:goto_iwin()

    " register the close operation
    autocmd WinClosed * call s:on_ui_closed()
endfunction

function! s:goto_owin() abort
    let l:chat = s:current_chat()
    if empty(l:chat)
        call s:ui_open()
        call s:goto_owin()
        return
    endif
    let l:owin = bufwinnr(l:chat.obuf)
    if l:owin == -1
        call s:ui_open()
        call s:goto_owin()
    else
        execute l:owin .. 'wincmd w'
        normal! zR
    endif
endfunction

function! s:goto_iwin() abort
    let l:iwin = bufwinnr(s:zai_ibuf)
    if l:iwin == -1
        call s:ui_open()
        call s:goto_iwin()
    else
        execute l:iwin .. 'wincmd w'
        normal! zR
    endif
endfunction

function! s:goto_lwin() abort
    let l:lwin = bufwinnr(s:zai_lbuf)
    if l:lwin == -1
        call s:goto_owin()
        aboveleft 5new
        let b:zai_buffer = 0
        setlocal buftype=nofile bufhidden=hide noswapfile nobuflisted nomodifiable nowrap

        let b:zai_highlight = 1
        call s:highlight_chats()

        let &l:statusline = "[Zai-Chats-List]%=%-14.(%l,%c%V%) %P"
        let s:zai_lbuf = bufnr('%')
        nnoremap <buffer> <CR> :call <SID>select_chat_atpos()<CR>
    else
        execute l:lwin .. 'wincmd w'
    endif
    call s:update_chat_list()
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

function! s:extract_user_title(lines) abort
    let l:symbol_pattern = '^[[:space:]]*[#*\-+>!@$%^&()\[\]{}|;:,.<>?/\\`_~=]'
    let l:first_line = ''
    
    for l:line in a:lines
        if l:line =~? '^\s*$'
            continue
        endif
        
        if l:line =~? l:symbol_pattern
            continue
        endif
        
        if empty(l:first_line)
            let l:first_line = l:line
        endif
        if strchars(l:line) > 30
            return strcharpart(l:line, 0, 30)
        endif
    endfor
    
    return l:first_line
endfunction

function! zai#chat#Go() abort
    " Ensure the windows and task are open
    call s:ui_open()
    call s:task_start()
    let l:chat = s:current_chat()

    " Check if the input window is open
    if s:zai_ibuf == -1 || !bufexists(s:zai_ibuf)
        echo "open chat input buffer failed."
        return
    endif

    " Send the content to chat_task
    let l:content = getbufline(s:zai_ibuf, 1, line('$'))
    if empty(l:content)
        return
    endif
    let l:chat.usertitle = s:extract_user_title(l:content)

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
    let l:chat.status = s:zai_status_name.asking
    call s:update_chat_status(l:chat)
    if has('nvim')
        " for Neovim
        call jobsend(l:chat.job, l:req_msg)
    else
        " for Vim
        let l:channel = job_getchannel(l:chat.job)
        call ch_sendraw(l:channel, l:req_msg)
    endif

    " Also write to the output box
    let l:content = ['', g:zai_print_prompt[0]] + l:content + ['', g:zai_print_prompt[1]]
    call s:ui_open()
    call s:print_raw(l:chat.obuf, l:content)
    let l:chat.status = s:zai_status_name.waiting
    call s:update_chat_status(l:chat)

    " Clear the input buffer
    call deletebufline(s:zai_ibuf, 1, '$')
endfunction

function! zai#chat#Close() abort
    let l:chat = s:current_chat()
    if empty(l:chat) || !bufexists(l:chat.obuf)
        return
    endif

    call s:task_stop()

    " Close the buffer and related windows of Zai.
    if bufwinid(s:zai_ibuf) != -1
        execute bufwinnr(s:zai_ibuf) .. 'wincmd c'
    endif
    call setbufvar(l:chat.obuf, '&modifiable', 1)
    silent! call deletebufline(l:chat.obuf, 1, '$')
    call setbufvar(l:chat.obuf, '&modifiable', 0)
endfunction

function! s:on_ui_closed()
    let l:last = str2nr(expand('<amatch>'))
    let l:chat = s:current_chat()
    if bufwinid(l:chat.obuf) == l:last
        if bufwinid(s:zai_lbuf) != -1
            execute bufwinnr(s:zai_lbuf) .. 'wincmd c'
        endif
        if bufwinid(s:zai_ibuf) != -1
            execute bufwinnr(s:zai_ibuf) .. 'wincmd c'
        endif
    elseif bufwinid(s:zai_ibuf) == l:last
        if bufwinid(s:zai_lbuf) != -1
            execute bufwinnr(s:zai_lbuf) .. 'wincmd c'
        endif
        if bufwinid(l:chat.obuf) != -1
            execute bufwinnr(l:chat.obuf) .. 'wincmd c'
        endif
    endif
endfunction

function! zai#chat#Load() abort
    if empty(expand('%'))
        return
    endif
    let file_path = expand('%:p')
    if has('win32')
        let path = substitute(path, '\\', '/', 'g')
    endif
    " Ensure the windows and task are open
    call s:ui_open()
    call s:task_start()

    let l:chat = s:current_chat()

    " Check if the input window is open
    if s:zai_ibuf == -1 || !bufexists(s:zai_ibuf)
        echo "open chat input buffer failed."
        return
    endif

    " Send the content to chat_task
    let l:content = [ ':load ' . file_path ]

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
        call jobsend(l:chat.job, l:req_msg)
    else
        " for Vim
        let l:channel = job_getchannel(l:chat.job)
        call ch_sendraw(l:channel, l:req_msg)
    endif

    " Also write to the output box
    let l:content = ['', g:zai_print_prompt[0]] + l:content + ['', g:zai_print_prompt[1]]
    call s:ui_open()
    call s:print_raw(l:chat.obuf, l:content)

    " Clear the input buffer
    call deletebufline(s:zai_ibuf, 1, '$')
endfunction

let s:chat_title_id_format = '%d '
let s:chat_title_id_max = 0
function! s:format_chat_title(chat)
    if !empty(a:chat.title)
        let l:title = ' ' . a:chat.title
    elseif !empty(a:chat.usertitle)
        let l:title = ' ' . a:chat.usertitle
    else
        let l:title = ''
    endif
    if s:zai_last_chat_id > s:chat_title_id_max
        let s:chat_title_id_format = '%' . len(string(s:zai_last_chat_id)) . 'd '
        let s:chat_title_id_max = s:zai_last_chat_id
    endif
    return printf(s:chat_title_id_format, a:chat.id) . '[' . a:chat.status . '] ' .
                \  a:chat.name . l:title
endfunction

function! s:update_chat_status(chat)
    let l:line = s:format_chat_title(a:chat)
    call setbufvar(s:zai_lbuf, '&modifiable', 1)
    call setbufline(s:zai_lbuf, a:chat.id + 1, l:line)
    call setbufvar(s:zai_lbuf, '&modifiable', 0)
endfunction

function! s:update_chat_list() abort
    call setbufvar(s:zai_lbuf, '&modifiable', 1)

    " clear all signs
    if exists('s:chat_signs')
        for l:sign_id in values(s:chat_signs)
            if l:sign_id != -1
                execute 'sign unplace' l:sign_id 'buffer=' . s:zai_lbuf
            endif
        endfor
    endif
    let s:chat_signs = {}

    let l:len = line('$', s:zai_lbuf)
    if l:len > 0
        call deletebufline(s:zai_lbuf, 1, l:len)
    endif

    let l:lines = []
    let l:line_num = 1
    let l:selected_line = 0

    for l:id in keys(s:zai_chats)
        let l:chat = s:zai_chats[l:id]
        let l:line = s:format_chat_title(l:chat)
        call add(l:lines, l:line)

        if l:id == s:zai_chat_id
            let l:sign_id = l:line_num + 10000 " avoid conflict
            execute 'sign place' l:sign_id 'line=' . l:line_num
                        \ 'name=ZaiSelected'
                        \ 'buffer=' . s:zai_lbuf
            let s:chat_signs[l:id] = l:sign_id
            let l:selected_line = l:line_num
        endif

        let l:line_num += 1
    endfor
    call setbufline(s:zai_lbuf, 1, l:lines)
    call setbufvar(s:zai_lbuf, '&modifiable', 0)

    if l:selected_line > 0
        call s:ensure_line_visible(s:zai_lbuf, l:selected_line)
    endif
endfunction

function! s:ensure_line_visible(bufnr, line_num) abort
    let l:winid = bufwinid(a:bufnr)
    if l:winid == -1
        return
    endif

    let l:win_info = win_execute(l:winid, 'echo winheight(0) . "," .
                \ line("w0") . "," . line("w$") . "," . line("$")')
    let [l:win_height, l:first_line, l:last_line, l:buf_last_line] = split(l:win_info, ',')
    let l:win_height = str2nr(l:win_height)
    let l:first_line = str2nr(l:first_line)
    let l:last_line = str2nr(l:last_line)
    let l:buf_last_line = str2nr(l:buf_last_line)

    if a:line_num < l:first_line
        " above
        call win_execute(l:winid, 'normal! ' . a:line_num . 'zt')
    elseif a:line_num > l:last_line
        " below
        if a:line_num > l:buf_last_line - l:win_height + 1
            " at bottom
            call win_execute(l:winid, 'normal! ' . a:line_num . 'zb')
        else
            " normal
            call win_execute(l:winid, 'normal! ' . a:line_num . 'zz')
        endif
    else
        " in ROI of window, adjust better showing position.
        let l:middle_pos = l:win_height / 3 " threshold is 1/3 of window height
        if a:line_num < l:first_line + l:middle_pos || a:line_num > l:last_line - l:middle_pos
            if a:line_num > l:buf_last_line - l:win_height + 1
                " near bottom
                call win_execute(l:winid, 'normal! ' . a:line_num . 'zb')
            else
                call win_execute(l:winid, 'normal! ' . a:line_num . 'zz')
            endif
        endif
    endif
endfunction

function! s:select_chat(chat_id) abort
    " get id: each line maps to a session in order
    let l:cur_chat = s:current_chat()
    let l:chat = s:get_chat(a:chat_id)
    if !empty(l:chat) && !empty(l:cur_chat) && l:cur_chat.id != l:chat.id
        let l:owin = bufwinid(l:cur_chat.obuf)
        let s:zai_chat_id = l:chat.id
        call win_execute(l:owin, 'buffer ' . l:chat.obuf)
        call s:update_chat_list()
    endif
endfunction

function! s:select_chat_atpos() abort
    " get id: each line maps to a session in order
    let l:idx = line('.') - 1
    call s:select_chat(l:idx)
endfunction

function! s:get_next_chat(count) abort
    if s:zai_chat_id == -1
        return {}
    endif
    let l:count = a:count > 0 ? a:count : 1
    let l:target_id = (s:zai_chat_id + l:count) % (s:zai_last_chat_id + 1)
    while !has_key(s:zai_chats, l:target_id) && l:target_id < s:zai_last_chat_id
        let l:target_id = l:target_id + 1
    endwhile
    return get(s:zai_chats, l:target_id, {})
endfunction

function! s:get_prev_chat(count) abort
    if s:zai_chat_id == -1
        return {}
    endif
    let l:count = a:count > 0 ? a:count : 1
    let l:target_id = (s:zai_chat_id - l:count) % (s:zai_last_chat_id + 1)
    while !has_key(s:zai_chats, l:target_id) && l:target_id > 0
        let l:target_id = l:target_id - 1
    endwhile
    return get(s:zai_chats, l:target_id, {})
endfunction

function! s:new_chat() abort
    " create the first chat
    if empty(s:zai_chats)
        call s:goto_iwin()
        return
    endif
    " create more
    call s:goto_owin()
    enew
    let b:zai_buffer = 0
    let l:id = s:generate_chat_id()
    let l:obuf = bufnr('%')
    call setbufline('%', 1, 'chat-id:' . l:id)
    setlocal buftype=nofile
    setlocal bufhidden=hide
    setlocal noswapfile
    setlocal nobuflisted
    setlocal nomodifiable
    setlocal wrap
    setlocal syntax=markdown
    let &l:statusline = "[Zai-Log]%=%-14.(%l,%c%V%) %P"
    let s:zai_chats[l:id] = {
                \ 'id': l:id,
                \ 'obuf': l:obuf,
                \ 'job': 0,
                \ 'name': strftime("%H:%M:%S"),
                \ 'status': s:zai_status_name.ready,
                \ 'title': '',
                \ 'usertitle': '',
                \ }
    let s:zai_chat_id = l:id
    call s:update_chat_list()
    call s:goto_iwin()
endfunction

function! zai#chat#New() abort
    call s:new_chat()
endfunction

function! zai#chat#Next(count) abort
    let l:next = s:get_next_chat(a:count)
    if !empty(l:next)
        call s:select_chat(l:next.id)
    endif
endfunction

function! zai#chat#Prev(count) abort
    let l:prev = s:get_prev_chat(a:count)
    if !empty(l:prev)
        call s:select_chat(l:prev.id)
    endif
endfunction

function! zai#chat#Goto(nr) abort
    let l:target_nr = str2nr(a:nr)
    if l:target_nr < 0
        call s:EchoError("invalid parameter for :ZaiGoto.")
        return
    endif

    if has_key(s:zai_chats, l:target_nr)
        call s:select_chat(l:target_nr)
    else
        call s:EchoError("ZaiChat " . l:target_nr . " does not exists.")
    endif
endfunction

function! s:define_chat_sign() abort
    if !exists('b:zai_highlight') || !b:zai_highlight
        return
    endif

    execute 'sign define ZaiSelected'
                \ 'linehl=' . s:zai_highlight
                \ 'texthl=' . s:zai_highlight
                \ 'text=' . s:zai_sign_char
endfunction

function! s:highlight_chats() abort
    if !exists('b:zai_highlight') || !b:zai_highlight
        return
    endif

    function! s:define_highlight() abort
        if !exists('b:zai_highlight') || !b:zai_highlight
            return
        endif

        let s:zai_highlight = 'TabLineSel'
        if exists('*strdisplaywidth') && strdisplaywidth('➩') == 1
            let s:zai_sign_char = '➩'
        else
            let s:zai_sign_char = '⇨'
        endif

        call s:define_chat_sign()
    endfunction

    augroup ZaiHighlights
        autocmd! * <buffer>
        autocmd ColorScheme <buffer> call s:define_highlight() | call s:update_chat_list()
        autocmd BufEnter <buffer> call s:update_chat_list()
    augroup END

    call s:define_highlight()
endfunction

function! zai#chat#FiltCmd(cmdline) abort
    let l:command_map = {
        \ 'new': 'ZaiNew',
        \ 'cn': 'ZaiNext',
        \ 'cp': 'ZaiPrev',
        \ 'cc': 'ZaiGoto'
        \ }

    for [abbr, full_cmd] in items(l:command_map)
        " match -count commands (2cn, 3cp)
        if a:cmdline =~# '^\d*' . abbr . '$'
            return substitute(a:cmdline, abbr, full_cmd, '')
        endif

        " match -nargs commands (cc3, cc 3)
        if abbr ==# 'cc' && a:cmdline =~# '^cc\s*\d\+$'
            let l:param = substitute(a:cmdline, '^cc\s*\(\d\+\)$', '\1', '')
            return full_cmd . ' ' . l:param
        endif
    endfor

    " or restore original
    return a:cmdline
endfunction

function! s:setup_buffer_commands()
    if !exists('b:zai_buffer') || b:zai_buffer >= 1
        return
    endif

    command! -buffer ZaiNew call zai#chat#New()
    command! -buffer -count ZaiNext call zai#chat#Next(<count>)
    command! -buffer -count ZaiPrev call zai#chat#Prev(<count>)
    command! -buffer -nargs=1 ZaiGoto call zai#chat#Goto(<args>)
    cnoremap <expr> <buffer> <CR>
                \ getcmdtype() == ':' ?
                \ "\<C-u>" . zai#chat#FiltCmd(getcmdline()) . "\<CR>" :
                \ "\<CR>"

    let b:zai_buffer = 1 " already setup buffer commands
endfunction

augroup ZaiAutoSetup
    autocmd!
    autocmd BufEnter * call s:setup_buffer_commands()
augroup END

" Zai.Vim - AI Assistant Integration for Vim
" Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
"
" Licensed under the MIT License
"
" zai#asr - ASR (Automatic Speech Recognition) plugin for Vim 9.1+
" Voice input in insert mode using zasr-server
" Author: zighouse
" Version: 0.1.0

" Save current cpoptions and set to Vim defaults
let s:save_cpo = &cpo
set cpo&vim

" ============================================================================
" Script variables
" ============================================================================

" Plugin root directory
let s:plugin_root = expand('<sfile>:h:h:h')

" Path separator for cross-platform compatibility
let s:path_sep = has('win32') ? '\' : '/'

" ZASR deployment directory
let s:zasr_deploy_dir = expand('~/.local/share/zai/zasr')

" ZASR control script
let s:zasrctl = s:zasr_deploy_dir . s:path_sep . 'scripts' . s:path_sep . 'zasrctl'

" Job object for the Python ASR script
let s:asr_job = v:null

" Flag to indicate if ASR is active
let s:asr_active = 0

" Buffer for received text
let s:pending_text = ''

" Length of last partial text inserted (for deletion)
let s:last_partial_len = 0

" Flag indicating if partial text is currently displayed
let s:has_partial = 0

" Position where current sentence starts (line and column)
let s:sentence_start_line = 0
let s:sentence_start_col = 0

" Flag indicating if we're in a sentence (partial results active)
let s:in_sentence = 0

" Timestamp when ASR was started (for protection period)
let s:start_time = 0

" Flag to prevent multiple stop calls
let s:is_stopping = 0

" Track buffer modifications to detect user input
let s:last_changedtick = 0

" Sign column visual feedback
let s:asr_sign_id = 0          " Sign ID for ASR indicator
let s:asr_sign_timer = 0       " Timer ID for animation
let s:asr_sign_frame = 0       " Current animation frame
let s:asr_sign_icons = ['🎤', '◌', '◎', '●']  " Animation sequence

" Text property for highlighting partial ASR text
let s:partial_prop_id = 0      " Property ID for current partial text
let s:partial_prop_type = 'ZaiASRPartial'  " Property type name

" ============================================================================
" ZASR Service Management
" ============================================================================

" Check if zasr-server is running
function! s:is_zasr_running() abort
    " Try to connect to the server
    let l:port = 2026
    if has('unix')
        " Use ss without -p flag (doesn't require root)
        " Fall back to lsof or netstat if ss not available
        let l:result = system('ss -tln 2>/dev/null | grep -q :' . l:port . ' || lsof -i :' . l:port . ' >/dev/null 2>&1 || netstat -tln 2>/dev/null | grep -q :' . l:port)
        return v:shell_error == 0
    elseif has('win32')
        " Windows not supported for ASR
        return 0
    endif
    return 0
endfunction

" Start zasr-server
function! s:start_zasr_service() abort
    " Check platform - Windows not supported
    if has('win32')
        echohl ErrorMsg
        echom 'ASR 功能不支持 Windows 平台'
        echom 'ZASR 服务仅支持 Linux/macOS'
        echohl None
        return 0
    endif

    " Check if zasrctl exists
    if !filereadable(s:zasrctl)
        echohl WarningMsg
        echom 'ZASR 控制脚本未找到: ' . s:zasrctl
        echom '请先运行: python3 python3/install.py --install-zasr'
        echohl None
        return 0
    endif

    " Check if already running
    if s:is_zasr_running()
        return 1
    endif

    " Try to start zasr service
    echohl MoreMsg
    echom '正在启动 ZASR 服务...'
    echohl None

    let l:output = system('bash ' . shellescape(s:zasrctl) . ' start 2>&1')

    if v:shell_error != 0
        echohl ErrorMsg
        echom 'ZASR 服务启动失败: ' . l:output
        echohl None
        return 0
    endif

    " Wait a bit for the service to start
    sleep 500m

    " Verify it's running
    if s:is_zasr_running()
        echohl MoreMsg
        echom 'ZASR 服务已启动'
        echohl None
        return 1
    else
        echohl WarningMsg
        echom 'ZASR 服务可能未成功启动，请手动检查'
        echohl None
        return 0
    endif
endfunction

" ============================================================================
" Core functions
" ============================================================================

" Start the ASR session
function! zai#asr#start() abort
    if s:asr_active
        echohl WarningMsg
        echom 'ASR is already running'
        echohl None
        return
    endif

    " Try to start zasr service if not running
    if !s:is_zasr_running()
        if !s:start_zasr_service()
            echohl WarningMsg
            echom '无法启动 ZASR 服务，ASR 功能可能无法使用'
            echom '您可以继续尝试，或手动启动服务'
            echohl None
            " Don't return - let user try anyway
        endif
    endif

    " Get the Python script path
    let l:python_script = s:plugin_root . s:path_sep . 'python3' . s:path_sep . 'asr.py'

    " Check if Python script exists
    if !filereadable(l:python_script)
        echohl ErrorMsg
        echom 'ASR Python script not found: ' . l:python_script
        echohl None
        return
    endif

    " Start the Python job
    let l:job_opts = {
        \ 'out_cb': funcref('s:on_stdout'),
        \ 'err_cb': funcref('s:on_stderr'),
        \ 'exit_cb': funcref('s:on_exit'),
        \ 'mode': 'nl'
        \ }

    let s:asr_job = job_start(['python3', l:python_script], l:job_opts)

    " Check if job started successfully
    try
        let l:status = job_status(s:asr_job)
        if l:status !=# 'run'
            echohl ErrorMsg
            echom 'Failed to start ASR Python script, status: ' . l:status
            echohl None
            let s:asr_job = v:null
            return
        endif
    catch
        echohl ErrorMsg
        echom 'Error checking job status: ' . v:exception
        echohl None
        let s:asr_job = v:null
        return
    endtry

    let s:asr_active = 1
    let s:pending_text = ''
    let s:last_partial_len = 0
    let s:has_partial = 0
    let s:in_sentence = 0
    let s:sentence_start_line = 0
    let s:sentence_start_col = 0
    let s:is_stopping = 0
    let s:start_time = reltime()  " Record start time for protection period

    " Set up autocommands to detect user modifications
    augroup ZaiASRStop
        autocmd!
        " Detect text changes in insert mode
        autocmd TextChangedI * call s:check_user_modification()
        " Detect cursor movement (backup detection)
        autocmd CursorMovedI * call s:check_user_modification()
        " Update sign position when cursor moves
        autocmd CursorMovedI * call s:show_asr_sign()
        " Stop when leaving insert mode
        autocmd InsertLeave * call s:stop_asr()
    augroup END

    " Record initial buffer state
    let l:current_buf = bufnr('')
    let s:last_changedtick = getbufvar(l:current_buf, 'changedtick')

    " Define signs and highlight if not already defined, start visual feedback
    call s:define_asr_signs()
    call s:define_partial_highlight()
    call s:start_asr_animation()

    " Show status message
    echohl MoreMsg
    echom 'ASR started - speak now, type any key to stop'
    echohl None
endfunction

" Stop the ASR session
function! s:stop_asr() abort
    if !s:asr_active || s:is_stopping
        return
    endif

    let s:is_stopping = 1
    let s:asr_active = 0

    " Clear autocommands
    silent! autocmd! ZaiASRStop
    silent! augroup! ZaiASRStop

    " Send stop signal to Python script
    if type(s:asr_job) == v:t_job
        try
            let l:job_status = job_status(s:asr_job)
            if l:job_status ==# 'run'
                call ch_sendraw(s:asr_job, "STOP\n")
            endif
        catch
        endtry
    endif

    "" Stop the job (with timeout)
    "if type(s:asr_job) == v:t_job
    "    let l:wait_time = 0
    "    while job_status(s:asr_job) ==# 'run' && l:wait_time < 500
    "        sleep 10m
    "        let l:wait_time += 10
    "    endwhile

    "    " Force close if still running
    "    if job_status(s:asr_job) ==# 'run'
    "        call job_stop(s:asr_job, 'kill')
    "    endif
    "    let s:asr_job = v:null
    "endif
    " 停止作业（使用正确的参数）
    if type(s:asr_job) == v:t_job
        try
            " 先尝试正常停止
            let l:job_status = job_status(s:asr_job)
            if l:job_status ==# 'run'
                call job_stop(s:asr_job)

                " 等待一小段时间让进程正常退出
                let l:wait_time = 0
                while job_status(s:asr_job) ==# 'run' && l:wait_time < 50
                    sleep 10m
                    let l:wait_time += 10
                endwhile
            endif

            " 如果还在运行，强制终止
            if job_status(s:asr_job) ==# 'run'
                call job_stop(s:asr_job, 'kill')
                sleep 10m  " 给一点时间让系统处理
            endif
        catch
        endtry

        let s:asr_job = v:null
    endif

    " 重置状态变量
    let s:pending_text = ''
    let s:last_partial_len = 0
    let s:has_partial = 0
    let s:in_sentence = 0
    let s:sentence_start_line = 0
    let s:sentence_start_col = 0
    let s:is_stopping = 0

    " Show stop message
    echohl MoreMsg
    echom 'ASR stopped'
    echohl None

    " Stop visual feedback
    call s:stop_asr_animation()

    " Clear partial text highlight
    call s:clear_partial_highlight()
endfunction

" Delete specified number of characters in insert mode
function! s:delete_chars(count) abort
    if a:count <= 0
        return
    endif
    " Send backspace keys to delete characters
    call feedkeys(repeat("\<BS>", a:count), 'n')
endfunction

" Insert pending text before stopping (called on key press)
function! s:maybe_insert_and_stop() abort
    if !s:asr_active
        return
    endif

    " Check if we're in the protection period (first 5 seconds after starting)
    let l:elapsed = reltimefloat(reltime(s:start_time))
    if l:elapsed < 5.0
        " Ignore stop signals during protection period
        echom 'ASR: Ignoring stop signal during protection period (' . string(l:elapsed) . 's < 5.0s)'
        return
    endif

    " Only stop if user explicitly typed a key (not during ASR operation)
    " Check if we're currently receiving recognition results
    if s:has_partial || !empty(s:pending_text)
        " We're in the middle of recognition, don't stop
        echom 'ASR: Ignoring stop signal, recognition in progress'
        return
    endif

    echom 'ASR: User requested stop by typing/moving'

    " Partial text is already displayed, just clear tracking and stop
    let s:pending_text = ''
    let s:last_partial_len = 0
    let s:has_partial = 0

    " Then stop ASR
    call s:stop_asr()
endfunction

" Check if user modified the buffer during ASR
function! s:check_user_modification() abort
    if !s:asr_active || s:is_stopping
        return
    endif

    " Check if we're in the protection period (first 5 seconds)
    let l:elapsed = reltimefloat(reltime(s:start_time))
    if l:elapsed < 5.0
        " Ignore buffer changes during protection period
        return
    endif

    " Check if buffer was modified by user (not by ASR)
    let l:current_buf = bufnr('')
    let l:current_changedtick = getbufvar(l:current_buf, 'changedtick')

    " Only stop if user typed something (changedtick increased)
    " AND we're not in the middle of displaying ASR results
    if l:current_changedtick > s:last_changedtick && !s:has_partial && empty(s:pending_text)
        echom 'ASR: Detected user input, stopping recognition...'
        call s:stop_asr()
        return
    endif

    " Update tracking to avoid detecting our own changes
    let s:last_changedtick = l:current_changedtick
endfunction

" Callback for stdout (received recognized text)
function! s:on_stdout(job_id, data) abort
    let l:line = a:data

    " Parse JSON message from Python script
    try
        let l:msg = json_decode(l:line)

        " Handle different message types
        if has_key(l:msg, 'type')
            if l:msg.type ==# 'status'
                " Status message (for debugging)
                if has_key(l:msg, 'message')
                    echom 'ASR: ' . l:msg.message
                endif

            elseif l:msg.type ==# 'partial'
                " Partial recognition result (intermediate)
                " Replace the current sentence text from its start position
                if has_key(l:msg, 'text') && !empty(l:msg.text)
                    let l:new_text = l:msg.text

                    " Record start position on first partial result
                    " Use CURRENT cursor position for each new sentence
                    if !s:in_sentence
                        let s:sentence_start_line = line('.')
                        let s:sentence_start_col = col('.')
                        let s:in_sentence = 1
                    endif

                    " Get current line and replace from start position to end
                    let l:current_line = s:sentence_start_line
                    let l:line_content = getline(l:current_line)
                    let l:before_text = strcharpart(l:line_content, 0, s:sentence_start_col - 1)

                    " Set the new line content
                    call setline(l:current_line, l:before_text . l:new_text)

                    " Highlight the partial text with underline
                    call s:highlight_partial_text(s:sentence_start_col, s:sentence_start_col + strchars(l:new_text) - 1)

                    " Update changedtick so we don't detect our own changes
                    let l:current_buf = bufnr('')
                    let s:last_changedtick = getbufvar(l:current_buf, 'changedtick')

                    " Move cursor to end of inserted text using Right arrow keys
                    let l:target_col = s:sentence_start_col + strchars(l:new_text)
                    let l:current_col = col('.')
                    if l:target_col > l:current_col
                        call feedkeys(repeat("\<Right>", l:target_col - l:current_col), 'it')
                    endif

                    " Update tracking variables
                    let s:pending_text = l:new_text
                    let s:last_partial_len = strchars(l:new_text)
                    let s:has_partial = 1
                endif

            elseif l:msg.type ==# 'final'
                " Final recognition result
                " Replace the current sentence text from its start position
                if has_key(l:msg, 'text') && !empty(l:msg.text)
                    let l:final_text = l:msg.text

                    " Get current line and replace from start position to end
                    let l:current_line = s:sentence_start_line
                    let l:line_content = getline(l:current_line)
                    let l:before_text = strcharpart(l:line_content, 0, s:sentence_start_col - 1)

                    " Set the new line content with final text
                    call setline(l:current_line, l:before_text . l:final_text)

                    " Clear the partial text highlight (sentence is now final)
                    call s:clear_partial_highlight()

                    " Update changedtick so we don't detect our own changes
                    let l:current_buf = bufnr('')
                    let s:last_changedtick = getbufvar(l:current_buf, 'changedtick')

                    " Move cursor to end of inserted text using Right arrow keys
                    let l:target_col = s:sentence_start_col + strchars(l:final_text)
                    let l:current_col = col('.')
                    if l:target_col > l:current_col
                        call feedkeys(repeat("\<Right>", l:target_col - l:current_col), 'it')
                    endif

                    " Reset sentence state
                    let s:pending_text = ''
                    let s:last_partial_len = 0
                    let s:has_partial = 0
                    let s:in_sentence = 0
                    let s:sentence_start_line = 0
                    let s:sentence_start_col = 0
                endif

            elseif l:msg.type ==# 'error'
                " Error message
                echohl ErrorMsg
                echom 'ASR Error: ' . get(l:msg, 'message', 'Unknown error')
                echohl None
                call s:stop_asr()
            endif
        endif
    catch
        " Not a JSON line, ignore
    endtry
endfunction

" Callback for stderr (debug/error messages)
function! s:on_stderr(job_id, data) abort
    " Log stderr messages for debugging
    echom 'ASR stderr: ' . a:data
endfunction

" Callback for job exit
function! s:on_exit(job_id, exit_code) abort
    if s:asr_active
        echohl WarningMsg
        echom 'ASR process exited with code: ' . a:exit_code
        echohl None
        call s:stop_asr()
    endif
endfunction

" Toggle ASR on/off
function! zai#asr#toggle() abort
    if s:asr_active
        call s:stop_asr()
    else
        call zai#asr#start()
    endif
endfunction

" Check if ASR is active
function! zai#asr#is_active() abort
    return s:asr_active
endfunction

" ============================================================================
" Setup function - call this from your vimrc or plugin
" ============================================================================

" Setup key mappings and commands
function! zai#asr#setup() abort
    " Check platform support
    if has('win32')
        echohl WarningMsg
        echom 'zai#asr: ASR 功能不支持 Windows 平台'
        echohl None
        return
    endif

    " Check if zasr service is available
    let l:zasr_available = filereadable(s:zasrctl)
    let l:zasr_running = s:is_zasr_running()

    if !l:zasr_available
        echohl WarningMsg
        echom 'zai#asr: ZASR 服务未安装'
        echom '运行: python3 python3/install.py --install-zasr'
        echohl None
    elseif !l:zasr_running
        echohl WarningMsg
        echom 'zai#asr: ZASR 服务未运行'
        echom '提示: 启动 ASR 时将自动启动 ZASR 服务'
        echohl None
    endif

    " Map Ctrl+G in insert mode to toggle ASR
    inoremap <silent> <C-G> <Cmd>call zai#asr#toggle()<CR>
    "inoremap <silent> <C-G> <Cmd>call zai#asr#start()<CR>

    " Create user command
    command! -nargs=0 ASRToggle call zai#asr#toggle()
    command! -nargs=0 ASRStart call zai#asr#start()
    command! -nargs=0 ASRStop call s:stop_asr()

    " Show startup message
    echohl MoreMsg
    echom 'zai#asr loaded. Press <C-G> in insert mode to start voice input, toggle to stop.'
    echohl None
endfunction

" ============================================================================
" Sign Column Visual Feedback
" ============================================================================

" Define ASR signs
function! s:define_asr_signs() abort
    " Define base ASR sign (microphone)
    try
        execute 'sign define ZaiASR text=🎤 texthl=Special'
    catch
        " Fallback to ASCII
        execute 'sign define ZaiASR text=* texthl=Special'
    endtry

    " Define animated sign frames (pulse effect)
    let l:frame = 0
    for l:icon in s:asr_sign_icons
        try
            execute printf('sign define ZaiASRFrame%d text=%s texthl=Special',
                         \ l:frame, l:icon)
        catch
            execute printf('sign define ZaiASRFrame%d text=%s texthl=Special',
                         \ l:frame, '.')
        endtry
        let l:frame += 1
    endfor
endfunction

" Place sign on current line
function! s:show_asr_sign() abort
    if !s:asr_active
        return
    endif

    let l:current_line = line('.')
    let l:current_buf = bufnr('')

    " Remove old sign if exists
    if s:asr_sign_id != 0
        execute printf('silent! sign unplace %d buffer=%d', s:asr_sign_id, l:current_buf)
    endif

    " Place new sign with unique ID (line + 10000 to avoid conflicts)
    let s:asr_sign_id = l:current_line + 10000
    execute printf('sign place %d line=%d name=ZaiASR buffer=%d', s:asr_sign_id, l:current_line, l:current_buf)
endfunction

" Update sign with animation frame
function! s:update_asr_sign() abort
    if !s:asr_active || s:asr_sign_timer == 0
        return
    endif

    let l:current_line = line('.')
    let l:current_buf = bufnr('')

    " Remove current sign
    if s:asr_sign_id != 0
        execute printf('silent! sign unplace %d buffer=%d', s:asr_sign_id, l:current_buf)
    endif

    " Place next frame
    let l:frame_name = 'ZaiASRFrame' . s:asr_sign_frame
    let s:asr_sign_id = l:current_line + 10000
    execute printf('sign place %d line=%d name=%s buffer=%d', s:asr_sign_id, l:current_line, l:frame_name, l:current_buf)

    " Cycle to next frame
    let s:asr_sign_frame = (s:asr_sign_frame + 1) % len(s:asr_sign_icons)
endfunction

" Start animation
function! s:start_asr_animation() abort
    " Stop any existing animation
    call s:stop_asr_animation()

    " Show initial sign
    call s:show_asr_sign()

    " Start timer to update every 500ms
    let s:asr_sign_timer = timer_start(500, {-> s:update_asr_sign()}, {'repeat': -1})
endfunction

" Stop animation and remove sign
function! s:stop_asr_animation() abort
    " Stop timer
    if s:asr_sign_timer != 0
        call timer_stop(s:asr_sign_timer)
        let s:asr_sign_timer = 0
    endif

    " Remove sign
    if s:asr_sign_id != 0
        let l:current_buf = bufnr('')
        execute printf('silent! sign unplace %d buffer=%d', s:asr_sign_id, l:current_buf)
        let s:asr_sign_id = 0
    endif

    " Reset animation frame
    let s:asr_sign_frame = 0
endfunction

" ============================================================================
" Text Property for Partial Text Highlight
" ============================================================================

" Define highlight group and property type for partial text
function! s:define_partial_highlight() abort
    " Define highlight group with underline
    highlight default link ZaiASRPartialText Underlined
    highlight default ZaiASRPartialText cterm=underline ctermfg=Cyan gui=underline guifg=Cyan

    " Define property type (only if not already defined)
    if exists('*prop_type_add') && exists('*prop_type_get')
        " Check if property type already exists
        if empty(prop_type_get(s:partial_prop_type))
            call prop_type_add(s:partial_prop_type, {
                \ 'highlight': 'ZaiASRPartialText',
                \ 'priority': 10,
                \ 'combine': 1,
                \ 'start_incl': 0,
                \ 'end_incl': 0
                \ })
        endif
    endif
endfunction

" Add text property to highlight partial text
function! s:highlight_partial_text(start_col, end_col) abort
    if !exists('*prop_add')
        return
    endif

    let l:current_buf = bufnr('')
    let l:current_line = s:sentence_start_line

    " Remove old property if exists
    call s:clear_partial_highlight()

    " Add new property for the partial text range
    let s:partial_prop_id = prop_add(l:current_line, a:start_col, {
        \ 'type': s:partial_prop_type,
        \ 'end_lnum': l:current_line,
        \ 'end_col': a:end_col + 1,
        \ 'bufnr': l:current_buf
        \ })
endfunction

" Clear text property for partial text
function! s:clear_partial_highlight() abort
    if !exists('*prop_remove')
        return
    endif

    if s:partial_prop_id != 0
        let l:current_buf = bufnr('')
        try
            call prop_remove({'type': s:partial_prop_type, 'id': s:partial_prop_id, 'bufnr': l:current_buf}, 0, 0)
            let s:partial_prop_id = 0
        catch
        endtry
    endif
endfunction

" Restore cpoptions
let &cpo = s:save_cpo
unlet s:save_cpo

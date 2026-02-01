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

    "" Set up autocommands to stop on any key press
    "augroup ZaiASRStop
    "    autocmd!
    "    autocmd InsertCharPre * call s:maybe_insert_and_stop()
    "    autocmd CursorMovedI * call s:maybe_insert_and_stop()
    "    autocmd InsertLeave * call s:maybe_insert_and_stop()
    "augroup END

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

    "" Clear autocommands
    "autocmd! ZaiASRStop
    "augroup! ZaiASRStop

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

                    " Move cursor to end of new text
                    call cursor(l:current_line, strchars(l:before_text) + strchars(l:new_text) + 1)

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

                    " Move cursor to end of final text
                    call cursor(l:current_line, strchars(l:before_text) + strchars(l:final_text) + 1)

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

" Restore cpoptions
let &cpo = s:save_cpo
unlet s:save_cpo

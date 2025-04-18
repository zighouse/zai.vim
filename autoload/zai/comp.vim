scriptencoding utf-8

let s:fim_job = v:null
let s:fim_stop = ''
let s:fim_is_stop = v:false
let s:fim_result = []
let s:fim_win = 0
let s:fim_charcol = 0
let s:fim_mode = 0
let g:zai_fim_result = ''

function! s:string_as_list(str)
    let l:type = type(a:str)
    if l:type == v:t_string
        return [a:str]
    elseif l:type == v:t_list
        return a:str
    elseif l:type == v:t_none
        return []
    endif
endfunction

function! zai#comp#Complete(mode) abort
    call zai#init()

    let l:buf = bufnr('%')
    let l:pos = line('.')
    let l:col = col('.')
    let s:fim_charcol = charcol('.') - a:mode
    let s:fim_mode = a:mode
    let l:line = getline('.')
    let l:line_head = slice(l:line, 0, s:fim_charcol)
    let l:line_tail = slice(l:line, s:fim_charcol)
    let l:prefix_begin = max([1, l:pos - 300])
    let l:suffix_end   = min([line('$'), l:pos + 300])
    let l:prefix = s:string_as_list(getline(l:prefix_begin, l:pos - 1))
    if l:line_head != ''
        let l:prefix += [l:line_head]
    endif
    if l:pos == l:suffix_end
        let l:suffix = []
    else
        let l:suffix = [] + s:string_as_list(getline(l:pos + 1, l:suffix_end))
        let s:fim_stop = l:suffix[0]
    endif
    if l:line_tail != ''
        let l:suffix = [l:line_tail] + l:suffix
        let s:fim_stop = l:line_tail
    endif
    if exists('g:zai_debug')
        call appendbufline(g:zai_debug, '$', 'cursor:(' . l:pos . ',' . s:fim_charcol . ')  mode:'
                    \ . mode() . '  head:{'. l:line_head . '}  tail:{' . l:line_tail . '}')
        call appendbufline(g:zai_debug, '$', 'prefix<<EOF')
        for l:line in l:prefix
            call appendbufline(g:zai_debug, '$', l:line)
        endfor
        call appendbufline(g:zai_debug, '$', 'EOF')
        call appendbufline(g:zai_debug, '$', 'suffix<<EOF')
        for l:line in l:suffix
            call appendbufline(g:zai_debug, '$', l:line)
        endfor
        call appendbufline(g:zai_debug, '$', 'EOF')
    endif
    if s:fim_job == v:null
        let l:env = { 'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1' }
        if exists('g:zai_lang')
            let l:env['LANG'] = g:zai_lang
        endif
        let l:shell = has('win32') ? ['cmd', '/c'] : ['/bin/sh', '-c']
        let s:fim_job = job_start(l:shell + g:zai_cmp_cmd, {
                    \ 'out_cb':  function('s:task_on_fim_response'),
                    \ 'err_cb':  function('s:task_on_fim_response'),
                    \ 'exit_cb': function('s:task_on_fim_exit'),
                    \ 'err_msg': "Zai: There is an error.",
                    \ 'env': l:env,
                    \ 'in_io': 'pipe',
                    \ 'out_io': 'pipe',
                    \ 'err_io': 'pipe',
                    \ })
    endif
    let l:file_type = zai#util#get_file_type()
    let l:content = [':complete-type ' .. l:file_type, ':max-tokens 400', ':temperature 0.5']
    if len(l:suffix) != 0
        let l:content += [':suffix<<EOF'] +  l:suffix + ['EOF'] + l:prefix
    else
        let l:content += [':prefix<<EOF', l:prefix, 'EOF']
    endif
    let l:signature = zai#util#get_block_sign(l:content)
    let l:request = join(['<<' .. l:signature] + l:content + [l:signature], "\n")
    let l:req_msg = iconv(l:request . "\n", &encoding, 'utf-8')
    let l:channel = job_getchannel(s:fim_job)
    let s:fim_is_stop = v:false
    let s:fim_result = []
    call ch_sendraw(l:channel, l:req_msg)
endfunction

function! s:task_on_fim_response(channel, msg) abort
    if s:fim_is_stop
        return
    endif
    if type(a:msg) == v:t_list
        for l:line in a:msg
            if l:line == s:fim_stop || l:line == '```'
                let s:fim_is_stop = v:true
                break
            endif
            let s:fim_result += [iconv(l:line, 'utf-8', &encoding)]
        endfor
    else
        let s:fim_result += [iconv(a:msg, 'utf-8', &encoding)]
        if a:msg == s:fim_stop || a:msg == '```'
            let s:fim_is_stop = v:true
        endif
    endif
    if !s:fim_win
        let s:fim_win = popup_create(s:fim_result, {
                    \ 'pos': 'topleft',
                    \ 'line': 'cursor',
                    \ 'col': 'cursor+1',
                    \ 'highlight': 'Comment',
                    \ 'moved': 'any',
                    \ 'callback': 's:fim_on_hide_popup',
                    \ 'filter': 's:fim_popup_filter',
                    \ 'filter_required': v:true,
                    \ })
    else
        call popup_show(s:fim_win)
        let l:fim_bufnr = winbufnr(s:fim_win)
        call appendbufline(l:fim_bufnr, '$', a:msg)
    endif
endfunction

function! s:fim_popup_filter(winid, key) abort
    if a:key == "\<CR>"
        let l:line = getline('.')
        let l:fim_charcol = charcol('.') - s:fim_mode
        let l:before = slice(l:line, 0, s:fim_charcol)
        let l:after = slice(l:line, s:fim_charcol)
        
        call setline('.', l:before . s:fim_result[0])
        
        if len(s:fim_result) > 1
            call append('.', s:fim_result[1:])
        endif
        
        if !empty(l:after)
            call setline(line('.') + len(s:fim_result) - 1, 
                  \ getline(line('.') + len(s:fim_result) - 1) . l:after)
        endif
        
        call popup_close(a:winid)
        let s:fim_win = 0
        let g:zai_fim_result = join(s:fim_result, "\n")
        let s:fim_result = []
        return 1
    else
        return popup_filter_menu(a:winid, a:key)
    endif
endfunction

function! s:fim_on_hide_popup(id, result) abort
    try
        let l:channel = job_getchannel(s:fim_job)
        call ch_sendraw(l:channel, ":exit\n")
        sleep 100m
    catch
        echo 'caught: ' .. v:exception
    endtry
    let s:fim_win = 0
    let s:fim_result = []
endfunction

function! s:task_on_fim_exit(job, status) abort
    if s:fim_is_stop
        return
    endif
    let s:fim_job = v:null
    let s:fim_is_stop = v:true
endfunction


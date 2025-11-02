scriptencoding utf-8

let s:home = expand('<sfile>:h:h')
let s:path_sep = has('win32') ? '\' : '/'
let g:zai_input_mode = 'text' " json, text

let s:script_path = s:home . '/python3/aichat.py'

function! zai#init() abort
    if exists('s:inited')
        return
    endif
    let s:inited = v:true
    let l:log_dir = zai#util#log_path()

    let s:fim_url = exists('g:zai_fim_url') ?  g:zai_fim_url : 'https://api.deepseek.com/beta'
    let s:fim_api_key_name = exists('g:zai_fim_api_key_name') ? g:zai_fim_api_key_name : 'DEEPSEEK_API_KEY'
    let s:fim_model = exists('g:zai_fim_model') ? g:zai_fim_model : 'deepseek-chat'

    let s:python_cmd = has('win32') ? 'python' : '/usr/bin/env python3' 

    if has('win32')
        let s:base_url = exists('g:zai_base_url') ? ['--base-url', g:zai_base_url] : []
        let s:api_key_name = exists('g:zai_api_key_name') ? ['--api-key-name', g:zai_api_key_name] : []
        let s:opt_model = exists('g:zai_default_model') ? ['--model', g:zai_default_model] : []
        let s:use_ai = exists('g:zai_use_ai') ? ['--use-ai', g:zai_use_ai] : []
        let g:zai_cmd = [ s:python_cmd, s:script_path, '--log-dir', l:log_dir,
                    \ '--' . g:zai_input_mode] + s:base_url + s:api_key_name + s:opt_model + s:use_ai
        let g:zai_cmp_cmd = [ s:python_cmd, s:script_path, '--text', '--no-log', '--silent',
                    \ '--base-url', s:fim_url, '--api-key-name', s:fim_api_key_name, '--model', s:fim_model]
    else
        let s:opt_script = ' "' . s:script_path . '"'
        let s:opt_log_dir = ' --log-dir="' . l:log_dir . '"'
        let s:opt_input_mode = ' --' . g:zai_input_mode
        let s:base_url = exists('g:zai_base_url') ? ' --base-url=' . g:zai_base_url : ''
        let s:api_key_name = exists('g:zai_api_key_name') ? ' --api-key-name=' . g:zai_api_key_name : ''
        let s:opt_model = exists('g:zai_default_model') ? ' --model="' . g:zai_default_model . '"' : ''
        let s:use_ai = exists('g:zai_use_ai') ? ' --use-ai="' . g:zai_use_ai . '"' : ''
        let g:zai_cmd = [ s:python_cmd . s:opt_script . s:opt_log_dir . s:opt_input_mode
                    \ . s:base_url . s:api_key_name . s:opt_model . s:use_ai ]
        let g:zai_cmp_cmd = [ s:python_cmd . s:opt_script . ' --text' . ' --no-log' . ' --silent'
                    \ . ' --base-url=' . s:fim_url . ' --api-key-name=' . s:fim_api_key_name . ' --model=' . s:fim_model ]
    endif

    if exists('g:zai_lang') && match(g:zai_lang, 'zh') != -1
      let s:zh_lang = 1
    elseif match(get(environ(), 'LANG', ''), 'zh') != -1 || match(get(environ(), 'LANGUAGE', ''), 'zh') != -1
      let s:zh_lang = 1
    else
      let s:zh_lang = 0
    endif
    if !exists('g:zai_print_prompt')
      if s:zh_lang
        let g:zai_print_prompt = ['**用户：**', '**助手：**']
      else
        let g:zai_print_prompt = ['**User:**', '**Assistant:**']
      endif
    endif
endfunction

function! zai#Open() abort
    call zai#chat#Open()
endfunction

function! zai#Add() abort
    call zai#chat#Add()
endfunction

function! zai#AddRange(line1, line2) range abort
    call zai#chat#AddRange(a:line1, a:line2)
endfunction

function! zai#Go() abort
    call zai#chat#Go()
endfunction

function! zai#Close() abort
    call zai#chat#Close()
endfunction

function! zai#Complete(mode) abort
    call zai#comp#Complete(a:mode)
endfunction

function! zai#Load() abort
    call zai#chat#Load()
endfunction

function! zai#EditConfig() abort
    return zai#util#EditAssistants()
endfunction

function! zai#OpenLog() abort
    return zai#util#OpenLog()
endfunction

function! zai#GrepLog(pat) abort
    return zai#util#GrepLog(a:pat)
endfunction


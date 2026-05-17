" Zai.Vim - AI Assistant Integration for Vim
" Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
"
" Licensed under the MIT License
"
" Autoload functions for :AI shell/audit/policy commands.

let s:plugin_root = expand('<sfile>:h:h:h')
let s:path_sep = has('win32') ? '\' : '/'

function! s:python_call(code) abort
    let l:py = 'import sys; sys.path.insert(0, "' . s:plugin_root . s:path_sep . 'python3"); '
    let l:py .= a:code
    let l:py_cmd = executable('python3') ? 'python3' : 'python'
    return trim(system(l:py_cmd . ' -c ' . shellescape(l:py)))
endfunction

function! zai#shell#Status() abort
    let l:raw = s:python_call('import json; from tool_shell import get_safety_status; d, e = get_safety_status(); print(json.dumps(d) if d else "error")')
    if l:raw ==# 'error' || empty(l:raw)
        echohl ErrorMsg
        echomsg '[shell] failed to get safety status'
        echohl None
        return
    endif
    try
        let l:info = json_decode(l:raw)
    catch
        echohl ErrorMsg
        echomsg '[shell] failed to parse safety status'
        echohl None
        return
    endtry

    " Sandbox
    let l:sandbox = get(l:info, 'sandbox', {})
    let l:sb_effective = get(l:sandbox, 'effective', 'unknown')
    let l:sb_degraded = get(l:sandbox, 'degraded', v:false)

    " Policy
    let l:policy = get(l:info, 'policy', {})
    let l:user_rules = get(l:policy, 'user_rules', 0)
    let l:project_rules = get(l:policy, 'project_rules', 0)

    " Classifier
    let l:classifier = get(l:info, 'classifier', {})
    let l:cl_avail = get(l:classifier, 'available', v:false)
    let l:cl_model = get(l:classifier, 'model', '')

    " Audit
    let l:audit = get(l:info, 'audit', {})
    let l:au_enabled = get(l:audit, 'enabled', v:false)

    " Build status line (≤ 80 chars)
    let l:sb_str = l:sb_degraded ? l:sb_effective . ' (DEGRADED: ' . get(l:sandbox, 'degraded_reason', 'unknown') . ')' : l:sb_effective
    let l:policy_str = l:user_rules . ' user, ' . l:project_rules . ' project'
    let l:cl_str = l:cl_avail ? (empty(l:cl_model) ? 'active' : 'active (' . l:cl_model . ')') : 'unavailable'
    let l:au_str = l:au_enabled ? 'enabled' : 'disabled'

    let l:msg = '[shell] sandbox: ' . l:sb_str . ' | policy: ' . l:policy_str . ' | classifier: ' . l:cl_str . ' | audit: ' . l:au_str
    echomsg l:msg
endfunction

function! zai#shell#Audit(...) abort
    let l:session_id = a:0 > 0 ? a:1 : ''
    let l:code = 'from shell.audit import AuditLogger; import json; '
    if empty(l:session_id)
        let l:code .= 'entries, err = AuditLogger().query(limit=100); '
    else
        let l:code .= 'entries, err = AuditLogger().query(session_id=' . string(l:session_id) . ', limit=100); '
    endif
    let l:code .= 'print(json.dumps({"entries": entries, "error": err.message if err else ""}))'
    let l:raw = s:python_call(l:code)
    if empty(l:raw)
        echohl WarningMsg
        echomsg '[shell] no audit entries found'
        echohl None
        return
    endif
    try
        let l:data = json_decode(l:raw)
    catch
        echohl ErrorMsg
        echomsg '[shell] failed to parse audit results'
        echohl None
        return
    endtry
    if !empty(get(l:data, 'error', ''))
        echohl ErrorMsg
        echomsg '[shell] audit query error: ' . l:data.error
        echohl None
        return
    endif
    let l:entries = get(l:data, 'entries', [])
    if empty(l:entries)
        echomsg '[shell] no audit entries found'
        return
    endif
    for l:entry in l:entries[:20]
        let l:ts = get(l:entry, 'timestamp', '')[:19]
        let l:sid = get(l:entry, 'session_id', '')
        let l:cmd = get(get(l:entry, 'command', {}), 'sanitized', '')
        let l:result = get(get(l:entry, 'execution', {}), 'success', v:false) ? 'OK' : 'FAIL'
        echomsg l:ts . ' [' . l:sid . '] ' . l:result . ' ' . l:cmd[:60]
    endfor
    if len(l:entries) > 20
        echomsg '... and ' . (len(l:entries) - 20) . ' more entries (showing first 20)'
    endif
endfunction

function! zai#shell#Policy() abort
    let l:raw = s:python_call('from shell_policy import get_permission_engine; import json; engine = get_permission_engine(); print(json.dumps(engine.get_rules_list()))')
    if empty(l:raw)
        echomsg '[shell] no policy rules loaded'
        return
    endif
    try
        let l:rules = json_decode(l:raw)
    catch
        echohl ErrorMsg
        echomsg '[shell] failed to parse policy rules'
        echohl None
        return
    endtry
    if empty(l:rules)
        echomsg '[shell] no policy rules loaded'
        return
    endif
    for l:rule in l:rules
        let l:behavior = get(l:rule, 'behavior', '?')
        let l:match_type = get(l:rule, 'type', '?')
        let l:pattern = get(l:rule, 'pattern', '?')
        let l:source = get(l:rule, 'source', '?')
        echomsg '[' . l:behavior . '] ' . l:match_type . ':' . l:pattern . ' (source: ' . l:source . ')'
    endfor
endfunction

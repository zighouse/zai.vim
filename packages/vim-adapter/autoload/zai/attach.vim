scriptencoding utf-8
" @zaivim/vim-adapter — selection/buffer/file attach (Story 4.1.2 Phase P0).
"
" Appends code to the CURRENT session's input buffer, wrapped in a markdown
" fence labeled with the source buffer's filetype. Behavior matches the old
" autoload/zai/chat.vim s:append (lines 583-614): the attached code goes into
" the input buffer — NOT into message history — so the user composes their
" question alongside the code and sends everything as a single message via
" <CR> (chat.send). No Node-side chat.attach RPC is needed; the next chat.send
" naturally carries the attached code as message content.
"
" Design note: a Node `chat.attach` RPC was originally planned (see Story
" 4.1.2 plan AD-2), but deferred — Vim-side-only attachment is sufficient for
" P0 parity. Future use cases (TUI attach, CLI pipe attach) may revisit.

" Append text (string or list of lines) to the current session's input buffer,
" wrapped in a markdown fence. Auto-creates a session if none exists.
" Strips leading/trailing blank lines. {filetype} labels the fence; pass '' to
" use the source buffer's &filetype at the moment of call.
function! zai#attach#content(selected, ...) abort
  let l:filetype = a:0 > 0 ? a:1 : ''
  if type(a:selected) == v:t_list
    let l:content = zai#util#strip_list(a:selected)
  else
    let l:content = zai#util#strip_list(split(a:selected, '\n', 1))
  endif
  if empty(l:content) | return | endif

  " Capture source filetype BEFORE ensure_session (which may switch buffers).
  " Caller can override via explicit 2nd arg (used by zai#attach#file).
  if empty(l:filetype)
    let l:filetype = zai#util#get_file_type()
  endif

  if !s:ensure_session() | return | endif
  let l:ibuf = s:current_ibuf()
  if l:ibuf == -1
    echoerr 'zai: no input buffer available for attach'
    return
  endif

  call s:append_fenced(l:ibuf, l:content, l:filetype)
endfun

" Range command: `:'<,'>ZaiAdd` or `:3,10ZaiAdd`.
" Reads lines from the buffer the user was editing when invoking the command.
function! zai#attach#range(line1, line2) abort range
  let l:lines = getbufline(bufnr('%'), a:line1, a:line2)
  call zai#attach#content(l:lines)
endfun

" Whole-buffer attach: `:ZaiAddBuffer` (or normal-mode `:ZaiAdd` if user
" prefers to attach everything in the current buffer without a range).
function! zai#attach#buffer() abort
  let l:lines = getbufline(bufnr('%'), 1, '$')
  call zai#attach#content(l:lines)
endfun

" Attach a file from disk: `:ZaiAddFile <path>`. Filetype is derived from the
" file extension (matches old behavior where attach read extension when the
" source was a different file).
function! zai#attach#file(path) abort
  if empty(a:path)
    echoerr 'zai: attach file requires a path argument'
    return
  endif
  if !filereadable(a:path)
    echoerr 'zai: cannot read file: ' . a:path
    return
  endif
  let l:lines = readfile(a:path)
  let l:filetype = fnamemodify(a:path, ':e')
  call zai#attach#content(l:lines, l:filetype)
endfun

" Internal: append {content} (list of lines) to {ibuf} wrapped in fence.
" Idempotent buffer modification — sets &modifiable during the write, leaves
" it modifiable afterward (input buffer must remain editable for typing).
function! s:append_fenced(ibuf, content, filetype) abort
  let l:fence = zai#util#get_fence_marker(a:content)
  let l:end = getbufinfo(a:ibuf)[0].linecount
  call setbufvar(a:ibuf, '&modifiable', 1)
  " Separator: if input buffer is non-empty, add a blank line before the fence
  " so consecutive attaches don't visually run together.
  if l:end > 1 || !empty(getbufline(a:ibuf, 1)[0])
    call appendbufline(a:ibuf, l:end, '')
    let l:end += 1
  endif
  call appendbufline(a:ibuf, l:end, l:fence . a:filetype)
  let l:end += 1
  for l:line in a:content
    call appendbufline(a:ibuf, l:end, l:line)
    let l:end += 1
  endfor
  call appendbufline(a:ibuf, l:end, l:fence)
endfun

" Internal: ensure at least one session exists. If none, create one and block
" (up to 2s) until session.create response arrives. Returns 1 on success.
" The blocking wait mirrors the old s:ui_open behavior — synchronous from the
" user's perspective even though session.create is async at the RPC layer.
function! s:ensure_session() abort
  if !empty(zai#chat#list_chats())
    return 1
  endif
  call zai#chat#start('')
  for l:i in range(40)
    if !empty(zai#chat#list_chats()) | break | endif
    sleep 50m
  endfor
  return !empty(zai#chat#list_chats())
endfun

" Internal: resolve current session's input buffer, or -1 if no session.
" Falls back to the most recently added session's ibuf if current_id is unset
" (race window: session just created, current_id not yet assigned).
function! s:current_ibuf() abort
  let l:chats = zai#chat#list_chats()
  if empty(l:chats) | return -1 | endif
  let l:cur = zai#chat#current_id()
  if !empty(l:cur) && has_key(l:chats, l:cur)
    return l:chats[l:cur].ibuf_nr
  endif
  " Fallback: any chat dict entry (last-wins by dict insertion order in Vim 8+)
  return values(l:chats)[-1].ibuf_nr
endfun

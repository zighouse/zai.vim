scriptencoding utf-8
" @zaivim/vim-adapter utilities — minimal P0 subset.
" Extended in P1 with get_url/get_path/etc. (see Story 4.1.2 plan).

" Return the current buffer's filetype, or empty string if unset.
" Used by attach.vim to label markdown code fences.
function! zai#util#get_file_type() abort
  return &filetype
endfun

" Strip leading and trailing blank/whitespace-only lines from a list.
" Ported from old autoload/zai/util.vim — preserves interior blank lines.
function! zai#util#strip_list(lines) abort
  let l:lines = copy(a:lines)
  while !empty(l:lines) && l:lines[0] =~# '^\s*$'
    call remove(l:lines, 0)
  endwhile
  while !empty(l:lines) && l:lines[-1] =~# '^\s*$'
    call remove(l:lines, -1)
  endwhile
  return l:lines
endfun

" Generate a markdown fence marker longer than any run of backticks in {lines}.
" Avoids fence collisions when attaching code that itself contains ``` fences
" (CommonMark spec: a code block ends at the first fence with at least as many
" backticks as the opening fence). Ported from old autoload/zai/util.vim.
function! zai#util#get_fence_marker(lines) abort
  let l:blob = join(a:lines, "\n")
  let l:only_ticks = substitute(l:blob, '[^`]', ' ', 'g')
  let l:max_run = 0
  for l:run in split(l:only_ticks, ' ', 1)
    if len(l:run) > l:max_run | let l:max_run = len(l:run) | endif
  endfor
  return repeat('`', max([3, l:max_run + 1]))
endfun

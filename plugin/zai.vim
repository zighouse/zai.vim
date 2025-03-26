if exists('g:loaded_zai') || &compatible
    finish
endif
let g:loaded_zai = 1

command! Zai call zai#Open()
command! -range ZaiAdd call zai#AddRange(<line1>, <line2>)
command! ZaiGo call zai#Go()
command! ZaiClose call zai#Close()

nmap <Plug>Zai :Zai<CR>
nmap <Plug>ZaiGo :ZaiGo<CR>
nmap <Plug>ZaiClose :ZaiClose<CR>
vmap <Plug>ZaiAdd :<C-u>call zai#Add()<CR>

nmap <silent> <Leader>zo <Plug>Zai
nmap <silent> <Leader>zg <Plug>ZaiGo
nmap <silent> <leader>zX <Plug>ZaiClose
vmap <silent> <leader>za <Plug>ZaiAdd

# Key Mappings

Default keyboard shortcuts and mappings in Zai.Vim.

## Overview

Zai.Vim uses:
- **Leader key** for custom mappings (default: `\`)
- **Standard Vim keys** for navigation
- **Special keys** in specific modes

## Leader Key

The `<leader>` key is used for custom mappings.

**Default:** `\` (backslash)

**Check current leader:**
```vim
:echo mapleader
```

**Change leader in .vimrc:**
```vim
let mapleader = ","      " Use comma
let mapleader = "<Space>" " Use space
```

## Global Mappings

### Open Zai

| Mapping | Command | Mode |
|---------|---------|------|
| `<leader>zo` | `:Zai<CR>` | Normal |

**Description:** Open Zai chat interface

**Example:**
```vim
\zo              " If leader is \
```

### Close Zai

| Mapping | Command | Mode |
|---------|---------|------|
| `<leader>zX` | `:ZaiClose<CR>` | Normal |

**Description:** Close Zai interface

### Add Selection to Input

| Mapping | Command | Mode |
|---------|---------|------|
| `<leader>za` | `:ZaiAdd<CR>` | Visual |

**Description:** Add selected text to Zai input window

**Workflow:**
```vim
" Select text
v}

" Add to Zai
\za              " If leader is \

" Open Zai
:Zai

" Send with question
```

### Load Log

| Mapping | Command | Mode |
|---------|---------|------|
| `<leader>zl` | `:ZaiLoad<CR>` | Normal |

**Description:** Load Zai log as conversation context

### Preview in Browser

| Mapping | Command | Mode |
|---------|---------|------|
| `<leader>dp` | `:ZaiPreview<CR>` | Normal (Zai interface) |

**Description:** Preview chat in browser (requires markdown-preview.nvim)

## Input Window Mappings

### Send Message

| Mapping | Command | Mode |
|---------|---------|------|
| `<CR>` | Send content | Normal (input window) |

**Description:** Send input window content to AI

**Workflow:**
```vim
" Type message
iHow do I parse JSON?<Esc>

" Send
<CR>
```

## ASR (Voice Input) Mappings

### Toggle ASR

| Mapping | Command | Mode |
|---------|---------|------|
| `<C-G>` | Toggle ASR | Insert |

**Description:** Start/stop voice input

**Workflow:**
```vim
" Enter insert mode
i

" Start voice input
Ctrl-G

" Speak...

" Stop (or wait 3 sec silence)
Ctrl-G
```

## Navigation Mappings

### Window Navigation

Standard Vim window navigation:

| Mapping | Action |
|---------|--------|
| `Ctrl-w h` | Move to left window |
| `Ctrl-w j` | Move to window below |
| `Ctrl-w k` | Move to window above |
| `Ctrl-w l` | Move to right window |
| `Ctrl-w t` | Move to top window |
| `Ctrl-w b` | Move to bottom window |

### Window Splitting

| Mapping | Action |
|---------|--------|
| `Ctrl-w s` | Split horizontally |
| `Ctrl-w v` | Split vertically |
| `Ctrl-w q` | Close current window |
| `Ctrl-w o` | Close all other windows |

## Buffer Navigation

| Mapping | Action |
|---------|--------|
| `:bn` | Next buffer |
| `:bp` | Previous buffer |
| `:ls` | List buffers |
| `:b {n}` | Go to buffer n |

## Session Navigation Mappings

While there are no default key mappings for session navigation, you can create custom ones:

**Add to .vimrc:**
```vim
" Session navigation
autocmd FileType zai nnoremap <buffer> <C-n> :ZaiNext<CR>
autocmd FileType zai nnoremap <buffer> <C-p> :ZaiPrev<CR>
```

## Custom Mappings

### Create Your Own Mappings

Add to `.vimrc`:

```vim
" Quick open Zai with F5
nnoremap <F5> :Zai<CR>

" Quick close with F6
nnoremap <F6> :ZaiClose<CR>

" Send message with Alt-Enter (in terminal)
inoremap <Esc><CR> <Esc>:ZaiGo<CR>

" New session with Ctrl-N
nnoremap <C-n> :ZaiNew<CR>
```

### Context-Aware Mappings

```vim
" Only work in Zai windows
autocmd FileType zai nnoremap <buffer> <Leader>sn :ZaiNew<CR>
autocmd FileType zai nnoremap <buffer> <Leader>ss :ZaiGoto 0<CR>
autocmd FileType zai nnoremap <buffer> <Leader>sl :ZaiOpenLog<CR>
```

## Mode-Specific Mappings

### Normal Mode

```vim
" Quick add selection
vnoremap <leader>z :ZaiAdd<CR>
```

### Insert Mode

```vim
" Quick send with Ctrl-Enter (terminal)
inoremap <C-CR> <Esc>:ZaiGo<CR>
```

### Command Mode

```vim
" Quick Zai open from command mode
cabbrev z Zai
```

Now you can type `:z` instead of `:Zai`.

## Function Key Mappings

```vim
" Function keys for Zai operations
nnoremap <F5> :Zai<CR>
nnoremap <F6> :ZaiClose<CR>
nnoremap <F7> :ZaiNew<CR>
nnoremap <F8> :ZaiLoad<CR>
nnoremap <F9> :ZaiOpenLog<CR>
nnoremap <F10> :ZaiGrepLog
```

## Leader Customization Examples

### With Comma Leader

```vim
let mapleader = ","

" Now use shorter mappings
nnoremap <leader>z :Zai<CR>
nnoremap <leader>x :ZaiClose<CR>
vnoremap <leader>a :ZaiAdd<CR>
nnoremap <leader>l :ZaiLoad<CR>
```

### With Space Leader

```vim
let mapleader = " "

" Space + key for Zai
nnoremap <leader>z :Zai<CR>
nnoremap <leader>x :ZaiClose<CR>
nnoremap <leader>n :ZaiNew<CR>
```

## Terminal-Specific Mappings

### For Terminal Vim

```vim
" Alt-key mappings (may work in terminals)
nnoremap <A-z> :Zai<CR>
nnoremap <A-x> :ZaiClose<CR>
```

### For Neovim

```vim
" Neovim-specific mappings
nnoremap <A-z> :Zai<CR>
tnoremap <A-z> <C-\><C-n>:Zai<CR>
```

## Avoiding Mapping Conflicts

### Check if Mapped

```vim
" Check if a key is mapped
:map <key>
:map <leader>z
```

### Unmap Conflicting Keys

```vim
" Unmap a conflicting key
unmap <leader>z
vunmap <leader>a
```

### Use <LocalLeader>

```vim
" Use local leader for plugin-specific mappings
let maplocalleader = ","

" Use in filetypes
autocmd FileType zai nnoremap <buffer> <LocalLeader>s :ZaiNew<CR>
```

## Recommended Mappings

### Productivity-Focused

```vim
" Quick Zai operations
let mapleader = ","

nnoremap <leader>z :Zai<CR>
nnoremap <leader>x :ZaiClose<CR>
vnoremap <leader>a :ZaiAdd<CR>
nnoremap <leader>l :ZaiLoad<CR>
nnoremap <leader>n :ZaiNew<CR>
nnoremap <leader>o :ZaiOpenLog<CR>
```

### Session Management

```vim
" Quick session switching
nnoremap <leader>s0 :ZaiGoto 0<CR>
nnoremap <leader>s1 :ZaiGoto 1<CR>
nnoremap <leader>s2 :ZaiGoto 2<CR>
nnoremap <leader>sn :ZaiNext<CR>
nnoremap <leader>sp :ZaiPrev<CR>
```

### Tool Quick-Load

```vim
" Load common tools quickly
nnoremap <leader>tf :use tool file<CR>
nnoremap <leader>tw :use tool web<CR>
nnoremap <leader>ts :use tool shell<CR>
```

## Troubleshooting

### Mapping Not Working

**Check:**
1. Mapping is defined: `:map <key>`
2. Leader key is correct: `:echo mapleader`
3. No conflicting mappings
4. File type restrictions (buffer mappings)

### Terminal Issues

Some terminals don't support certain key combinations:

**Problem:** `<A-z>` not working

**Solutions:**
1. Use different mapping: `<leader>z` instead
2. Configure terminal to send proper escape sequences
3. Use `:map` to test key: press `Ctrl-v` then key to see what's sent

### Leader Key Conflicts

**Problem:** Plugin conflicts with leader mappings

**Solution:**
```vim
" Use different leader for Zai
nnoremap <Space>z :Zai<CR>
nnoremap <Space>x :ZaiClose<CR>
```

## Best Practices

1. **Keep Mappings Simple**
   - Easy to remember
   - Few modifier keys
   - Logical grouping

2. **Document Your Mappings**
   ```vim
   " Zai.Vim mappings
   " ,z  - Open Zai
   " ,x  - Close Zai
   " ,a  - Add selection
   " ,l  - Load log
   ```

3. **Test After Adding**
   ```vim
   " Add mapping
   nnoremap <leader>t :Zai<CR>

   " Test immediately
   " Press leader + t
   ```

4. **Use <Plug> for Plugins**
   ```vim
   " Define <Plug> mapping
   nnoremap <Plug>(ZaiOpen) :Zai<CR>

   " User can map easily
   nmap <leader>z <Plug>(ZaiOpen)
   ```

## Next Steps

- [Basic Commands](basic.md) - Essential commands
- [Session Management](session.md) - Multiple conversations
- [Input Commands](input.md) - Send messages and add content
- [Configuration Guide](../configuration/) - Customize behavior

## Related Topics

- [Installation Guide](../installation/) - Set up Zai.Vim
- [Vim Documentation](http://vimdoc.sourceforge.net/htmldoc/map.html) - Vim mapping reference
- [Session Commands](../configuration/session-commands.md) - Runtime configuration

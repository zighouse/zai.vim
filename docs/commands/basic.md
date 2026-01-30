# Basic Commands

Essential commands for opening, closing, and navigating the Zai interface.

## Opening Zai

### `:Zai` or `:ZaiChat`

Open the Zai chat interface.

**Usage:**
```vim
:Zai
```

**Key Mapping:** `<leader>zo` (normal mode)

**Behavior:**
- Creates the three-window Zai interface
- Opens first chat session if none exists
- Splits current window or opens in new tab

**Windows:**
1. **Top** - Session list
2. **Middle** - Display window (conversation)
3. **Bottom** - Input window (type messages here)

## Closing Zai

### `:ZaiClose`

Close the Zai interface.

**Usage:**
```vim
:ZaiClose
```

**Key Mapping:** `<leader>zX` (normal mode)

**Behavior:**
- Closes all Zai windows
- Preserves chat sessions in background
- Can reopen with `:Zai`

### `:q` (in Zai interface)

Close Zai from within the interface.

**Usage:**
```vim
:q
```

**Mode:** Zai interface only

**Note:** This only works when in Zai windows, not regular Vim buffers.

## Interface Overview

### Window Layout

```
┌────────────────────────────┐
│  Session List (0, 1, 2...) │  ← Top window
├────────────────────────────┤
│                            │
│  Conversation Display      │  ← Middle window
│                            │
├────────────────────────────┤
│ > Type message here...     │  ← Bottom window (input)
└────────────────────────────┘
```

### Navigation Between Windows

```
Ctrl-w k    " Move to window above
Ctrl-w j    " Move to window below
Ctrl-w h    " Move to window left
Ctrl-w l    " Move to window right
```

### Window-Specific Behavior

**Session List (Top):**
- Read-only
- Shows all chat sessions
- Navigate with `j`/`k` or arrow keys

**Display Window (Middle):**
- Read-only
- Shows conversation history
- Scroll with `j`/`k` or `Ctrl-d`/`Ctrl-u`

**Input Window (Bottom):**
- Editable
- Type messages here
- Press `<CR>` to send
- Use session commands with `:` prefix

## Sending Messages

### `:ZaiGo`

Send content from input window to AI.

**Usage:**
```vim
:ZaiGo
```

**Key Mapping:** `<CR>` (in input window, normal mode)

**Behavior:**
- Sends all text in input window
- Clears input window after sending
- Displays AI response in display window

### Input Workflow

1. Open Zai: `:Zai`
2. Move to input window (or it's automatically focused)
3. Enter insert mode: `i`
4. Type your message
5. Exit insert mode: `<Esc>`
6. Send message: `<CR>`

## Quick Start Workflow

```vim
" 1. Open Zai
:Zai

" 2. Input window is active, type message
iHello, how are you?<Esc>

" 3. Send the message
<CR>

" 4. Read response in display window
" (use Ctrl-w j to move between windows)

" 5. Type next message
iCan you help me with Python?<Esc>

" 6. Send
<CR>

" 7. Close when done
:ZaiClose
```

## Default Leader Key

Zai uses `<leader>` for key mappings.

**Default:** `\` (backslash)

**Common configurations:**
```vim
" In .vimrc
let mapleader = ","      " Use comma as leader
let mapleader = "<Space>" " Use space as leader
```

**Check current leader:**
```vim
:echo mapleader
```

## Configuration Integration

### Use with AI Assistants

```vim
" In .vimrc, set default AI
let g:zai_use_ai = "deepseek"

" Then open Zai
:Zai
```

### Auto-open on Vim Start

Add to `.vimrc`:
```vim
" Auto-open Zai when Vim starts
autocmd VimEnter * Zai
```

### Custom Key Mappings

```vim
" In .vimrc
" Use custom mapping to open Zai
nnoremap <F5> :Zai<CR>
nnoremap <F6> :ZaiClose<CR>
```

## Common Workflows

### Quick Question

```vim
:Zai
iWhat is the difference between list and tuple in Python?<Esc>
<CR>
```

### Code Explanation with Selection

```vim
" Select code
v}

" Add to Zai
:ZaiAdd

" Open Zai and ask
:Zai
iPlease explain this code.<Esc>
<CR>
```

### Reference Previous Conversation

```vim
" Load log
:ZaiLoad

" Select log file

" Open Zai
:Zai

" Continue conversation
iCan you elaborate on point 2?<Esc>
<CR>
```

## Troubleshooting

### Zai Won't Open

**Check:**
1. Python is available: `:echo has('python3')` (should be 1)
2. Plugin is loaded: `:scriptnames` (look for zai)
3. API key is set: `echo $DEEPSEEK_API_KEY`

### Windows Not Appearing

**Check:**
1. Vim supports window splitting: `:echo has('windows')` (should be 1)
2. Sufficient terminal size
3. No layout conflicts in `.vimrc`

### Input Window Not Accepting Text

**Check:**
1. You're in insert mode: `i`
2. Input window is focused (use `Ctrl-w j` to navigate)
3. No `insertmode` or `readonly` conflicts

## Next Steps

- [Session Management](session.md) - Multiple chat sessions
- [Log Management](log.md) - View and search history
- [Input Commands](input.md) - Add content and send messages
- [Key Mappings](key-mappings.md) - All keyboard shortcuts

## Related Topics

- [Installation Guide](../installation/) - Set up Zai.Vim
- [Configuration Guide](../configuration/) - Configure settings
- [Session Commands](../configuration/session-commands.md) - Runtime configuration

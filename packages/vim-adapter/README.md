# @zaivim/vim-adapter

Vim adapter for the zaivim AI engine. Provides VimScript commands (`:ZaiChat`, `:ZaiAgent`) that connect to the engine via a JSON-RPC over stdio bridge managed by the `zaivim vim-rpc-server` subcommand.

## Requirements

- **Vim 8.x** with `+job` and `+channel` features, or **Neovim 0.10+**
- The `zaivim` CLI binary installed and on `$PATH` (or configured via `g:zaivim_engine_path`)

## Installation

### vim-plug

```vim
Plug 'zai/vim', { 'dir': 'packages/vim-adapter' }
```

### packer.nvim

```lua
use({ 'zai/vim', dir = 'packages/vim-adapter' })
```

## Configuration

```vim
" Optional: path to zaivim CLI (default: 'zaivim' from $PATH)
let g:zaivim_engine_path = '/usr/local/bin/zaivim'

" Optional: compact (default) or verbose
let g:zaivim_chat_default_mode = 'compact'
```

## Usage

| Command | Description |
|---------|-------------|
| `:ZaiChat` | Open AI chat session in a split window |
| `:ZaiAgent [persona]` | Create an AI agent with optional persona name |
| `:ZaiSessions` | List all active chat sessions |
| `:ZaiImportConfig` | Reload zaivim configuration from disk |

### Keymaps (chat buffer)

| Key | Action |
|-----|--------|
| `<CR>` | Send current line as message |
| `<C-c>` | Cancel active streaming response |
| `<C-o>` | Toggle compact/verbose display mode |

### Keymaps (sessions list)

| Key | Action |
|-----|--------|
| `<CR>` | Switch to selected session |

## GBK/UTF-8 Encoding

On Windows with `&encoding=gbk`, the adapter automatically converts JSON-RPC messages between GBK and UTF-8 using Vim's `iconv()` function. If `iconv` is unavailable, encoding conversion is skipped with a warning and the adapter continues to function.

## Architecture

VimScript layer (227 non-comment lines) is deliberately thin:

- `plugin/zai_node.vim` — command definitions and VimLeave cleanup
- `autoload/zai/rpc.vim` — JSON-RPC channel management (Vim 8.x / Neovim dual path)
- `autoload/zai/chat.vim` — chat buffer rendering, phase statusline, compact/verbose modes
- `autoload/zai/agent.vim` — agent lifecycle and activity stream
- `autoload/zai/sessions.vim` — session list window with alive-state icons

All protocol logic, session management, and sanitization lives in the Node.js `vim-rpc-server` subcommand.

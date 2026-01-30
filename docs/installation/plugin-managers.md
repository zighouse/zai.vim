# Installation Using Plugin Managers

This page covers installing Zai.Vim using popular Vim plugin managers.

## vim-plug

[vim-plug](https://github.com/junegunn/vim-plug) is a minimalist Vim plugin manager.

### Installation

Add to your `.vimrc` (or `init.vim` for Neovim):

```vim
call plug#begin('~/.vim/plugged')

" Zai.Vim AI Assistant
Plug 'zighouse/zai'

call plug#end()
```

### Install Plugins

1. Reload `.vimrc` or restart Vim
2. Run in Vim:
   ```vim
   :PlugInstall
   ```

3. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

### Update

```vim
:PlugUpdate
```

## Vundle

[Vundle](https://github.com/VundleVim/Vundle.vim) is the classic Vim plugin manager.

### Installation

Add to your `.vimrc`:

```vim
filetype off

set rtp+=~/.vim/bundle/Vundle.vim
call vundle#begin()

" Zai.Vim AI Assistant
Plugin 'zighouse/zai'

call vundle#end()
filetype plugin indent on
```

### Install Plugins

1. Reload `.vimrc` or restart Vim
2. Run in Vim:
   ```vim
   :PluginInstall
   ```

3. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

### Update

```vim
:PluginUpdate
```

## lazy.nvim

[lazy.nvim](https://github.com/folke/lazy.nvim) is a modern plugin manager for Neovim (Lua).

### Installation

Add to your `init.lua`:

```lua
require("lazy").setup({
    {
        "zighouse/zai.vim",
        config = function()
            -- Optional: Set default model
            vim.g.zai_default_model = "deepseek-chat"
        end
    }
})
```

### Install Plugins

1. Reload `init.lua` or restart Neovim
2. Run in Neovim:
   ```vim
   :Lazy sync
   ```

3. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

### Update

```vim
:Lazy update
```

## pack.nvim (Neovim Native)

Neovim has built-in plugin support using packages.

### Installation

```lua
-- In init.lua
vim.g.zai_default_model = "deepseek-chat"
```

### Manual Setup

```bash
mkdir -p ~/.local/share/nvim/site/pack/plugins/start
cd ~/.local/share/nvim/site/pack/plugins/start
git clone https://github.com/zighouse/zai.vim.git
pip install -r requirements.txt
```

### Update

```bash
cd ~/.local/share/nvim/site/pack/plugins/start/zai.vim
git pull
```

## vim-addon-manager

[vim-addon-manager](https://github.com/MarcWeber/vim-addon-manager) is an alternative plugin manager.

### Installation

Add to your `.vimrc`:

```vim
call vam#ActivateAddons(['zighouse/zai'])
```

### Install

```vim
:InstallAddons zighouse/zai
```

## Dein.vim

[Dein.vim](https://github.com/Shougo/dein.vim) is a dark powered Vim/Neovim plugin manager.

### Installation

Add to your `.vimrc`:

```vim
call dein#begin('~/.cache/dein')

" Zai.Vim
call dein#add('zighouse/zai')

call dein#end()
```

### Install

```vim
:DeinInstall
```

### Update

```vim
:DeinUpdate
```

## Configuration After Installation

After installing with any plugin manager, configure Zai by adding to your `.vimrc`:

### Basic Configuration

```vim
" Set default model
let g:zai_default_model = "deepseek-chat"

" Set interface language (optional)
let g:zai_lang = 'en_US.UTF-8'

" Set log directory (optional)
let g:zai_log_dir = "~/.local/share/zai/log"

" Auto-enable ASR (optional)
let g:zai_auto_enable_asr = 1
```

### API Configuration

```vim
" DeepSeek (example)
let g:zai_base_url = "https://api.deepseek.com"
let g:zai_api_key_name = "DEEPSEEK_API_KEY"

" Or use AI assistants configuration file
let g:zai_use_ai = "deepseek"
```

See [Configuration Guide](../configuration/) for more details.

## Verify Installation

After installation and configuration, verify Zai is working:

```vim
" Open Zai interface
:Zai

" Show Zai help
:help zai
```

## Troubleshooting

### Plugin Not Loading

1. Check plugin manager is correctly installed
2. Verify `filetype plugin on` is in your `.vimrc`
3. Run `:scriptnames` to see if Zai is loaded

### Python Not Found

Ensure Python 3.6+ is installed:
```bash
python3 --version
```

Check if Vim has Python support:
```vim
:echo has('python3')
" Should output 1
```

### Dependencies Missing

Install Python dependencies:
```bash
cd ~/.vim/plugged/zai.vim  # or your plugin directory
pip install -r requirements.txt
```

### API Key Error

Set your API key in the environment:
```bash
export DEEPSEEK_API_KEY=sk-********************************
```

## Next Steps

- Configure your API keys in [Configuration Guide](../configuration/)
- Learn about [session commands](../commands/)
- Explore [AI tools](../tools/)

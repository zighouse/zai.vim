# Manual Installation

This page covers installing Zai.Vim manually without using a plugin manager.

## Linux/macOS Installation

### Step 1: Create Plugin Directory

```bash
mkdir -p ~/.vim/pack/plugins/start
cd ~/.vim/pack/plugins/start
```

### Step 2: Clone Repository

```bash
git clone https://github.com/zighouse/zai.vim.git
```

### Step 3: Install Python Dependencies

**Option A: Using requirements.txt**
```bash
cd ~/.vim/pack/plugins/start/zai.vim
pip install -r requirements.txt
```

**Option B: Using install.py script**
```bash
cd ~/.vim/pack/plugins/start/zai.vim

# Install all dependencies
python3 python3/install.py --all-optional

# Or install core only
python3 python3/install.py
```

### Step 4: Configure (Optional)

Create or edit `~/.vimrc`:

```vim
" Zai.Vim Configuration
let g:zai_default_model = "deepseek-chat"
let g:zai_base_url = "https://api.deepseek.com"
let g:zai_api_key_name = "DEEPSEEK_API_KEY"

" Optional: Set interface language
let g:zai_lang = 'en_US.UTF-8'
```

### Step 5: Set API Key

Add to `~/.bashrc` or `~/.zshrc`:

```bash
export DEEPSEEK_API_KEY=sk-********************************
```

Reload shell configuration:

```bash
source ~/.bashrc  # or source ~/.zshrc
```

### Step 6: Verify Installation

Start Vim and test:

```bash
vim
```

In Vim, run:

```vim
:Zai
```

You should see the Zai chat interface open.

## Windows Installation

### Step 1: Create Plugin Directory

Open Command Prompt and run:

```cmd
md %USERPROFILE%\vimfiles\pack\plugins\start
cd %USERPROFILE%\vimfiles\pack\plugins\start
```

### Step 2: Clone Repository

```cmd
git clone https://github.com/zighouse/zai.vim.git
```

### Step 3: Install Python Dependencies

**Option A: Using requirements.txt**
```cmd
cd %USERPROFILE%\vimfiles\pack\plugins\start\zai.vim
pip install -r requirements.txt
```

**Option B: Using install.py script**
```cmd
cd %USERPROFILE%\vimfiles\pack\plugins\start\zai.vim
python python3\install.py
```

### Step 4: Configure (Optional)

Create or edit `~/_vimrc` (or `~/vimfiles/vimrc` for Neovim):

```vim
" Zai.Vim Configuration
let g:zai_default_model = "deepseek-chat"
let g:zai_base_url = "https://api.deepseek.com"
let g:zai_api_key_name = "DEEPSEEK_API_KEY"
```

### Step 5: Set API Key

Set environment variable in System Properties or use:

```cmd
setx DEEPSEEK_API_KEY sk-********************************
```

### Step 6: Verify Installation

Start Vim (gvim or console) and run:

```vim
:Zai
```

## Neovim Manual Installation

### Linux/macOS

```bash
mkdir -p ~/.local/share/nvim/site/pack/plugins/start
cd ~/.local/share/nvim/site/pack/plugins/start
git clone https://github.com/zighouse/zai.vim.git
pip install -r requirements.txt
```

Create or edit `~/.config/nvim/init.vim` or `init.lua`:

```vim
" init.vim
let g:zai_default_model = "deepseek-chat"
```

Or in Lua:

```lua
-- init.lua
vim.g.zai_default_model = "deepseek-chat"
```

### Windows (Neovim)

```cmd
md %LOCALAPPDATA%\nvim-data\site\pack\plugins\start
cd %LOCALAPPDATA%\nvim-data\site\pack\plugins\start
git clone https://github.com/zighouse/zai.vim.git
pip install -r requirements.txt
```

## Alternative: Download ZIP File

If you cannot use Git, download the ZIP file:

1. Visit: https://github.com/zighouse/zai.vim/archive/refs/heads/main.zip
2. Extract the archive
3. Move `zai.vim-main` folder to your plugin directory:
   - **Vim (Linux/Mac)**: `~/.vim/pack/plugins/start/`
   - **Vim (Windows)**: `%USERPROFILE%\vimfiles\pack\plugins\start\`
   - **Neovim (Linux/Mac)**: `~/.local/share/nvim/site/pack/plugins/start/`
   - **Neovim (Windows)**: `%LOCALAPPDATA%\nvim-data\site\pack\plugins\start\`
4. Rename folder from `zai.vim-main` to `zai.vim`
5. Install dependencies: `pip install -r requirements.txt`

## Update Zai.Vim

### Git Method

```bash
cd ~/.vim/pack/plugins/start/zai.vim  # or your install directory
git pull
```

### ZIP Method

Download the latest ZIP and replace the existing folder.

## Uninstall Zai.Vim

### Remove Plugin Files

```bash
# Linux/Mac Vim
rm -rf ~/.vim/pack/plugins/start/zai.vim

# Linux/Mac Neovim
rm -rf ~/.local/share/nvim/site/pack/plugins/start/zai.vim

# Windows
rmdir /s %USERPROFILE%\vimfiles\pack\plugins\start\zai.vim
```

### Remove Configuration

Remove Zai-related lines from:
- `~/.vimrc` or `~/_vimrc`
- `~/.config/nvim/init.vim` or `init.lua`

### Remove Data (Optional)

```bash
# Remove logs and data
rm -rf ~/.local/share/zai

# Windows
rmdir /s %USERPROFILE%\AppData\Local\Zai
```

## Installation Verification

After installation, verify everything is working:

### 1. Check Python Support

In Vim, run:

```vim
:echo has('python3')
```

Should output `1`.

### 2. Check Plugin Loading

```vim
:scriptnames
```

Look for `zai.vim` in the list.

### 3. Test Zai

```vim
:Zai
```

Should open the Zai interface with three windows.

### 4. Check Dependencies

```bash
python3 -c "import openai, yaml, tiktoken, appdirs, chardet, requests; print('All OK')"
```

## Troubleshooting

### Python Not Found

Ensure Python 3 is installed and in PATH:

```bash
python3 --version
which python3
```

### Plugin Not Loading

Check if plugin directory is correct:

```vim
:echo &packpath
```

### Dependencies Missing

Install manually:

```bash
pip install openai requests appdirs chardet PyYAML tiktoken
```

### Permission Errors (Linux/Mac)

If you get permission errors, use user install:

```bash
pip install --user -r requirements.txt
```

## Next Steps

After successful installation:

- Configure your API keys in [Configuration Guide](../configuration/)
- Set up [Voice Input](asr.md) for hands-free text input
- Learn about [session commands](../commands/)
- Explore [AI tools](../tools/)

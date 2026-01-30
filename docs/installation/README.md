# Installation Guide

This section covers everything you need to install and set up Zai.Vim.

## Quick Install

Using vim-plug:
```vim
Plug 'zighouse/zai'
```

Then install Python dependencies:
```bash
pip install -r requirements.txt
```

## Installation Topics

- **[Requirements](requirements.md)** - System requirements and dependencies
- **[Plugin Managers](plugin-managers.md)** - Installation using vim-plug, Vundle, lazy.nvim
- **[Manual Installation](manual.md)** - Manual setup without plugin managers
- **[Voice Input Setup](asr.md)** - Configure ASR for hands-free text input

## Installation Methods

### Method 1: Using requirements.txt
```bash
pip install -r requirements.txt
```

### Method 2: Using install.py script
```bash
# Install all dependencies
python3 python3/install.py --all-optional

# Install core dependencies only
python3 python3/install.py --skip-core
```

## Verify Installation

After installation, verify Zai is working:

```vim
:Zai
```

This should open the Zai chat interface.

## Next Steps

- Configure your AI API keys in [Configuration Guide](../configuration/)
- Learn about [available commands](../commands/)
- Explore [AI tools](../tools/)

## Troubleshooting

If you encounter issues during installation:

1. Check Python version (3.6+ required): `python3 --version`
2. Verify API key is set in environment variables
3. Ensure Docker is running (for shell tools): `docker --version`
4. See [full troubleshooting guide](../troubleshooting/)

For more help, visit:
- [GitHub Issues](https://github.com/zighouse/zai.vim/issues)
- [Documentation Home](../README.md)

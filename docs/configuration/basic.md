# Basic Configuration

This page covers the essential configuration options for Zai.Vim in your `.vimrc` or `init.vim`.

## Vim Configuration Options

Add these settings to your `.vimrc` (Vim) or `init.vim` (Neovim):

### Log Directory

Configure where Zai saves conversation logs.

```vim
" Set log directory
let g:zai_log_dir = "~/.local/share/zai/log"
```

**Default values:**
- Linux/Mac: `~/.local/share/zai/log`
- Windows: `%USERPROFILE%\AppData\Local\zai\log`

**Recommendation:** On Windows, configure a custom path since the default is hidden.

### Interface Language

Set Zai's interface language.

```vim
" English (default)
let g:zai_lang = 'en_US.UTF-8'

" Chinese
let g:zai_lang = 'zh_CN.UTF-8'
```

**Default:** Auto-detected based on your system locale.

### API Configuration

#### Base URL

Set the AI service's API endpoint.

```vim
" DeepSeek
let g:zai_base_url = "https://api.deepseek.com"

" OpenAI
let g:zai_base_url = "https://api.openai.com/v1"

" SiliconFlow
let g:zai_base_url = "https://api.siliconflow.cn"

" Custom endpoint
let g:zai_base_url = "https://your-custom-endpoint.com/v1"
```

#### API Key Name

Specify the environment variable containing your API key.

```vim
" DeepSeek
let g:zai_api_key_name = "DEEPSEEK_API_KEY"

" OpenAI
let g:zai_api_key_name = "OPENAI_API_KEY"

" SiliconFlow
let g:zai_api_key_name = "SILICONFLOW_API_KEY"
```

Set the actual key in your shell:
```bash
export DEEPSEEK_API_KEY=sk-********************************
```

#### Default Model

Set the default AI model to use.

```vim
" DeepSeek models
let g:zai_default_model = "deepseek-chat"
let g:zai_default_model = "deepseek-reasoner"

" OpenAI models
let g:zai_default_model = "gpt-4"
let g:zai_default_model = "gpt-3.5-turbo"

" SiliconFlow models
let g:zai_default_model = "Pro/deepseek-ai/DeepSeek-V3.2"
```

### Use AI Assistant from Configuration File

Instead of setting individual API parameters, use a predefined AI assistant from `assistants.yaml` (see [AI Assistants Configuration](assistants.md)).

```vim
" Use AI assistant by name
let g:zai_use_ai = "deepseek"

" Or use index (0-based)
let g:zai_use_ai = 0
```

This is the recommended approach for managing multiple AI providers.

### Voice Input (ASR)

#### Auto-enable ASR

Automatically enable voice input when plugin loads.

```vim
let g:zai_auto_enable_asr = 1
```

#### Manual ASR Setup

If you prefer manual control, add this function call:

```vim
call zai#asr#setup()
```

See [Voice Input Setup](../installation/asr.md) for complete ASR configuration.

## Complete Example Configuration

### Minimal Configuration

```vim
" ~/.vimrc or ~/init.vim

" Use DeepSeek by default
let g:zai_use_ai = "deepseek"

" Optional: Set log directory
let g:zai_log_dir = "~/.local/share/zai/log"

" Optional: Set language
let g:zai_lang = 'en_US.UTF-8'
```

### Full Configuration

```vim
" ~/.vimrc or ~/init.vim

" === Zai.Vim Configuration ===

" Log directory
let g:zai_log_dir = "~/.local/share/zai/log"

" Interface language
let g:zai_lang = 'en_US.UTF-8'

" Use AI assistant from configuration file
let g:zai_use_ai = "deepseek"

" Auto-enable ASR (if configured)
let g:zai_auto_enable_asr = 1

" Key mappings (optional)
nnoremap <leader>zo :Zai<CR>
nnoremap <leader>zX :ZaiClose<CR>
vnoremap <leader>za :ZaiAdd<CR>
nnoremap <leader>zl :ZaiLoad<CR>
```

## Configuration Precedence

When the same setting is defined in multiple places:

1. **Session Commands** (highest priority) - Runtime overrides
2. **Project Configuration** - `zai.project/zai_project.yaml`
3. **User Configuration** - `~/.local/share/zai/assistants.yaml`
4. **Vim Configuration** - `.vimrc` settings
5. **Defaults** - Hardcoded defaults (lowest priority)

## Environment Variables

### API Keys

Set your API keys in the environment:

```bash
# ~/.bashrc or ~/.zshrc

# DeepSeek
export DEEPSEEK_API_KEY=sk-********************************

# OpenAI
export OPENAI_API_KEY=sk-********************************

# SiliconFlow
export SILICONFLOW_API_KEY=sk-********************************

# Or any other provider
export YOUR_API_KEY=sk-********************************
```

### Zai-specific Variables

#### Log Directory Override

```bash
export ZAI_LOG_DIR="/custom/path/to/logs"
```

#### ASR Server URL

```bash
export ZASR_SERVER_URL="ws://localhost:2026"
```

#### Sandbox Directory

```bash
export ZAI_SANDBOX_HOME="/custom/sandbox/path"
```

## Testing Your Configuration

### Verify API Key

```bash
echo $DEEPSEEK_API_KEY
```

Should output your API key.

### Test in Vim

Open Vim and run:

```vim
" Check Python support
:echo has('python3')
" Should output: 1

" Open Zai interface
:Zai

" Show current configuration
:show base-url
:show model
:show api-key-name
```

### Send Test Message

In the Zai interface:

```
:use tool shell

Hello! Can you hear me?
```

You should receive a response from the AI.

## Switching Configuration at Runtime

You can change settings during a session using [Session Commands](session-commands.md):

```
" Change model
:model deepseek-reasoner

" Change API provider
:use ai "Silicon Flow"

" Set custom base URL
:base-url https://api.openai.com/v1

" Set temperature
:temperature 0.7

" Reset to default
:-temperature
```

## Common Issues

### API Key Not Found

**Error:** `API key not found`

**Solution:**
1. Verify environment variable is set: `echo $DEEPSEEK_API_KEY`
2. Check variable name in `.vimrc`: `let g:zai_api_key_name = "DEEPSEEK_API_KEY"`
3. Ensure variable is exported in shell: `export DEEPSEEK_API_KEY=...`

### Model Not Found

**Error:** `Model not found`

**Solution:**
1. Verify model name matches provider's model list
2. Check AI assistants configuration file
3. Use `:list ai` to see available models

### Python Not Found

**Error:** `Python 3 not available`

**Solution:**
1. Check Python is installed: `python3 --version`
2. Verify Vim has Python support: `:echo has('python3')`
3. Reinstall Vim with Python support if needed

## Next Steps

- [AI Assistants Configuration](assistants.md) - Define multiple AI providers
- [Project Configuration](project.md) - Docker and sandbox settings
- [Session Commands](session-commands.md) - Runtime configuration options
- [Environment Variables](environment.md) - All environment variables

## Related Topics

- [Installation Guide](../installation/) - Set up Zai.Vim
- [Configuration Overview](README.md) - All configuration topics

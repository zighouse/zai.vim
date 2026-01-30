# Configuration Guide

This section covers all aspects of configuring Zai.Vim, from basic setup to advanced project configurations.

## Configuration Overview

Zai.Vim uses a hierarchical configuration system:

1. **Vim Configuration** (`.vimrc`) - Basic plugin settings
2. **User Configuration** (`~/.local/share/zai/assistants.yaml`) - AI assistant definitions
3. **Project Configuration** (`zai.project/zai_project.yaml`) - Project-specific settings
4. **Session Commands** - Runtime configuration via chat interface

## Configuration Topics

- **[Basic Configuration](basic.md)** - Vim options, language, and API settings
- **[AI Assistants Configuration](assistants.md)** - Define multiple AI providers and models
- **[Project Configuration](project.md)** - Docker containers, sandbox, and project settings
- **[Session Commands](session-commands.md)** - Configure AI behavior at runtime
- **[Environment Variables](environment.md)** - API keys and server URLs

## Quick Configuration

### Minimal Setup (.vimrc)

```vim
" Set default model
let g:zai_default_model = "deepseek-chat"

" Set API key environment variable name
let g:zai_api_key_name = "DEEPSEEK_API_KEY"

" Set API base URL
let g:zai_base_url = "https://api.deepseek.com"
```

### Set API Key (Environment)

```bash
export DEEPSEEK_API_KEY=sk-********************************
```

## Configuration Precedence

When multiple configuration sources specify the same setting:

1. **Session Commands** (highest priority) - Runtime overrides
2. **Project Configuration** - Project-specific settings
3. **User Configuration** - User-level defaults
4. **Vim Configuration** - Plugin-level defaults
5. **Hardcoded Defaults** (lowest priority)

## Configuration Files Locations

### User Configuration

| Platform | Path |
|----------|------|
| Linux/Mac | `~/.local/share/zai/assistants.yaml` |
| Windows | `%USERPROFILE%\AppData\Local\Zai\assistants.yaml` |

### Project Configuration

Searched upward from current directory:
- `zai.project/zai_project.yaml` (new format, recommended)
- `zai_project.yaml` (legacy format, shows warning)

## Common Configuration Tasks

### Change Default Model

```vim
" In .vimrc
let g:zai_default_model = "deepseek-chat"
```

Or at runtime:
```
:model deepseek-reasoner
```

### Switch AI Provider

```vim
" In .vimrc
let g:zai_use_ai = "Silicon Flow"
```

Or at runtime:
```
:use ai "Silicon Flow"
```

### Set Interface Language

```vim
" In .vimrc
let g:zai_lang = 'zh_CN.UTF-8'  " Chinese
let g:zai_lang = 'en_US.UTF-8'  " English
```

### Configure Log Directory

```vim
" In .vimrc
let g:zai_log_dir = "~/.local/share/zai/log"
```

## Example Configurations

### DeepSeek Configuration

```vim
" .vimrc
let g:zai_base_url = "https://api.deepseek.com"
let g:zai_api_key_name = "DEEPSEEK_API_KEY"
let g:zai_default_model = "deepseek-chat"
```

```bash
# Shell
export DEEPSEEK_API_KEY=sk-********************************
```

### SiliconFlow Configuration

```vim
" .vimrc
let g:zai_base_url = "https://api.siliconflow.cn"
let g:zai_api_key_name = "SILICONFLOW_API_KEY"
let g:zai_default_model = "Pro/deepseek-ai/DeepSeek-V3.2"
```

```bash
# Shell
export SILICONFLOW_API_KEY=sk-********************************
```

### OpenAI Configuration

```vim
" .vimrc
let g:zai_base_url = "https://api.openai.com/v1"
let g:zai_api_key_name = "OPENAI_API_KEY"
let g:zai_default_model = "gpt-4"
```

```bash
# Shell
export OPENAI_API_KEY=sk-********************************
```

## Troubleshooting Configuration

### Check Current Configuration

In Zai chat:
```
:show base-url
:show model
:show prompt
```

### Reset to Defaults

```
:-temperature
:-prompt
:-max_tokens
```

### View All Configuration

List all AI assistants:
```
:list ai
```

List all tools:
```
:list tool
```

## Next Steps

- [Basic Configuration](basic.md) - Essential settings
- [AI Assistants](assistants.md) - Define multiple AI providers
- [Project Configuration](project.md) - Docker and sandbox setup
- [Session Commands](session-commands.md) - Runtime configuration

## Related Topics

- [Installation Guide](../installation/) - Set up Zai.Vim
- [Session Commands](../commands/) - Available runtime commands
- [AI Tools](../tools/) - Configure AI capabilities

# Environment Variables

This page covers all environment variables used by Zai.Vim for configuration.

## Overview

Environment variables in Zai.Vim are used for:
- API keys for AI providers
- Log directory paths
- Sandbox directories
- ASR server URLs
- Docker-related settings

## API Key Variables

### DeepSeek

```bash
export DEEPSEEK_API_KEY=sk-********************************
```

### OpenAI

```bash
export OPENAI_API_KEY=sk-********************************
```

### Gemini

```bash
export GEMINI_API_KEY=************************************
```

### Moonshot (Kimi)

```bash
export MOONSHOT_API_KEY=sk-********************************
```

### SiliconFlow

```bash
export SILICONFLOW_API_KEY=sk-********************************
```

### Volces (Ark)

```bash
export VOLCES_API_KEY=sk-********************************
```

### Aliyun (Qwen)

```bash
export ALIYUN_API_KEY=sk-********************************
```

### Custom Provider

```bash
export CUSTOM_PROVIDER_API_KEY=your-key-here
```

Then use in configuration:
```vim
let g:zai_api_key_name = "CUSTOM_PROVIDER_API_KEY"
```

## Zai-Specific Variables

### Log Directory

Override the default log directory location.

```bash
# Linux/Mac
export ZAI_LOG_DIR="/custom/path/to/logs"

# Windows
set ZAI_LOG_DIR=C:\custom\path\to\logs
```

**Default:**
- Linux/Mac: `~/.local/share/zai/log`
- Windows: `%USERPROFILE%\AppData\Local\zai\log`

### Sandbox Directory

Set the default sandbox directory for file operations.

```bash
export ZAI_SANDBOX_HOME="/custom/sandbox/path"
```

**Default:** `~/.local/share/zai/sandbox`

### ASR Server URL

Configure the WebSocket server URL for voice input.

```bash
export ZASR_SERVER_URL="ws://localhost:2026"
```

**Default:** `ws://localhost:2026`

### Language

Set interface language (overrides `g:zai_lang`).

```bash
export ZAI_LANG="en_US.UTF-8"
export ZAI_LANG="zh_CN.UTF-8"
```

**Default:** Auto-detected from system locale

## Python Environment

### Python Path

Specify which Python interpreter to use.

```bash
export PYTHON=/usr/bin/python3.11
```

### Python Path

Add additional directories to Python's module search path.

```bash
export PYTHONPATH="/path/to/zai.vim/python3:$PYTHONPATH"
```

## Docker Environment Variables

### Docker Host

Set Docker daemon address (if not default).

```bash
export DOCKER_HOST="unix:///var/run/docker.sock"
```

### Docker Context

Use a specific Docker context.

```bash
export DOCKER_CONTEXT="my-context"
```

## Network Environment Variables

### HTTP Proxy

Configure proxy for HTTP requests (used by web tools).

```bash
export HTTP_PROXY="http://proxy.example.com:8080"
export HTTPS_PROXY="http://proxy.example.com:8080"
export NO_PROXY="localhost,127.0.0.1"
```

### SearXNG Server

Configure SearXNG server URL (for web search tool).

```bash
export SEARXNG_SERVER_URL="http://localhost:8888"
```

## Configuration Files

### Assistants Config Path

Override default assistants.yaml location.

```bash
export ZAI_ASSISTANTS_CONFIG="/custom/path/assistants.yaml"
```

### Project Config Path

Override project config search path.

```bash
export ZAI_PROJECT_CONFIG="/custom/path/zai_project.yaml"
```

## Debug Variables

### Enable Debug Logging

Enable verbose debug output.

```bash
export ZAI_DEBUG=1
```

### Log Level

Set logging verbosity.

```bash
export ZAI_LOG_LEVEL=DEBUG
export ZAI_LOG_LEVEL=INFO
export ZAI_LOG_LEVEL=WARNING
export ZAI_LOG_LEVEL=ERROR
```

**Default:** `INFO`

## Setting Environment Variables

### Linux/Mac (bash)

Add to `~/.bashrc` or `~/.bash_profile`:

```bash
# API Keys
export DEEPSEEK_API_KEY=sk-********************************
export OPENAI_API_KEY=sk-********************************

# Zai Configuration
export ZAI_LOG_DIR="$HOME/.local/share/zai/log"
export ZAI_SANDBOX_HOME="$HOME/.local/share/zai/sandbox"
export ZAI_LANG="en_US.UTF-8"

# ASR Configuration
export ZASR_SERVER_URL="ws://localhost:2026"

# Docker
export DOCKER_HOST="unix:///var/run/docker.sock"
```

Reload shell:
```bash
source ~/.bashrc
```

### Linux/Mac (zsh)

Add to `~/.zshrc`:

```bash
# Same as bash above
```

Reload shell:
```bash
source ~/.zshrc
```

### macOS (fish)

Add to `~/.config/fish/config.fish`:

```fish
# API Keys
set -x DEEPSEEK_API_KEY sk-********************************
set -x OPENAI_API_KEY sk-********************************

# Zai Configuration
set -x ZAI_LOG_DIR "$HOME/.local/share/zai/log"
set -x ZAI_SANDBOX_HOME "$HOME/.local/share/zai/sandbox"
set -x ZAI_LANG "en_US.UTF-8"
```

### Windows (Command Prompt)

Add to system environment variables or use `setx`:

```cmd
REM API Keys
setx DEEPSEEK_API_KEY sk-********************************

REM Zai Configuration
setx ZAI_LOG_DIR C:\Users\YourName\zai\log
setx ZAI_SANDBOX_HOME C:\Users\YourName\zai\sandbox
```

Restart Command Prompt for changes to take effect.

### Windows (PowerShell)

Add to `$PROFILE` (typically `Documents\PowerShell\Microsoft.PowerShell_profile.ps1`):

```powershell
# API Keys
$env:DEEPSEEK_API_KEY = "sk-********************************"
$env:OPENAI_API_KEY = "sk-********************************"

# Zai Configuration
$env:ZAI_LOG_DIR = "$HOME\.local\share\zai\log"
$env:ZAI_SANDBOX_HOME = "$HOME\.local\share\zai\sandbox"
$env:ZAI_LANG = "en_US.UTF-8"

# Make persistent
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", $env:DEEPSEEK_API_KEY, "User")
```

## Project-Specific Variables

Use [direnv](https://direnv.net/) or similar tools for project-specific environment variables.

### Using direnv

1. Install direnv:
```bash
brew install direnv  # macOS
sudo apt install direnv  # Ubuntu
```

2. Add to `.envrc` in project directory:
```bash
# Project-specific API key
export PROJECT_API_KEY=sk-********************************

# Project sandbox
export ZAI_SANDBOX_HOME="$(pwd)/sandbox"

# Project log directory
export ZAI_LOG_DIR="$(pwd)/logs"
```

3. Allow direnv:
```bash
direnv allow
```

## Temporary Variables

Set environment variables for a single session:

```bash
# Set for current shell session only
export ZAI_DEBUG=1

# Launch Vim with custom environment
ZAI_DEBUG=1 vim
```

## Checking Environment Variables

### In Shell

```bash
# Check specific variable
echo $DEEPSEEK_API_KEY

# Check all Zai variables
env | grep ZAI
env | grep ZASR

# Check API keys
env | grep API_KEY
```

### In Vim

```vim
" Check if Python can access environment
:py3 import os; print(os.environ.get('DEEPSEEK_API_KEY'))

" Check specific variable
:echo $DEEPSEEK_API_KEY
```

### In Zai Chat

```
:show api-key-name
```

## Security Best Practices

### API Keys

1. **Never commit API keys to git**
   ```bash
   # Add to .gitignore
   .env
   .envrc
   ```

2. **Use separate keys for development**
   - Don't use production keys in development
   - Rotate keys regularly

3. **Set appropriate file permissions**
   ```bash
   chmod 600 ~/.bashrc  # Only owner can read/write
   chmod 600 ~/.zshrc
   ```

4. **Use key management services** (for production)
   - HashiCorp Vault
   - AWS Secrets Manager
   - Azure Key Vault

### Debug Logging

Disable debug logging in production:
```bash
unset ZAI_DEBUG
export ZAI_LOG_LEVEL=ERROR
```

## Troubleshooting

### Variable Not Set

**Symptom:** "API key not found" error

**Check:**
```bash
echo $DEEPSEEK_API_KEY
```

**Solution:**
1. Ensure variable is exported: `export DEEPSEEK_API_KEY=...`
2. Check file is sourced: `source ~/.bashrc`
3. Verify correct file: `~/.bashrc`, `~/.zshrc`, etc.

### Variable Not Persisting

**Symptom:** Variable lost after shell restart

**Solution:**
1. Add to correct shell config file
2. Ensure file is loaded on shell startup
3. Use `setx` on Windows for persistent variables

### Special Characters in Values

If your value contains special characters, use quotes:

```bash
export API_KEY="sk-****-****-****-****"
export PATH="/path/with spaces/bin:$PATH"
```

## Next Steps

- [Basic Configuration](basic.md) - Vim configuration options
- [AI Assistants Configuration](assistants.md) - Multiple AI providers
- [Project Configuration](project.md) - Docker and sandbox settings
- [Session Commands](session-commands.md) - Runtime commands

## Related Topics

- [Installation Guide](../installation/) - Set up Zai.Vim
- [Configuration Overview](README.md) - All configuration topics

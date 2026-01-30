# AI Assistants Configuration

This page covers configuring multiple AI providers and models using the `assistants.yaml` configuration file.

## Overview

The `assistants.yaml` file allows you to define multiple AI providers (assistants), each with their own:
- Base URL
- API key environment variable
- List of available models
- Model-specific settings (context size, pricing, features)

## Configuration File Location

| Platform | Path |
|----------|------|
| Linux/Mac | `~/.local/share/zai/assistants.yaml` |
| Windows | `%USERPROFILE%\AppData\Local\Zai\assistants.yaml` |

Create the directory if it doesn't exist:

```bash
mkdir -p ~/.local/share/zai
```

## Configuration File Format

The file contains a list of AI assistant configurations:

```yaml
- name: assistant-name              # Unique identifier
  base-url: https://api.example.com # API endpoint
  api-key-name: API_KEY_ENV_VAR     # Environment variable name
  tokenizer: model/tokenizer-name    # Optional: for token counting
  model:                            # List of available models
  - name: model-identifier           # Model name (must match provider)
    size: 685.40B                   # Optional: model size
    context: 128K                   # Optional: context length
    out-length: { default: 4K, max: 8K }  # Optional: output length
    cost: { in: 2, out: 3, unit: RMB/MTk }  # Optional: pricing
    features: json, tool-call, complete, fim  # Optional: capabilities
```

## Example Configuration

### Minimal Example

```yaml
- name: deepseek
  base-url: https://api.deepseek.com
  api-key-name: DEEPSEEK_API_KEY
  model:
  - name: deepseek-chat
  - name: deepseek-reasoner
```

### Complete Example

```yaml
- name: deepseek
  base-url: https://api.deepseek.com
  api-key-name: DEEPSEEK_API_KEY
  tokenizer: deepseek-ai/DeepSeek-V3.2
  model:
  - name: deepseek-chat
    size: 685.40B
    context: 128K
    out-length: { default: 4K, max: 8K }
    cost: { hit: 0.2, in: 2, out: 3, unit: RMB/MTk }
    features: json, tool-call, complete, fim
  - name: deepseek-reasoner
    size: 685.40B
    context: 128K
    out-length: { default: 32K, max: 64K }
    cost: { hit: 0.2, in: 2, out: 3, unit: RMB/MTk }
    features: json, tool-call, complete

- name: openai
  api-key-name: OPENAI_API_KEY
  base-url: https://api.openai.com/v1
  model:
  - name: gpt-4
    context: 8K
    features: json, tool-call, complete
  - name: gpt-3.5-turbo
    context: 4K
    features: json, tool-call, complete

- name: Silicon Flow
  api-key-name: SILICONFLOW_API_KEY
  base-url: https://api.siliconflow.cn
  model:
  - name: Pro/deepseek-ai/DeepSeek-V3.2
    size: 671B
    context: 160K
    out-length: { default: 4K, max: 8K }
    cost: { in: 2, out: 3, unit: RMB/MTk }
    features: talk, prefix, tools, infer, moe
```

## Field Descriptions

### Assistant-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique identifier for this assistant |
| `base-url` | string | Yes | API endpoint URL |
| `api-key-name` | string | Yes | Environment variable containing API key |
| `tokenizer` | string | No | HuggingFace tokenizer model for token counting |
| `model` | list | Yes | List of available models |

### Model-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Model identifier (must match provider's model name) |
| `size` | string | No | Model size (display only) |
| `context` | string | No | Context window size (e.g., "128K") |
| `out-length` | object | No | Default and max output sequence length |
| `cost` | object | No | Pricing information |
| `features` | list | No | Supported features |

## Supported Features

Models can declare support for these features:

| Feature | Description |
|---------|-------------|
| `json` | JSON mode / structured output |
| `tool-call` | Function calling / tool use |
| `complete` | Text completion |
| `fim` | Fill-in-middle completion |
| `prefix` | Prefix completion |
| `talk` | Conversational chat |
| `tools` | Tool calling support |
| `infer` | Inference capabilities |
| `moe` | Mixture of Experts |

## Popular Provider Configurations

### DeepSeek

```yaml
- name: deepseek
  api-key-name: DEEPSEEK_API_KEY
  base-url: https://api.deepseek.com
  tokenizer: deepseek-ai/DeepSeek-V3.2
  model:
  - name: deepseek-chat
    size: 685.40B
    context: 128K
    out-length: { default: 4K, max: 8K }
    cost: { hit: 0.2, in: 2, out: 3, unit: RMB/MTk }
    features: json, tool-call, complete, fim
  - name: deepseek-reasoner
    size: 685.40B
    context: 128K
    out-length: { default: 32K, max: 64K }
    cost: { in: 2, out: 3, unit: RMB/MTk }
    features: json, tool-call, complete
```

### OpenAI

```yaml
- name: openai
  api-key-name: OPENAI_API_KEY
  base-url: https://api.openai.com/v1
  model:
  - name: gpt-4
    context: 8K
    features: json, tool-call, complete
  - name: gpt-4-turbo
    context: 128K
    features: json, tool-call, complete
  - name: gpt-3.5-turbo
    context: 16K
    features: json, tool-call, complete
```

### Gemini

```yaml
- name: gemini
  api-key-name: GEMINI_API_KEY
  base-url: https://generativelanguage.googleapis.com/v1beta/openai/
  model:
  - name: gemini-2.5-flash-lite
    features: complete
  - name: gemini-2.5-flash
    features: complete
  - name: gemini-2.5-pro
    features: complete
  - name: gemini-3-flash-preview
    features: complete
  - name: gemini-3-pro-preview
    features: complete
```

### Moonshot (Kimi)

```yaml
- name: 月之暗面
  api-key-name: MOONSHOT_API_KEY
  base-url: https://api.moonshot.cn/v1
  model:
  - name: kimi-k2-0905-preview
    context: 256K
    features: tool-call
  - name: kimi-k2-turbo-preview
    context: 256K
  - name: moonshot-v1-128k
    context: 128K
  - name: kimi-latest
    context: 128K
    features: vision
  - name: kimi-thinking-preview
```

### SiliconFlow

```yaml
- name: 硅基流动
  api-key-name: SILICONFLOW_API_KEY
  base-url: https://api.siliconflow.cn
  model:
  - name: Qwen/Qwen3-30B-A3B
    tokenizer: Qwen/Qwen3-30B-A3B
    features: tools, infer, moe
  - name: Pro/deepseek-ai/DeepSeek-V3.2
    size: 671B
    context: 160K
    cost: { in: 2, out: 3, unit: RMB/MTk }
    features: talk, prefix, tools, infer, moe
  - name: Pro/zai-org/GLM-4.7
    size: 355B
    context: 198K
    cost: { in: 4.0, out: 16.0, unit: RMB/MTk }
    features: talk, prefix, tools, moe, infer
  - name: zai-org/GLM-4.6V
    size: 106B
    context: 128K
    cost: { in: 1, out: 3, unit: RMB/MTk }
    features: talk, prefix, tools, vision, infer, moe
```

### Aliyun (Qwen)

```yaml
- name: aliyun
  api-key-name: ALIYUN_API_KEY
  base-url: https://dashscope.aliyuncs.com/compatible-mode/v1
  model:
  - name: qwen3-max
  - name: qwen3-max-preview
  - name: qwen3-coder-plus
```

## Using AI Assistants

### In .vimrc

```vim
" Use specific assistant
let g:zai_use_ai = "deepseek"

" Use assistant by index (0-based)
let g:zai_use_ai = 0
```

### At Runtime

In Zai chat interface:

```
" List all assistants
:list ai

" Show current assistant
:show ai

" Show specific assistant
:show ai 0
:show ai deepseek

" Switch to assistant
:use ai deepseek

" Switch assistant and model together
:use ai deepseek model deepseek-chat
```

## Environment Variables

Set API keys in your shell:

```bash
# ~/.bashrc or ~/.zshrc

export DEEPSEEK_API_KEY=sk-********************************
export OPENAI_API_KEY=sk-********************************
export GEMINI_API_KEY=************************************
export MOONSHOT_API_KEY=sk-********************************
export SILICONFLOW_API_KEY=sk-********************************
export ALIYUN_API_KEY=sk-********************************
```

Reload shell:

```bash
source ~/.bashrc  # or source ~/.zshrc
```

## Managing Multiple Providers

### Strategy 1: Default Provider

Set one provider as default in `.vimrc`:

```vim
let g:zai_use_ai = "deepseek"
```

Switch at runtime when needed:

```
:use ai openai
```

### Strategy 2: Per-Project

Use project configuration for different providers:

```yaml
# project-a/zai.project/zai_project.yaml
- shell_container: { ... }
  # Use project-specific provider
  # (via session commands)
```

```
:use ai openai
```

### Strategy 3: Session-Based

Let each session choose its provider:

```
" In session 1
:use ai deepseek

" In session 2
:use ai openai
```

## Troubleshooting

### Assistant Not Found

**Error:** `Assistant not found`

**Solution:**
1. Check spelling: `:list ai`
2. Verify file exists: `ls ~/.local/share/zai/assistants.yaml`
3. Check YAML syntax: `yamllint ~/.local/share/zai/assistants.yaml`

### Model Not Available

**Error:** `Model not in assistant's model list`

**Solution:**
1. List available models: `:show ai assistant-name`
2. Use valid model name from the list
3. Add model to `assistants.yaml` if missing

### API Key Not Set

**Error:** `API key environment variable not found`

**Solution:**
1. Check variable is set: `echo $DEEPSEEK_API_KEY`
2. Add to shell profile: `export DEEPSEEK_API_KEY=...`
3. Reload shell: `source ~/.bashrc`

### YAML Syntax Error

**Error:** `Failed to parse assistants.yaml`

**Solution:**
1. Use YAML validator
2. Check indentation (use spaces, not tabs)
3. Verify list syntax (dash `-` before each assistant)

## Next Steps

- [Basic Configuration](basic.md) - Vim configuration options
- [Project Configuration](project.md) - Docker and sandbox settings
- [Session Commands](session-commands.md) - Runtime commands
- [Environment Variables](environment.md) - All environment variables

## Related Topics

- [Installation Guide](../installation/) - Set up Zai.Vim
- [Configuration Overview](README.md) - All configuration topics

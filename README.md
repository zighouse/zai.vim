# Zai.Vim AI Assistant

[中文说明](README_zh.md)

![Plugin Screenshot](screenshot.gif)

Zai.Vim is a Vim plugin that integrates AI assistants directly into your Vim editor. It manages multiple AI chat sessions simultaneously, records conversation logs, and allows loading logs to continue previous conversations. Switch freely and control at will.

## Features

- **Flexible model and prompt switching**: Change models and prompts mid-conversation
- **File attachment support**: Attach text files as conversation context
- **Multiple session support**: Handle multiple chat sessions concurrently
- **Session logging**: Save, load, and preview conversation history

## Installation

### Requirements

- Vim 8.0+ or Neovim
- Python 3.6+
- AI API KEY
  - Example: DeepSeek API key (set as `DEEPSEEK_API_KEY` environment variable)
- Required Python packages:
  - `openai` (automatically installed if missing)
- Optional: iamcco/markdown-preview.nvim
- Optional: junegunn/fzf.vim
- Optional: apt install rg
- Optional: pip install lunarcalendar

### Using a plugin manager

With vim-plug:
```vim
Plug 'zighouse/zai'
```

With Vundle:
```vim
Plugin 'zighouse/zai'
```

With lazy.nvim:
```lua
return {
    {
        "zighouse/zai.vim",
        config = function()
            vim.g.zai_default_model = "deepseek-chat"
        end
    }
}
```

Manual Installation:  

Linux/Mac:
```bash
pip install appdirs chardet openai
mkdir -p ~/.vim/pack/plugins/start
cd ~/.vim/pack/plugins/start
git clone -n --depth=1 https://github.com/zighouse/zai.vim.git
git checkout
```

Windows:
```dos
pip install appdirs chardet openai
md %USERPROFILE%\vimfiles\pack\plugins\start
cd %USERPROFILE%\vimfiles\pack\plugins\start
git clone -n --depth=1 https://github.com/zighouse/zai.vim.git
git checkout
```

Run `git pull` in the installation directory to update manually.

Alternatively, [download the zip](https://github.com/zighouse/zai.vim/archive/refs/heads/main.zip) and extract the zai.vim-main folder to the appropriate directory.

## Configuration

### Log Directory

`g:zai_log_dir` configures the log file storage path.

Default paths:
- Linux/Mac: `~/.local/share/zai/log`
- Windows: `%USERPROFILE%\AppData\Local\zai\log`

Recommendation: Configure a custom log path on Windows as the default path is system-hidden.

### Interface Language

`g:zai_lang` configures Zai's interface language.
Defaults to English or based on user environment.
Set to Chinese:
```vim
let g:zai_lang = 'zh_CN.UTF-8'
```

### API Configuration

`g:zai_base_url` configures the AI service's base URL.

`g:zai_api_key_name` configures the API key environment variable name.
The API key must be set in the system environment variables.

Example (Linux ~/.bashrc):
```bash
DEEPSEEK_API_KEY=sk-********************************
```

`g:zai_default_model` configures the default AI model.

`g:zai_use_ai`  Chooses an assistant from AI assistants configuration. It is a replacement for configurations of base-url, key and model. It depends an AI assistants configuration.

When multiple AI models can be used, or multiple AI assistant services are available, you can provide an json file as the AI assistants configuration on this location:

* Linux/Mac: ~/.local/share/zai/assistants.json
* Windows: %USERPROFILE%\AppData\Local\Zai\assistants.json

Sample code of assistants.json:
```json
 [
     {
         "name": "deepseek",
         "base-url": "https://api.deepseek.com",
         "api-key-name" : "DEEPSEEK_API_KEY",
         "tokenizer": "deepseek-ai/DeepSeek-V3.1",
         "model" : ["deepseek-chat", "deepseek-reasoner"]
     },
     {
         "name": "Moonshot",
         "base-url": "https://api.moonshot.cn/v1",
         "api-key-name" : "MOONSHOT_API_KEY",
         "model" : [
             {"name": "kimi-k2-0905-preview"},
             {"name": "kimi-thinking-preview"}
         ]
     },
     {
         "name": "Volces Ark",
         "base-url": "https://ark.cn-beijing.volces.com/api/v3",
         "api-key-name" : "VOLCES_API_KEY",
         "model" : [
             {
                "name": "doubao-seed-1-6-251015",
                "comment": "分段计费 2/M 上下文256k 输出32k"
             }
         ]
     },
     {
         "name": "Silicon Flow",
         "base-url": "https://api.siliconflow.cn",
         "api-key-name" : "SILICONFLOW_API_KEY",
         "model" : [
             {
                 "name": "deepseek-ai/DeepSeek-V3.1",
                 "tokenizer": "deepseek-ai/DeepSeek-V3.1"
             },
             "deepseek-ai/DeepSeek-R1",
             "moonshotai/Kimi-K2-Instruct-0905",
             "tencent/Hunyuan-MT-7B",
             "inclusionAI/Ling-mini-2.0",
             "ByteDance-Seed/Seed-OSS-36B-Instruct",
             "zai-org/GLM-4.5",
             "Qwen/Qwen3-Coder-480B-A35B-Instruct",
             "Qwen/Qwen3-235B-A22B-Thinking-2507",
             "Qwen/Qwen3-235B-A22B-Instruct-2507",
             {
               "name": "Qwen/Qwen3-30B-A3B",
               "comment": "￥2.8/M Tokens 对话 Tools 推理模型 MoE 30B 128K",
               "tokenizer": "Qwen/Qwen3-30B-A3B",
               "params": {
                 "extra_body": {
                   "chat_template_kwargs": {
                     "enable_thinking": false
                   }
                 }
               }
             },
             "baidu/ERNIE-4.5-300B-A47B",
             "tencent/Hunyuan-A13B-Instruct"
         ]
     }
 ]
```

Once it is provided the AI assistants configure as above, then these code make the `Silicon Flow` as the default AI assistant and with the model K2.

```vim
 let g:zai_use_ai = "Silicon Flow"
 let g:model = "moonshotai/Kimi-K2-Instruct-0905"
```

Also, a 0-based index in the list of assistants config can be used as same as the name.

## Usage

### VIM Commands

| Command                | Description                          | Mode          |
|------------------------|--------------------------------------|---------------|
| `:help`                | Open Zai help                        | Zai interface only |
| `:Zai`                 | Open Zai interface                   | -             |
| `<leader>zo`           | Open Zai interface                   | Normal mode   |
| `:ZaiClose`            | Close Zai interface                  | -             |
| `<leader>zX`           | Close Zai interface                  | Normal mode   |
| `:q`                   | Close Zai interface                  | Zai interface only |
| `:ZaiGo`               | Send input content                   | -             |
| `<CR>`                 | Send input content                   | Input window normal mode |
| `:ZaiAdd`              | Add selection to input               | -             |
| `<leader>za`           | Add selection to input               | Visual mode   |
| `:ZaiNew`              | Create new chat                      | Zai interface only |
| `:[count]ZaiPrev`      | Select previous chat                 | Zai interface only |
| `:[count]cp`           | Select previous chat                 | Zai interface only |
| `:[count]ZaiNext`      | Select next chat                     | Zai interface only |
| `:[count]cn`           | Select next chat                     | Zai interface only |
| `:ZaiGoto id`          | Select chat by ID                    | Zai interface only |
| `:cn id`               | Select chat by ID                    | Zai interface only |
| `:ZaiPreview`          | Preview chat in browser              | Zai interface only |
| `<leader>dp`           | Preview chat in browser              | Zai interface normal mode |
| `:ZaiOpenLog`          | Open Zai log                         | -             |
| `:ZaiGrepLog <patten>` | Grep Zai log                         | -             |
| `:ZaiRg <pattern> <dir>` | Rg in a directory                  | -             |
| `:ZaiLoad`             | Load Zai log as context              | -             |
| `<leader>zl`           | Load Zai log as context              | -             |
| `:ZaiConfig`           | Edit AI assistants configuration     | -             |

### Interface Overview

Zai interface consists of three parts:
- Top: Session list window
- Middle: Display window showing conversation content
- Bottom: Input window for questions and commands

The interface opens with the first chat session (ID starts from 0). Press `<CR>` in input window to send content. Responses and errors appear in the display window with log file path notifications.

## Session Commands

Session commands configure AI assistant settings and are processed by Zai's background task. They can be sent alone or mixed with user queries.

### Available Commands

- `:->?` - Change command prefix
- `:help` - Show help information
- `:exit`/`:quit` - Force exit remote AI service
- `:show <config>` - Display configuration items
- `:file <file-path>` - Attach text file
- `:-file` - Clear all attachments
- `:base-url <url>` - Set base url of AI service
- `:api-key-name <key-name>` - Set variable of API Key to access AI service
- `:model <name>` - Set AI model
- `:prompt <text>` - Set system prompt
- `:-prompt` - Clear custom prompt
- `:temperature <float>` - Set creativity parameter (0-2)
- `:-temperature` - Clear temperature setting
- `:no-log` - Disable logging
- `:-no-log` - Enable logging

Session Commands with AI assistants json configuration:

- `:list ai` - List all AI assistants
- `:show ai [name|index]` - Display the AI assistant
- `:use  ai <name|index>` - Use an AI assistant picked up from the list.
- `:model <name|index>` - Choose one of valid model from list of current AI assistant.
- `:use  ai <name|index> model <name|index>` - Combination of `use ai` and `model` commands.

Session commands with AI calling tools:

- `:list tool` - List all available toolsets for AI calling.
- `:show tool [name]` - Show details of an AI calling toolset.
- `:use tool [name]` - Use an AI calling toolset.
- `:sandbox path` - Specify a sandbox path for file toolset.

### Configuration Items

Displayable configuration items:
- `api-key-name` - AI API Key Name
- `base-url` - AI API Base URL
- `model` - AI system model
- `prompt` - AI system prompt
- `temperature` - Creativity parameter (0-2)
- `max-tokens` - Maximum tokens
- `logprobs` - Top token probabilities (0-20)
- `top-p` - Top-P sampling (0-1)
- `presence-penalty` - Repetition penalty (-2 to 2)
- `frequency-penalty` - Frequency penalty (-2 to 2)
- `log-file` - Log file path
- `prefix` - Command prefix

### Model Configuration Examples

DeepSeek configuration:
```vim
let g:zai_base_url = "https://api.deepseek.com"
let g:zai_api_key_name = "DEEPSEEK_API_KEY"
let g:zai_default_model = "deepseek-chat"
```

Change model during conversation:
```
:model deepseek-reasoner
```

SiliconFlow configuration:
```vim
let g:zai_base_url = "https://api.siliconflow.cn"
let g:zai_api_key_name = "SILICONFLOW_API_KEY"
let g:zai_default_model = "deepseek-ai/DeepSeek-R1"
```

### Prompt Settings

Single-line prompt:
```
:prompt Please provide professional translation assistance as a computer technology expert.
```

Multi-line prompt (block syntax):
```
:prompt<<EOF
As a code expert assistant, please analyze problems step by step.
When providing solutions, use the format:
  ### [Title]
  [Step-by-step explanation]
  ### Summary: [One-sentence summary]
EOF
```

### Parameter Settings

Set creativity parameter:
```
:temperature 0.3
```  

Supported parameter commands:
- `:top_p float` - Top-P sampling (0-1)
- `:max_tokens integer` - Maximum tokens
- `:presence_penalty float` - Repetition penalty (-2 to 2)
- `:frequency_penalty float` - Frequency penalty (-2 to 2)
- `:logprobs float` - Top token probabilities (0-20)

Clear settings with minus prefix:
```
:-temperature
```  

### Command Prefix

Default command prefix is `:`. Available prefix characters:
```
: / ~ \ ; ! # $ % & ? @ ^ _ * + = , . < > ` ' " ( ) [ ] { }
```

Change prefix example:
```
:->/
```

## License

Released under MIT License. See: [https://github.com/zighouse/zai/blob/main/LICENSE](https://github.com/zighouse/zai/blob/main/LICENSE)

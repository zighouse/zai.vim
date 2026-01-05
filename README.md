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

When multiple AI models can be used, or multiple AI assistant services are available, you can provide a YAML file as the AI assistants configuration on this location:

* Linux/Mac: ~/.local/share/zai/assistants.yaml
* Windows: %USERPROFILE%\AppData\Local\Zai\assistants.yaml

Sample code of assistants.yaml:
```yaml
- name: deepseek                        # AI Assistant Name/ LLM Provider (customizable)
  base-url: https://api.deepseek.com    # api for llm base url
  api-key-name: DEEPSEEK_API_KEY        # environment name of the api key
  tokenizer: deepseek-ai/DeepSeek-V3.2  # for tokens calculation, optional
  model:                                # selected models from the provider's model list
  - name: deepseek-chat                       # model identifier from provider
    size: 685.40B                             # model size, optional.
    context: 128K                             # context length, not a must but recommended.
    out-length: { default: 4K, max: 8K }      # output sequence length, optional
    cost: { hit: 0.2, in: 2, out: 3, unit: RMB/MTk } # optional
    features: json, tool-call, complete, fim         # optional
  - name: deepseek-reasoner
    size: 685.40B
    context: 128K
    out-length: { default: 32K, max: 64K }
    cost: { hit: 0.2, in: 2, out: 3, unit: RMB/MTk }
    features: json, tool-call, complete

- name: Gemini
  api-key-name: GEMINI_API_KEY
  base-url: https://generativelanguage.googleapis.com/v1beta/openai/
  model:
    - gemini-2.5-flash-lite   # in:$0.1/mtk out:$0.4/mtk free-level no-call
    - gemini-2.5-flash        # in:$0.30/mtk out:$2.5/mtk free-level no-call
    - gemini-2.5-pro          # in:$1.25/mtk out:$10/mtk free-level no-call
    - gemini-3-flash-preview  # in:$0.5/mtk out:$3/mtk free-level no-call
    - gemini-3-pro-preview    # in:$2/mtk out:$12/mtk non-free

- name: Moonshot
  api-key-name: MOONSHOT_API_KEY
  base-url: https://api.moonshot.cn/v1
  model:
  - name: kimi-k2-0905-preview # tokens:256k, coder
  - name: kimi-k2-turbo-preview # tokens:256k
  - name: moonshot-v1-128k # tokens:128k
  - name: moonshot-v1-128k-vision-preview
  - name: kimi-latest # 128k
  - name: kimi-thinking-preview

- name: "Volces Ark"
  api-key-name: VOLCES_API_KEY
  base-url: https://ark.cn-beijing.volces.com/api/v3
  model:
  - name: doubao-seed-1-6-251015

- name: "Selicon Flow"
  api-key-name: SILICONFLOW_API_KEY
  base-url: https://api.siliconflow.cn
  model:
  - name: Qwen/Qwen3-30B-A3B
    tokenizer: Qwen/Qwen3-30B-A3B # specify individual tokenizer
  - name: Pro/deepseek-ai/DeepSeek-V3.2
    size: 671B
    context: 160K
    out-length: { default: 4K, max: 8K }
    cost: { in: 2, out: 3, unit: RMB/MTk }
    features: talk, prefix, tools, infer, moe
  - name: Pro/zai-org/GLM-4.7
    size: 355B
    active: 32B
    context: 198K
    cost: { hit: 0.8, in: 4.0, out: 16.0, unit: RMB/MTk }
    features: talk, prefix, tools, moe, infer
  - name: Pro/moonshotai/Kimi-K2-Thinking
    size: 1T
    context: 256K
    cost: { in: 4, out: 16, unit: RMB/MTk }
    features: talk, prefix, tools, infer, moe

- name: aliyun
  api-key-name: ALIYUN_API_KEY
  base-url: https://dashscope.aliyuncs.com/compatible-mode/v1
  model:
  - qwen3-max
  - qwen3-max-preview
  - qwen3-coder-plus
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
- `:prompt<<EOF` - Set multi-line prompt (end with EOF)
- `:-prompt` - Clear custom prompt
- `:temperature <float>` - Set creativity parameter (0-2)
- `:-temperature` - Clear temperature setting
- `:top_p <float>` - Set top-p sampling (0-1)
- `:-top_p` - Clear top-p setting
- `:max_tokens <integer>` - Set maximum tokens
- `:-max_tokens` - Clear maximum tokens setting
- `:complete_type <str>` - Set file type for code completion
- `:prefix <str>` - Set prefix for code completion
- `:prefix<<EOF` - Set multi-line prefix (end with EOF)
- `:suffix <str>` - Set suffix for fill-in-middle completion
- `:suffix<<EOF` - Set multi-line suffix (end with EOF)
- `:talk_mode <mode>` - Set conversation mode (instant, chain)
- `:logprobs <int>` - Show top token probabilities (0-20)
- `:no-log` - Disable logging
- `:-no-log` - Enable logging
- `:load <log-file>` - Load context from Zai log file
- `:-<param>` - Reset any parameter to default (e.g., `:-temperature`)

Session Commands with AI assistants YAML configuration:

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

### Available Toolsets

Zai provides several tool sets that AI can call to interact with the system:

1. **file** - File operations
   - `ls` - List files and directories
   - `mkdir` - Create directories
   - `copy_file` - Copy files or directories
   - `read_file` - Read file content
   - `write_file` - Write to file
   - `search_in_file` - Search within files
   - `substitute_file` - Replace text in files
   - `diff_file` - Compare files
   - `patch_file` - Apply patches

2. **web** - Web operations
   - `web_get_content` - Fetch web page content
   - `web_search` - Search the web
   - `web_download_file` - Download files from URLs

3. **shell** - Secure shell execution
   - `execute_shell` - Execute commands in Docker container (taskbox)
   - Supports Python and shell commands with isolation

4. **grep** - File searching
   - `grep` - Search for patterns in files (like Unix grep)

5. **ai** - AI operations
   - `generate_image` - Generate images with AI

6. **browser** - Browser automation
   - `open_browser` - Open URLs in browser
   - `get_page_content` - Get dynamic page content
   - `screenshot` - Take screenshots

7. **os** - System information
   - `get_os_info` - Get date, locale, OS version

### Tool Usage Examples

Load all tools from a toolset:
```
:use tool file
```

Load specific functions from a toolset:
```
:use tool file.read_file
:use tool file: read_file write_file
```

Load multiple toolsets:
```
:use tool file web
```

Check available tools:
```
:list tool
```

Show details of a toolset:
```
:show tool file
```

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

## Project Configuration

Zai supports project-level configuration through a `zai.project/zai_project.yaml` file (or `zai_project.yaml` for backward compatibility) in your project directory. This allows you to define project-specific settings like sandbox directory and Docker container configuration for the `tool_shell` tool.

### Configuration File Location

The configuration file is searched upward from the current working directory:
- `zai.project/zai_project.yaml` (new format)
- `zai_project.yaml` (legacy format, prints warning)

### Configuration Structure

The configuration file should contain a list of configuration objects. The first one is used for the current project.

Example `zai.project/zai_project.yaml`:
```yaml
- sandbox_home: /path/to/project/sandbox
  shell_container:
    # Other Docker SDK parameters can be included
    # It is used mostly for tool_shell running a docker container, see to run():
    # https://docker-py.readthedocs.io/en/stable/containers.html
    image: taskbox:latest
    name: my-project-taskbox
    Dockerfile: "Dockerfile.taskbox"
    working_dir: /sandbox
    user: "1000:1000"  # UID:GID as host user, or any user provided in docker image, e.g. "sandbox"
    volumes:
      - "/host/path:/container/path:rw"
      - "/home/for/project/.git:/sandbox/project/.git:ro"
      - "/ccache/for/project:/ccache/.git:ro"
    network_mode: "bridge"
    environment:
      CCACHE_DIR: "/ccache"
      CCACHE_MAXSIZE: "10G"
    mem_limit: "4g"
    cpu_period: 100000
    cpu_quota: 50000
    detach: true
    auto_remove: true
    network_mode: "bridge"
    command: ["tail", "-f", "/dev/null"]
```

### Container Startup Installations

Zai now supports automatic software installation when a Docker container starts. You can define packages to be installed in the `zai_project.yaml` file, and they will be automatically installed when the container is created or started.

#### Installation Configuration Fields

Add the following fields to your project configuration:

1. **`pip_install`**: Python packages to install via pip
   - Supports multiple formats:
     - Simple list: `["PyYAML", "appdirs"]`
     - Structured format with options: 
       ```yaml
       - packages: [torch, torchvision, torchaudio]
         options: [--index-url, https://download.pytorch.org/whl/cpu]
       ```
     - Mixed format: `["PyYAML", ["torch", "--index-url", "https://download.pytorch.org/whl/cpu"]]`
   - **Permission note**: If container user is not root, add `--user` flag to options
     to install packages in user directory and avoid permission errors:
     ```yaml
     - packages: [requests, numpy]
       options: [--user]
     ```

2. **`apt_install`**: System packages to install via package manager
   - Supports multiple package managers: `apt`, `dnf`, `yum`, `rpm`, `pacman`
   - Automatically handles `sudo` permissions when needed
   - Supports multiple formats:
     - **Simple list** (defaults to `apt`): `["vim", "curl", "git"]`
     - **Structured format with apt**:
       ```yaml
       - packages: [vim, git, build-essential]
         options: [-y]
       ```
     - **Specify package manager**:
       ```yaml
       package_manager: dnf
       packages: [vim, git, curl]
       options: [-y]
       ```
     - **Multiple installation specs**:
       ```yaml
       - package_manager: apt
         packages: [vim, curl]
         options: [-y]
       - package_manager: dnf
         packages: [htop, ncdu]
         options: [-y]
       ```

3. **`post_start_commands`**: Generic commands to execute
   - List of shell commands to run after package installations
   - Useful for installing tools with other package managers (cargo, go, npm, etc.)
   - Example: 
     ```yaml
     - "cargo install bat"
     - "go install github.com/xxx/tool@latest"
     - "echo 'Installation complete'"
     ```

#### Installation Process

1. When a persistent container is started (or created for the first time):
   - **System packages**: Package manager is updated (e.g., `apt-get update`, `dnf check-update`)
   - **Automatic sudo handling**: If container user is not root, Zai automatically uses `sudo` when available
   - **Package installation**: Packages in `apt_install` are installed with appropriate package manager
   - **Python packages**: `pip` is upgraded to the latest version
   - **Package installation**: Packages in `pip_install` are installed
   - **Generic commands**: Commands in `post_start_commands` are executed in order

2. **Smart permission handling**:
   - If container user is root (UID=0), commands run directly
   - If `sudo` is available in container, commands are prefixed with `sudo`
   - If neither root nor sudo is available, commands run directly (may fail with permission errors)
   - All package managers (`apt`, `dnf`, `yum`, etc.) benefit from this automatic permission handling

3. **Error handling**:
   - Package manager update failures show warnings but installation continues
   - If `pip` upgrade fails, a warning is shown but installation continues
   - Individual package installation failures are logged but don't stop the process
   - All errors are reported to stderr for debugging

#### Complete Example

```yaml
- sandbox_home: /path/to/project/sandbox
  shell_container:
    image: python:3.11-slim
    name: my-project-container
    working_dir: /sandbox
  
  # Python package installations
  pip_install:
    - packages: [PyYAML, appdirs, requests]
    - packages: [torch, torchvision, torchaudio]
      options: [--index-url, https://download.pytorch.org/whl/cpu]
  
  # Linux package installations  
  apt_install:
    - packages: [vim, curl, git, build-essential]
  
  # Generic commands
  post_start_commands:
    - "cargo install bat exa"
    - "echo 'Development environment ready'"
    - "python3 --version && pip --version"
```

### Configuration Fields

- `sandbox_home`: Directory for sandboxed file operations. Defaults to `~/.local/share/zai/sandbox`.
- `shell_container`: Configuration for the `tool_shell` Docker container.
  - `image`: Docker image name (default: `taskbox:latest`)
  - `name`: Container name (default: `zai-tool-shell-taskbox`)
  - `working_dir`: Container working directory (default: `/sandbox`)
  - `user`: User UID:GID (default: host user's UID:GID)
  - `volumes`: List of volume mounts in `host:container:mode` format
  - `network_mode`: Docker network mode (default: `bridge`)
  - Other Docker SDK parameters are passed directly to container creation.

### Tool Shell

The `tool_shell` tool provides secure shell execution in a Docker container (taskbox) with:
- Isolated environment
- Persistent containers across calls
- Project-specific configuration
- Network access control
- Resource limits

Example usage in AI conversation:
```
:use tool shell
Please list files in the current directory.
**Assistant:**
  - **tool call**: `execute_shell` ({"command": "ls -la"...)
  - return: `execute_shell`
```

The tool automatically uses project configuration if available, otherwise uses defaults.

### Sandbox Directory

The sandbox directory is used by file-related tools (`tool_file`, `tool_shell`) as a safe workspace. Files outside the sandbox cannot be accessed for security.

## License

Released under MIT License. See: [https://github.com/zighouse/zai/blob/main/LICENSE](https://github.com/zighouse/zai/blob/main/LICENSE)

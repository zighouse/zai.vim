# Session Commands

This page covers session commands that configure AI behavior at runtime through the Zai chat interface.

## Overview

Session commands are special commands that you type in the Zai input window to:
- Change AI models and providers
- Adjust AI parameters (temperature, max tokens, etc.)
- Manage tools and toolsets
- Attach/detach files
- Control Docker containers
- Configure sandbox paths

## Command Syntax

Session commands have three parts:

```
:command_name argument
```

- **Prefix**: `:` (default, can be changed)
- **Command**: Action to perform
- **Argument**: Command-specific parameters

## Change Command Prefix

Change the default command prefix from `:` to another character.

```
:->/
```

Now use `/` as prefix:
```
/show model
```

Available prefix characters:
```
: / ~ \ ; ! # $ % & ? @ ^ _ * + = , . < > ` ' " ( ) [ ] { }
```

## General Commands

### Help

```
:help
```

Show available session commands.

### Exit/Quit

```
:exit
```
or
```
:quit
```

Force exit the remote AI service connection.

### Show Configuration

```
:show <config-item>
```

Display current configuration values.

**Available items:**
```
:show base-url        # Show API base URL
:show api-key-name    # Show API key environment variable
:show model           # Show current model
:show prompt          # Show system prompt
:show temperature     # Show creativity parameter
:show max-tokens      # Show max tokens
:show top-p           # Show top-p sampling
:show log-file        # Show log file path
:show prefix          # Show command prefix
```

## AI Provider and Model Commands

### List AI Assistants

```
:list ai
```

Show all configured AI assistants from `assistants.yaml`.

### Show AI Assistant

```
:show ai
:show ai [name|index]
```

Display details of an AI assistant.

```
:show ai              # Show current assistant
:show ai deepseek     # Show by name
:show ai 0            # Show by index (0-based)
```

### Use AI Assistant

```
:use ai <name|index>
```

Switch to a different AI provider.

```
:use ai openai        # Switch by name
:use ai 1             # Switch by index
```

### Change Model

```
:model <name|index>
```

Change the AI model within the current assistant.

```
:model deepseek-chat
:model gpt-4
:model 0              # Use first model from list
```

### Use AI and Model Together

```
:use ai <name|index> model <name|index>
```

Switch assistant and model in one command.

```
:use ai deepseek model deepseek-chat
:use ai 0 model 1
```

## Parameter Commands

### Set Base URL

```
:base-url <url>
```

Change the API endpoint for the current session.

```
:base-url https://api.openai.com/v1
:base-url https://custom-endpoint.com
```

### Set API Key Name

```
:api-key-name <variable-name>
```

Specify the environment variable containing the API key.

```
:api-key-name OPENAI_API_KEY
:api-key-name DEEPSEEK_API_KEY
```

### Temperature (Creativity)

Set creativity parameter (0.0 to 2.0).

```
:temperature 0.7      # Balanced
:temperature 0.0      # Deterministic
:temperature 1.0      # Creative
:temperature 1.5      # Very creative
```

Reset to default:
```
:-temperature
```

### Top-P Sampling

Set top-p sampling (0.0 to 1.0).

```
:top-p 0.9
:top-p 1.0
```

Reset:
```
:-top_p
```

### Max Tokens

Set maximum output tokens.

```
:max_tokens 1000
:max_tokens 4000
```

Reset:
```
:-max_tokens
```

### Top Logprobs

Show top token probabilities (0 to 20).

```
:logprobs 5           # Show top 5 tokens
:logprobs 10
```

### History Management

#### History Safety Factor

Control how aggressively to prune conversation history (0.1 to 0.5).

```
:history_safety_factor 0.25
```

Lower values prune more aggressively.

#### Keep Last N Rounds

Keep the last N conversation rounds.

```
:history_keep_last_n 6
:history_keep_last_n 10
```

## Prompt Commands

### Set Single-Line Prompt

```
:prompt You are a helpful coding assistant.
```

### Set Multi-Line Prompt (Block Syntax)

```
:prompt<<EOF
You are an expert programmer.
Please provide code examples.
When explaining, use this format:
  ### Title
  - Step 1
  - Step 2
EOF
```

You can use any delimiter, not just EOF:
```
:prompt<PROMPT
Multi-line prompt here.
PROMPT
```

### Clear Prompt

Reset to default system prompt:
```
:-prompt
```

## File Attachment Commands

### Attach File

```
:file <file-path>
```

Attach a text file to the conversation context.

```
:file /path/to/code.py
:file ~/Documents/notes.txt
```

### Clear Attachments

Remove all attached files:
```
:-file
```

## Tool Commands

### List Tools

```
:list tool
```

Show all available toolsets.

### Show Tool

```
:show tool [name]
```

Display details of a toolset.

```
:show tool            # Show all tools
:show tool file       # Show file toolset
:show tool web        # Show web toolset
```

### Use Tool

Load a toolset for AI to use.

```
:use tool file        # Load all file tools
:use tool web         # Load web tools
:use tool file web    # Load multiple toolsets
```

### Load Specific Functions

Load only specific functions from a toolset:

```
:use tool file.read_file
:use tool file: read_file write_file
```

## Sandbox Commands

### Set Sandbox Path

```
:sandbox <path>
```

Set the sandbox directory for file operations.

```
:sandbox /home/user/project/sandbox
:sandbox ~/my-sandbox
```

## Docker Container Commands

### Show Taskbox Status

```
:show taskbox
```

Display taskbox container information:
- Container name
- Image
- Status
- Mounts
- Environment

### Start Taskbox

```
:start taskbox
```

Start the Docker container for shell execution.

### Stop Taskbox

```
:stop taskbox
```

Stop the taskbox container.

## Web Tool Commands

### Web Search

```
:search <keywords>
```

Search the web (uses SearXNG).

```
:search vim plugins
:search python async await best practices
```

### Get Web Page

```
:goto <url>
```

Fetch and display web page content.

```
:goto https://example.com
:goto https://github.com/zighouse/zai.vim
```

### Download File

```
:down <url>
```

Download a file from the web.

```
:down https://example.com/file.zip
:down https://example.com/image.png
```

## Logging Commands

### Disable Logging

Stop saving conversation to log file:
```
:no-log
```

### Enable Logging

Resume saving conversation:
```
:-no-log
```

### Load Log File

Load a previous conversation log as context:
```
:load <log-file-path>
```

```
:load ~/.local/share/zai/log/chat_20250130_123456.log
```

## Completion Commands

### Set Completion File Type

```
:complete_type <filetype>
```

Set file type for code completion.

```
:complete_type python
:complete_type javascript
```

### Set Completion Prefix

```
:prefix <text>
```

Set prefix for code completion.

```
:prefix def hello
```

### Multi-Line Prefix

```
:prefix<<EOF
def hello():
    return
EOF
```

### Clear Prefix

```
:-prefix
```

### Set Completion Suffix

```
:suffix <text>
```

Set suffix for fill-in-middle completion.

```
:suffix }
```

### Multi-Line Suffix

```
:suffix<<EOF

if __name__ == "__main__":
    main()
EOF
```

## Conversation Mode

### Set Talk Mode

```
:talk_mode <mode>
```

Set conversation mode.

```
:talk_mode instant    # Instant responses
:talk_mode chain      # Chain of thought
```

## Reset Parameters

Reset any parameter to its default value:

```
:-temperature
:-max_tokens
:-top_p
:-prompt
:-prefix
:-suffix
```

## Usage Examples

### Example 1: Switch Provider and Model

```
:use ai openai model gpt-4
Hello! Please help me with Python code.
```

### Example 2: Attach Files and Ask

```
:file ~/project/main.py
:file ~/project/utils.py

Please explain what this code does.
```

### Example 3: Adjust Creativity

```
:temperature 0.3
:model deepseek-reasoner

Analyze this problem step by step and provide a detailed solution.
```

### Example 4: Multi-line Prompt with Question

```
:prompt<<PROMPT
You are a Python expert.
Provide code examples.
Explain your reasoning.
PROMPT

How do I implement async/await in Python?
```

### Example 5: Use Tools

```
:use tool file web shell

Read the file config.json, search for errors online, and run tests.
```

### Example 6: Change Parameters Mid-Conversation

```
Write a creative story about AI.

[After reading story]

:temperature 0.3
Now analyze the story structure.
```

## Combining Commands

You can combine multiple commands with your question:

```
:model deepseek-chat
:temperature 0.7
:use tool file

Read the file example.py and explain the code.
```

Separate commands with blank lines for readability:

```
:model deepseek-chat
:temperature 0.7

:use tool file

Read the file example.py and explain the code.
```

## Troubleshooting

### Command Not Recognized

Check:
1. Command prefix is correct (default `:`)
2. Command name is spelled correctly
3. Use `:help` to see available commands

### Parameter Not Taking Effect

Check:
1. Parameter name is correct (use `:show`)
2. Value is in valid range
3. No conflicting settings

### Tool Not Loading

Check:
1. Tool is available: `:list tool`
2. Dependencies are installed
3. Configuration is correct

## Next Steps

- [Basic Configuration](basic.md) - Vim configuration options
- [AI Assistants Configuration](assistants.md) - Multiple AI providers
- [Project Configuration](project.md) - Docker and sandbox settings
- [Environment Variables](environment.md) - All environment variables

## Related Topics

- [Commands Reference](../commands/) - Vim commands
- [Tools Documentation](../tools/) - AI tool capabilities

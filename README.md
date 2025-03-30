# Zai.Vim DeepSeek AI Assistant

![Plugin Screenshot](screenshot.png)

Zai.Vim is a Vim plugin that seamlessly integrates the DeepSeek AI Assistant into your Vim editor. It allows you to access DeepSeek's intelligent services while coding or writing documents, without interrupting your workflow.

## Features

- **Dual-pane Interface**: Independent input/output windows for smooth interaction
- **Flexible Configuration**: Switch models/prompts mid-conversation
- **File Attachments**: Attach text files as conversation context
- **Session Logging**: Automatic conversation history preservation

## Installation

### Requirements

- Vim 8.0+ or Neovim
- Python 3.6+
- DeepSeek API key (set as `DEEPSEEK_API_KEY` environment variable)
- Required Python packages:
  - `openai` (auto-install attempted if missing)

### Using a plugin manager

With [vim-plug](https://github.com/junegunn/vim-plug):

```vim
Plug 'zighouse/zai'
```

With [Vundle](https://github.com/VundleVim/Vundle.vim):

```vim
Plugin 'zighouse/zai'
```

[lazy.nvim](https://github.com/folke/lazy.nvim):
```lua
-- Create zai-vim.lua in .config/nvim/lua/plugins/
return {
    {
        "zighouse/zai.vim",
        config = function()
            vim.g.zai_default_model = "deepseek-coder"  -- Optional config
        end
    }
}
```

## Core Concepts
### Session Logs
Zai automatically saves conversation history. Each session (from opening Zai until closing with `:ZaiClose`) generates a log file:
- Linux/Mac: `~/.local/share/zai/log`  
- Windows: `%USERPROFILE%\AppData\Local\zai\log`

### Session Modes
- **Chain Mode**: Maintains full conversation context (ideal for complex tasks)
- **Instant Mode**: Single-turn interactions (ideal for simple Q&A)

Switch modes using session commands:
```
:talk_mode chain   # Enable chain mode
:talk_mode instant # Enable instant mode
```

## Usage

### Key Mappings
| Key Binding     | Command       | Description                  | Mode          |
|-----------------|---------------|------------------------------|---------------|
| `<Leader>zo`    | `:Zai`        | Open Zai interface           | Normal        |
| `<Leader>zg`    | `:ZaiGo`      | Send query                   | Insert        |
| `<Leader>zX`    | `:ZaiClose`   | Close session                | Normal        |
| `<Leader>za`    | `:ZaiAdd`     | Add visual selection to input | Visual        |

### Session Commands

At any time you can use following commands Zai input pane to change the mode or parameters of following conversation. You can select a new model or a new system prompt for a new request.

Prefix commands with `:` in input area:

- `:help` - Show help message
- `:exit`/`:quit` - Exit the interface
- `:talk_mode` - Set conversation mode (chain, instant)
- `:model <name>` - Set model (deepseek-coder, deepseek-chat, deepseek-reasoner, etc.)
- `:temperature <value>` - Set creativity (0-2)
- `:prompt <text>` - Set system prompt (single line system prompt content)
- `:file <path>` - Attach a text file
- `:->/` - Change command prefix to `/`

### Change the talk_mode in conversation

You can change the talk-mode from chain to instant at any time.

When in chain talk-mode, you chain all your history conversation as context along with you last request content and send to DeepSeek service. 

```
:talk_mode chain
```

When in instant talk-mode, you only send the last request content without previous conversation context.  

```
:talk_mode instant
```

Inspite which mode you choose, all conversation contents in a Zai session are logged into one file. If you want to start a new session, close it with `ZaiClose` command or `<Leader>zX`.


### Multi-line Input in Zai Interface and Block :prompt Syntax

Zai supports multi-line input through a special block syntax, making it easy to submit complex prompts or code examples to DeepSeek. All you need is to write your request content in input pane and send it to DeepSeek.

You also can override the default one with well considered and a multi-line block of text. The block input system makes it easy to have structured conversations with DeepSeek while maintaining clean, readable prompts in your Vim workflow.

To make multiple lines as a system prompt:
1. Start with `:prompt<<EOF` (or any unique marker)
2. Enter your well defined content line by line for new prompt
3. End with `EOF` (or your chosen marker)

You can structure your prompt to get well-formatted:

```
:model deepseek-reasoner
:prompt<<TEMPLATE
 - "As a code-specialized AI, analyze the problem step-by-step. Always start your final answer with a bolded title summarizing the solution."  
 - Example output format:  
   ### [Solution Summary]
   [Step-by-Step Explanation]  
TEMPLATE

I want to show inline thumbnail pictures in vim window when I open my markdown documents with picture tags. How to?
```

Or

```
:model deepseek-chat
:temperature 0.3
:prompt<<CODE
 - Sample Interaction:  

   User: How to reverse a linked list?  

   Assistant:  
   ### Title: Iterative Linked List Reversal
   1. Initialize prev/current/next pointers.  
   2. Loop: Update next, reverse link, shift pointers.  
   3. Return new head.  

   Code: [Python/Java snippet]
CODE

I have a map of a city, how to find the shortest path between two places in it?
```

## License

MIT License

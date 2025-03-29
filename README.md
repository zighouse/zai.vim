# Zai - Deepseek AI Assistant for Vim

![Plugin Screenshot](screenshot.png) <!-- Placeholder for screenshot -->

Zai is a Vim plugin that integrates the Deepseek AI assistant directly into your Vim editor. It provides a convenient interface for interacting with Deepseek's powerful language models while coding or writing documentation.

## Features

- **Dual-pane interface**: Input and output windows for seamless interaction
- **Customizable prompts**: Set system prompts to guide the AI's responses
- **File attachment**: Include file contents in your queries
- **Model selection**: Choose between different Deepseek models
- **Converation control**: Allow changes of configuration in conversation
- **Session logs**: Keep logs for conversatation

## Installation

### Requirements

- Vim 8.0+ or Neovim
- Python 3.6+
- Deepseek API key (set as `DEEPSEEK_API_KEY` environment variable)
- OpenAI Python library (will be automatically installed if missing)

### Using a plugin manager

With [vim-plug](https://github.com/junegunn/vim-plug):

```vim
Plug 'zighouse/zai'
```

With [Vundle](https://github.com/VundleVim/Vundle.vim):

```vim
Plugin 'zighouse/zai'
```

## Usage

### Basic Commands

| Command       | Description                          | Key Mapping       |
|---------------|--------------------------------------|-------------------|
| `:Zai`        | Open the Zai interface              | `<Leader>zo`      |
| `:ZaiGo`      | Send current input to Deepseek      | `<Leader>zg`      |
| `:ZaiClose`   | Close the current Zai session       | `<Leader>zX`      |
| `:ZaiAdd`     | Add visual selection to input       | `<Leader>za` (visual) |

### Key Mappings

The plugin provides the following default key mappings:

- `<Leader>zo` - Open Zai interface
- `<Leader>zg` - Send input to Deepseek
- `<Leader>zX` - Close the current Zai session
- `<Leader>za` - Add visual selection to input (visual mode)

## Deepseek Commands in Zai session

At any time you can use following commands Zai input pane to change the mode or parameters of following conversation. You can select a new model or a new system prompt for a new request.

When the Zai interface is open, you can use special commands prefixed with `:` (configurable):

- `:help` - Show help message
- `:exit`/`:quit` - Exit the interface
- `:talk\_mode` - Set conversation mode (chain, instant)
- `:model <name>` - Set model (deepseek-coder, deepseek-chat, deepseek-reasoner, etc.)
- `:temperature <value>` - Set creativity (0-2)
- `:prompt <text>` - Set system prompt (single line system prompt content)
- `:file <path>` - Attach a text file
- `:->/` - Change command prefix to `/`

### Change the talk\_mode in conversation

You can change the talk-mode from chain to instant at any time.

When in chain talk-mode, you chain all your history conversation as context along with you last request content and send to Deepseek service. 

```
:talk\_mode chain
```

When in instant talk-mode, you only send the last request content without previous conversation context.  

```
:talk\_mode instant
```

Inspite which mode you choose, all conversation contents in a Zai session are logged into one file. If you want to start a new session, close it with `ZaiClose` command or `<Leader>zX`.


### Multi-line Input in Zai Interface and Block :prompt Syntax

Zai supports multi-line input through a special block syntax, making it easy to submit complex prompts or code examples to Deepseek. All you need is to write your request content in input pane and send it to deepseek.

You also can override the default one with well considered and a multi-line block of text. The block input system makes it easy to have structured conversations with Deepseek while maintaining clean, readable prompts in your Vim workflow.

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

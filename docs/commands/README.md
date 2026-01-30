# Command Reference

Complete reference for all Zai.Vim commands.

## Command Categories

- **[Basic Commands](basic.md)** - Open, close, and navigate Zai interface
- **[Session Management](session.md)** - Manage multiple chat sessions
- **[Log Management](log.md)** - View, search, and load conversation logs
- **[Voice Input Commands](asr.md)** - ASR (speech recognition) commands
- **[Input Commands](input.md)** - Send messages and add content
- **[Key Mappings](key-mappings.md)** - Default keyboard shortcuts

## Quick Reference

### Opening Zai

```vim
:Zai              " Open Zai interface
<leader>zo        " Open (normal mode)
```

### Sending Messages

```vim
:ZaiGo            " Send input content
<CR>              " Send (in input window, normal mode)
```

### Closing Zai

```vim
:ZaiClose         " Close Zai interface
<leader>zX        " Close (normal mode)
:q                " Close (in Zai interface only)
```

### Session Management

```vim
:ZaiNew           " Create new chat session
:ZaiPrev          " Select previous session
:ZaiNext          " Select next session
:ZaiGoto 0        " Go to session by ID
```

### Log Commands

```vim
:ZaiOpenLog       " Open current log file
:ZaiGrepLog pattern " Search logs
:ZaiLoad          " Load log as context
```

## Command Modes

Commands work in different Vim modes:

| Mode | Description | Where |
|------|-------------|-------|
| **-** | Any mode | Global commands |
| **Normal** | Normal mode | Any buffer |
| **Visual** | Visual mode | Selected text |
| **Zai interface** | Only in Zai windows | Session list, display, or input window |
| **Input window** | Only in input window | Bottom Zai window |

## Command Prefixes

Zai supports two types of commands:

1. **Vim Commands** - Start with `:` and execute in Vim's command-line mode
2. **Session Commands** - Special commands in the input window for AI configuration

Session commands are documented in [Session Commands](../configuration/session-commands.md).

## Usage Examples

### Basic Chat

```vim
" Open Zai
:Zai

" Type your question in input window
How do I parse JSON in Python?

" Press <CR> to send
```

### Multiple Sessions

```vim
" Open Zai
:Zai

" Create new session
:ZaiNew

" Navigate between sessions
:ZaiPrev          " Go to previous
:ZaiNext          " Go to next

" Jump to specific session
:ZaiGoto 2
```

### Working with Logs

```vim
" Open current log
:ZaiOpenLog

" Search logs
:ZaiGrepLog error

" Load previous conversation
:ZaiLoad
" Select log file from prompt
```

### Using with Selection

```vim
" In any buffer, select code
v}                 " Visual select paragraph

" Add to Zai input
:ZaiAdd

" Open Zai to see content
:Zai

" Add context
Please explain this code.
```

## Getting Help

### Vim Help

```vim
:help zai          " Open Zai help
:help zai-commands " Command reference
```

### Session Commands Help

In Zai input window:

```
:help
```

Show all available session commands.

## Next Steps

- [Basic Commands](basic.md) - Essential commands
- [Session Management](session.md) - Multiple chats
- [Log Management](log.md) - Conversation history
- [Key Mappings](key-mappings.md) - Default shortcuts

## Related Topics

- [Installation Guide](../installation/) - Set up Zai.Vim
- [Configuration Guide](../configuration/) - Configure Zai
- [Session Commands](../configuration/session-commands.md) - Runtime configuration

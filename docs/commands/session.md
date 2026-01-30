# Session Management Commands

Manage multiple concurrent chat sessions in Zai.Vim.

## Overview

Zai.Vim supports multiple simultaneous chat sessions:
- Each session has its own context and history
- Sessions are identified by numeric IDs (starting from 0)
- Switch between sessions seamlessly
- Each session maintains separate AI configuration

## Creating Sessions

### `:ZaiNew`

Create a new chat session.

**Usage:**
```vim
:ZaiNew
```

**Mode:** Zai interface only

**Behavior:**
- Creates new session with next available ID
- Switches to new session immediately
- Session starts with default AI configuration
- Can configure independently with session commands

**Example:**
```vim
:ZaiNew          " Creates session 1
" Configure for coding
:model deepseek-chat
:prompt You are a Python expert.

:ZaiNew          " Creates session 2
" Configure for writing
:model gpt-4
:prompt You are a creative writer.
```

## Switching Sessions

### `:[count]ZaiPrev`

Select previous chat session.

**Usage:**
```vim
:ZaiPrev         " Go to previous session
:2ZaiPrev        " Go back 2 sessions
```

**Mode:** Zai interface only

**Key Mapping:** `:[count]cp` (short form)

### `:[count]ZaiNext`

Select next chat session.

**Usage:**
```vim
:ZaiNext         " Go to next session
:3ZaiNext        " Go forward 3 sessions
```

**Mode:** Zai interface only

**Key Mapping:** `:[count]cn` (short form)

### `:ZaiGoto {id}`

Jump to specific session by ID.

**Usage:**
```vim
:ZaiGoto 0       " Jump to session 0
:ZaiGoto 5       " Jump to session 5
```

**Mode:** Zai interface only

**Key Mapping:** `:cn {id}` (short form)

## Session List Display

The session list window shows all active sessions:

```
  ID  Model                      Preview
─────────────────────────────────────────
> 0   deepseek-chat           How do I...
  1   gpt-4                   Write a story...
  2   deepseek-reasoner       Analyze this...
```

- `>` indicates current session
- `ID` is the session number
- `Model` is the current AI model
- `Preview` shows recent message

## Session Workflows

### Multi-Task Conversations

```vim
" Open Zai
:Zai

" Session 0 - Code help
Please help me debug this Python function.

" Create new session for translation
:ZaiNew
:model gpt-4
:prompt You are a professional translator.

" Translate text
Translate this to Spanish: Hello world

" Switch back to coding session
:ZaiPrev

" Continue coding discussion
```

### Comparison Sessions

```vim
" Session 0 - Ask deepseek-chat
:ZaiNew
:model deepseek-chat
What are the benefits of async programming?

" Session 1 - Ask same question to different model
:ZaiNew
:model gpt-4
What are the benefits of async programming?

" Compare responses
:ZaiGoto 0        " View deepseek response
:ZaiGoto 1        " View gpt-4 response
```

### Specialized Sessions

```vim
" Session 0 - General chat
" (default when opening Zai)

" Session 1 - Code reviewer
:ZaiNew
:model deepseek-chat
:prompt You are a code reviewer. Focus on security and performance.
:use tool file grep shell

" Session 2 - Documentation writer
:ZaiNew
:model gpt-4
:prompt You write clear, concise documentation.

" Session 3 - Creative assistant
:ZaiNew
:model gemini-2.5-flash
:prompt You are a creative writing assistant.

" Switch between tasks
:ZaiGoto 1        " Code review
:ZaiGoto 2        " Documentation
:ZaiGoto 3        " Creative writing
```

## Session Independence

Each session maintains its own:
- **Model** - Different AI models
- **Prompt** - Different system prompts
- **Temperature** - Different creativity levels
- **History** - Separate conversation history
- **Attachments** - Different file attachments
- **Tools** - Different toolsets loaded

### Example: Independent Configuration

```vim
" Session 0 - Analytical
:ZaiGoto 0
:model deepseek-reasoner
:temperature 0.3
:use tool shell web

" Session 1 - Creative
:ZaiGoto 1
:model gpt-4
:temperature 1.0
```

## Session Navigation Tips

### Quick Navigation

```vim
" Jump to first session
:ZaiGoto 0

" Jump to last session
" (count from current or check list)

" Navigate sequentially
:ZaiNext
:ZaiPrev
```

### Count Navigation

```vim
" Skip 2 sessions forward
:2ZaiNext        " or :2cn

" Skip 3 sessions back
:3ZaiPrev        " or :3cp
```

## Session State Persistence

Sessions are preserved:
- When switching between sessions
- When closing and reopening Zai interface
- Across Vim restarts (if Vim is configured to save sessions)

### Session Data Location

Conversations are saved to log files:
```
~/.local/share/zai/log/chat_YYYYMMDD_HHMMSS.log
```

Each session's conversation is logged separately.

## Managing Active Sessions

### Check Number of Sessions

Look at the session list window to see:
- Total session count
- Current session (marked with `>`)
- Session IDs

### Close Specific Session

Currently, you close all sessions with:
```vim
:ZaiClose
```

To effectively "remove" a session:
1. Clear its conversation history (start fresh)
2. Or manually delete the log file

### Session Best Practices

1. **Organize by Task**
   ```
   Session 0: General assistance
   Session 1: Code review
   Session 2: Writing help
   ```

2. **Use Consistent IDs**
   - Remember key session IDs
   - Use `:ZaiGoto` for quick access

3. **Label with Prompts**
   ```vim
   " Session 1
   :prompt You are a Python expert (Session 1).

   " Session 2
   :prompt You are a translator (Session 2).
   ```

4. **Clean Up Regularly**
   - Delete old log files
   - Archive important conversations
   - Use `:ZaiLoad` to review history

## Troubleshooting

### Can't Create New Session

**Check:**
1. Python is working: `:echo has('python3')`
2. API key is set: `echo $DEEPSEEK_API_KEY`
3. Sufficient memory/resources

### Session Switching Not Working

**Check:**
1. You're in Zai interface (not regular buffer)
2. Session exists (check session list)
3. Correct session ID for `:ZaiGoto`

### Lost Session Context

**Recover from log:**
```vim
:ZaiLoad
" Select log file
" Session will be restored with that context
```

## Advanced Usage

### Automated Session Creation

```vim
" In .vimrc
function! s:NewCodeReviewSession()
    ZaiNew
    call feedkeys(":model deepseek-chat\<CR>")
    call feedkeys(":prompt You are a code reviewer.\<CR>")
    call feedkeys(":use tool file grep\<CR>")
endfunction

command! -nargs=0 CodeReview call s:NewCodeReviewSession()
```

Use:
```vim
:CodeReview       " Creates configured session
```

### Session Templates

Create predefined session types:

```vim
" Python helper
function! s:PythonSession()
    ZaiNew
    call feedkeys(":model deepseek-chat\<CR>")
    call feedkeys(":prompt You are a Python expert.\<CR>")
endfunction

" Translator
function! s:TranslateSession()
    ZaiNew
    call feedkeys(":model gpt-4\<CR>")
    call feedkeys(":prompt Translate accurately.\<CR>")
endfunction
```

## Next Steps

- [Basic Commands](basic.md) - Open and close Zai
- [Log Management](log.md) - View conversation history
- [Input Commands](input.md) - Send messages
- [Key Mappings](key-mappings.md) - Keyboard shortcuts

## Related Topics

- [Session Commands](../configuration/session-commands.md) - Runtime configuration
- [Log Management](log.md) - Conversation history
- [Configuration Guide](../configuration/) - AI assistants and settings

# Input Commands

Commands for adding content, sending messages, and managing input in Zai.Vim.

## Overview

The input window is where you:
- Type questions and messages to the AI
- Attach files as context
- Use session commands to configure behavior
- Send multi-line messages with special formatting

## Sending Messages

### `:ZaiGo`

Send content from input window to AI.

**Usage:**
```vim
:ZaiGo
```

**Key Mapping:** `<CR>` (in input window, normal mode)

**Workflow:**
1. Type message in input window
2. Exit insert mode: `<Esc>`
3. Send: `<CR>`

**Example:**
```vim
" In Zai input window
iHow do I parse JSON in Python?<Esc>
<CR>
```

### Multi-line Messages

For complex queries, use multiple lines:

```vim
" In input window
iI have a Python function that reads a CSV file.
<Esc>
oHowever, it's very slow with large files.
<Esc>
oHow can I optimize it?<Esc>
<CR>
```

## Adding Content

### `:ZaiAdd`

Add selected text to input window.

**Usage:**
```vim
:ZaiAdd
```

**Key Mapping:** `<leader>za` (visual mode)

**Mode:** Visual mode (any buffer)

**Workflow:**
1. Select text in any buffer: `v` then move cursor
2. Add to Zai: `:ZaiAdd` or `<leader>za`
3. Text is appended to input window
4. Open Zai: `:Zai`
5. Add context and send

**Example:**
```vim
" In a Python file
v}                 " Visual select paragraph
:ZaiAdd            " Add to Zai input

" Open Zai to see content
:Zai

" Add question
iPlease explain this code:<Esc>
<CR>
```

### Combining Selection and Question

```vim
" Select code
v}
:ZaiAdd

" Open Zai and ask
:Zai
iWhat does this function do?<Esc>
<CR>
```

## File Attachments

### `:AI attach {file}`

Attach a file to conversation context.

**Usage:**
```vim
:AI attach /path/to/file.py
:AI attach ~/project/config.yaml
```

**Mode:** Any mode

**Session Command Alternative:**
```
:file /path/to/file.txt
```

**Behavior:**
- File contents are read and added to context
- File appears in AI's knowledge
- Can attach multiple files

### Clear Attachments

```
:-file
```

Remove all attached files from context.

## Input Window Formatting

### Plain Text Questions

Simple one-line questions:

```
How do I parse JSON in Python?
```

### Questions with Context

Provide background information:

```
I'm working on a web scraper in Python.
It uses BeautifulSoup to parse HTML.
However, it's slow with multiple pages.
How can I speed it up?
```

### Multi-line with Session Commands

Combine commands with your question:

```
:model deepseek-reasoner
:temperature 0.3

Analyze this problem step by step.
Explain your reasoning.
```

### Block Syntax for Prompts

Use multi-line system prompts:

```
:prompt<<EOF
You are a Python expert.
Focus on performance and best practices.
Provide code examples.
EOF

How do I optimize database queries?
```

## Special Input Features

### Session Commands in Input

Use session commands mixed with questions:

```
:model gpt-4
:use tool file web

Read main.py and suggest improvements.
```

See [Session Commands](../configuration/session-commands.md) for complete reference.

### Code Blocks in Messages

Include code in your questions:

```
I have this function:

def process_data(items):
    result = []
    for item in items:
        result.append(item * 2)
    return result

How can I make it more Pythonic?
```

### Preserving Formatting

Zai preserves:
- Line breaks
- Indentation
- Code blocks
- Markdown formatting

## Input Patterns

### Question Pattern

```
[Optional context]

[Specific question]

[Optional requirements]
```

Example:
```
I'm learning Python async programming.

What's the difference between asyncio and threading?

Please provide simple examples.
```

### Code Review Pattern

```
:prompt You are a code reviewer. Focus on security and performance.

[Attach file with :file command]

Please review this code for:
1. Security issues
2. Performance problems
3. Best practices
```

### Explanation Pattern

```
:use tool file

:file /path/to/code.py

Explain what this code does and how it works.
```

### Refactoring Pattern

```
:file old_code.py

Refactor this to be more readable and maintainable.
Follow PEP 8 guidelines.
```

## Input Tips

### Be Specific

```
" Good
How do I parse a nested JSON structure in Python using the json library?

" Less clear
How do I parse JSON?
```

### Provide Context

```
" Good
I'm using Python 3.11 with Django 4.2.
I need to create a custom authentication backend.

" Less clear
How do I do authentication?
```

### Use Code Examples

```
" Good
Here's my current code:
[paste code]

How do I add error handling?

" Less clear
How do I add error handling to my code?
```

### Specify Requirements

```
" Good
Generate a Python function that:
- Takes a list of dictionaries
- Sorts by the 'date' key
- Returns the 10 most recent items
- Handles empty lists

" Less clear
Sort a list of dictionaries.
```

## Quick Templates

### Bug Report

```
I'm getting this error:
[paste error]

Here's my code:
[paste code]

What's causing this and how do I fix it?
```

### Feature Request

```
I want to implement [feature].

Current approach:
[describe current code]

Desired behavior:
[describe what you want]

How should I implement this?
```

### Learning Request

```
I'm learning [topic].

Please explain [concept]:
- What it is
- How it works
- When to use it
- Code examples
```

### Code Comparison

```
:file approach_a.py
:file approach_b.py

Compare these two implementations.
Which is better and why?
```

## Input Window Shortcuts

### Navigation

```
j / k          " Move down/up
Ctrl-d         " Page down
Ctrl-u         " Page up
gg             " Go to top
G              " Go to bottom
```

### Editing

```
i / a          " Enter insert mode
o / O          " Add line below/above
dd             " Delete line
yy             " Yank line
p              " Paste
```

### Insert Mode

```
<Esc>          " Exit insert mode
<CR>           " Insert newline
<Tab>          " Insert tab
Ctrl-w         " Delete word
Ctrl-u         " Delete to line start
```

## Input Window Configuration

### Auto-clear After Send

Input window automatically clears after sending.

**To keep text:** Use register to yank before sending:
```vim
" Yank to register a
"aY
:ZaiGo

" Paste back
"aP
```

### Change Input Height

Adjust in `.vimrc`:
```vim
" This is handled by Zai's window management
" Default split is approximately 1/3 of screen
```

## Common Issues

### Message Not Sending

**Check:**
1. You're in normal mode (not insert)
2. Input window has focus
3. Use `<CR>` not `:ZaiGo` in normal mode

### Text Not Appearing

**Check:**
1. You're in insert mode: `i`
2. Input window is focused: `Ctrl-w j`
3. Not in readonly mode

### Session Commands Not Working

**Check:**
1. Command prefix is `:` (default)
2. Command name is correct: `:help`
3. No extra spaces

## Best Practices

1. **Clear, Specific Questions**
   - Include relevant context
   - Specify what you need
   - Provide examples

2. **Use Session Commands**
   - Set appropriate model for task
   - Load relevant tools
   - Adjust parameters

3. **Attach Files**
   - Use `:file` for code context
   - Attach config files
   - Include error logs

4. **Multi-line for Complex Queries**
   - Separate sections with blank lines
   - Use numbered lists for requirements
   - Include code blocks for clarity

## Next Steps

- [Basic Commands](basic.md) - Open and close Zai
- [Session Commands](../configuration/session-commands.md) - Runtime configuration
- [Key Mappings](key-mappings.md) - All keyboard shortcuts
- [Configuration Guide](../configuration/) - Customize behavior

## Related Topics

- [Session Management](session.md) - Multiple conversations
- [Log Management](log.md) - Conversation history
- [ASR Commands](asr.md) - Voice input

# Log Management Commands

View, search, and manage conversation logs in Zai.Vim.

## Overview

All Zai conversations are automatically logged to files:
- **Location:** `~/.local/share/zai/log/` (configurable)
- **Format:** Plain text with timestamps
- **Naming:** `chat_YYYYMMDD_HHMMSS.log`
- **Content:** User messages, AI responses, errors

## Opening Logs

### `:ZaiOpenLog`

Open the current session's log file.

**Usage:**
```vim
:ZaiOpenLog
```

**Mode:** Any mode

**Behavior:**
- Opens log file in new window
- File is read-only (for safety)
- Shows complete conversation history
- Displays file path in display window

**Log File Path:**
```
~/.local/share/zai/log/chat_20250130_143022.log
```

### Reading Logs

Logs contain:
```
[2025-01-30 14:30:22] Session started
[2025-01-30 14:30:25] User: How do I parse JSON in Python?
[2025-01-30 14:30:28] Assistant: Use the json module...
[2025-01-30 14:30:45] User: Can you show an example?
...
```

## Searching Logs

### `:ZaiGrepLog {pattern}`

Search for text across all log files.

**Usage:**
```vim
:ZaiGrepLog python
:ZaiGrepLog "async await"
:ZaiGrepLog error
```

**Mode:** Any mode

**Behavior:**
- Uses `grep` to search log directory
- Opens results in quickfix list
- Shows file name, line number, and matching line

**Workflow:**
```vim
" Search logs
:ZaiGrepLog json

" View results (opens quickfix)
:copen

" Navigate to match
<Enter> on result

" Close quickfix
:cclose
```

### Pattern Examples

```vim
" Search for keyword
:ZaiGrepLog function

" Search for phrase
:ZaiGrepLog "async programming"

" Regex search
:ZaiGrepLog "error.*failed"

" Case insensitive
:ZaiGrepLog "\cERROR"

" Multiple words (any)
:ZaiGrepLog "python\|json"
```

## Loading Conversation History

### `:ZaiLoad`

Load a previous log file as conversation context.

**Usage:**
```vim
:ZaiLoad
```

**Mode:** Any mode

**Behavior:**
1. Opens file picker with log files
2. Select a log file
3. Creates new session with that context
4. AI sees previous conversation

**File Picker:**
```
Select log file:
  1. chat_20250130_143022.log
  2. chat_20250129_102015.log
  3. chat_20250128_180530.log
  >
```

### Continuing Conversations

```vim
" Load previous conversation
:ZaiLoad
" Select chat_20250129_102015.log

" Continue where you left off
Can you elaborate more on the second point you made?
```

## Log File Locations

### Default Paths

| Platform | Path |
|----------|------|
| Linux | `~/.local/share/zai/log/` |
| macOS | `~/.local/share/zai/log/` |
| Windows | `%USERPROFILE%\AppData\Local\zai\log\` |

### Custom Log Directory

Set in `.vimrc`:
```vim
let g:zai_log_dir = "~/custom/path/logs"
```

Or environment variable:
```bash
export ZAI_LOG_DIR="/custom/path/logs"
```

## Log Management

### Viewing All Logs

```bash
# List all logs
ls -lh ~/.local/share/zai/log/

# View specific log
less ~/.local/share/zai/log/chat_20250130_143022.log

# Count conversations
find ~/.local/share/zai/log -name "chat_*.log" | wc -l
```

### Archiving Logs

```bash
# Archive old logs
mkdir -p ~/zai-logs/archive
mv ~/.local/share/zai/log/chat_2024*.log ~/zai-logs/archive/

# Compress archive
tar czf ~/zai-logs/archive.tar.gz ~/zai-logs/archive/
```

### Deleting Logs

```bash
# Delete specific log
rm ~/.local/share/zai/log/chat_20250130_143022.log

# Delete old logs (older than 30 days)
find ~/.local/share/zai/log -name "chat_*.log" -mtime +30 -delete

# Delete all logs (careful!)
rm ~/.local/share/zai/log/*.log
```

## Log File Format

### Structure

```
[2025-01-30 14:30:22] ===== Session started =====
[2025-01-30 14:30:22] Model: deepseek-chat
[2025-01-30 14:30:22] Log file: /home/user/.local/share/zai/log/chat_20250130_143022.log
[2025-01-30 14:30:22]
[2025-01-30 14:30:25] User: How do I parse JSON in Python?
[2025-01-30 14:30:28] Assistant: Use the `json` module...
[2025-01-30 14:30:45] User: Can you show an example?
[2025-01-30 14:30:48] Assistant: Here's an example...
```

### Sections

- **Header:** Session start time, model, log path
- **User:** Messages you sent
- **Assistant:** AI responses
- **Tool:** Tool calls and results
- **Error:** Error messages (if any)

## Viewing Logs in Browser

### `:ZaiPreview` or `<leader>dp`

Preview chat in browser as rendered Markdown.

**Usage:**
```vim
:ZaiPreview
```

**Mode:** Zai interface normal mode

**Key Mapping:** `<leader>dp` (Zai interface normal mode)

**Requirements:**
- `iamcco/markdown-preview.nvim` plugin
- Browser for viewing

## Log-Based Workflows

### Review Previous Advice

```vim
" Search for topic
:ZaiGrepLog "async python"

" Open results
:copen

" Navigate to specific log
<Enter>

" Read full conversation
```

### Compare AI Responses

```vim
" Load first log
:ZaiLoad
" Select chat_20250130_143022.log (deepseek-chat)
:iWhat did you tell me about async?<Esc>
<CR>

" Create new session and load second log
:ZaiNew
:ZaiLoad
" Select chat_20250129_102015.log (gpt-4)
:iWhat was your advice on async?<Esc>
<CR>
```

### Create Knowledge Base

```bash
# Extract useful conversations
mkdir -p ~/knowledge-base
cp ~/.local/share/zai/log/chat_*async*.log ~/knowledge-base/

# Index with grep
grep -r "async" ~/knowledge-base/
```

## Log Analysis

### Count Sessions by Date

```bash
# Count sessions per day
ls ~/.local/share/zai/log/chat_*.log | cut -d_ -f2 | cut -d. -f1 | sort | uniq -c
```

### Find Longest Conversations

```bash
# List logs by size
ls -lhS ~/.local/share/zai/log/chat_*.log
```

### Search Across All Sessions

```bash
# Find all mentions of a topic
grep -r "Docker" ~/.local/share/zai/log/
```

## Troubleshooting

### Log Not Found

**Symptom:** Log file path displayed but file doesn't exist

**Check:**
```bash
ls -la ~/.local/share/zai/log/
```

**Solution:**
- Check `g:zai_log_dir` configuration
- Ensure directory exists and is writable

### Can't Open Log

**Symptom:** `:ZaiOpenLog` shows error

**Check:**
1. Current session has log file
2. File permissions allow reading
3. Log file path is correct

### Search Returns No Results

**Symptom:** `:ZaiGrepLog` finds nothing

**Check:**
1. Pattern is correct (case sensitive)
2. Logs exist in directory
3. Use simple pattern first: `:ZaiGrepLog .`

## Privacy and Security

### Sensitive Information in Logs

Logs may contain:
- API keys (if accidentally pasted)
- Confidential code
- Private conversations

### Best Practices

1. **Review logs before sharing:**
   ```bash
   grep -i "api.*key\|password\|secret" ~/.local/share/zai/log/
   ```

2. **Redact sensitive information:**
   ```bash
   sed -i 's/sk-\.*/sk-****/g' chat_file.log
   ```

3. **Encrypt sensitive logs:**
   ```bash
   gpg --encrypt --recipient user@example.com chat_file.log
   ```

4. **Set secure permissions:**
   ```bash
   chmod 700 ~/.local/share/zai/log
   chmod 600 ~/.local/share/zai/log/*.log
   ```

## Next Steps

- [Basic Commands](basic.md) - Open and close Zai
- [Session Management](session.md) - Multiple conversations
- [Input Commands](input.md) - Add content and context
- [Configuration Guide](../configuration/) - Customize logging

## Related Topics

- [Installation Guide](../installation/) - Set up Zai.Vim
- [Configuration Guide](../configuration/basic.md) - Log directory configuration
- [Session Commands](../configuration/session-commands.md) - Disable logging

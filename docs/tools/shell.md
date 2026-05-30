# Shell Tool

## Overview

The `shell` tool provides shell command execution capabilities for Zai.Vim's AI assistant.

## Available Functions

| Function | Description |
|----------|-------------|
| `shell_execute` | Execute a shell command through the safety chain |
| `shell_allow_once` | Temporarily allow a command flagged as `ask` |
| `shell_deny_once` | Reject a command flagged as `ask` |
| `shell_abort` | Abort a running command by execution ID |
| `shell_version` | Get shell version information |
| `shell_sandbox_info` | Get aggregated safety status |
| `shell_cleanup` | Clean up persistent resources |

## Full Documentation

For comprehensive documentation covering the security architecture, safety chain (L1–L5), policy configuration, authorization flow, sandbox setup, AI classifier, dataflow detection, audit logging, and troubleshooting, see:

**[docs/shell.md](../shell.md)** — Shell Tool Security, Authorization, and Configuration

## Quick Reference

### See safety status
```
Ask AI: "show me the shell sandbox info"
```

### Configure policy rules
Edit `~/.local/share/zai/shell_policy.yaml` (user-level) or `.zaivim/project.yaml` (project-level).

### Install sandbox (recommended)
```bash
sudo apt install bubblewrap  # Debian/Ubuntu
```

## Implementation

Source Code:
- [`python3/tool_shell.py`](../../python3/tool_shell.py) — Main tool and safety chain
- [`python3/shell_policy.py`](../../python3/shell_policy.py) — Permission engine
- [`python3/shell/sandbox.py`](../../python3/shell/sandbox.py) — bwrap + seccomp sandbox
- [`python3/shell/classifier.py`](../../python3/shell/classifier.py) — AI safety classifier
- [`python3/shell/dataflow.py`](../../python3/shell/dataflow.py) — Dataflow danger detection
- [`python3/shell/audit.py`](../../python3/shell/audit.py) — Audit logging
- [`python3/bash_parser.py`](../../python3/bash_parser.py) — Shell command parser

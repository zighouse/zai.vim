# Zai.Vim Tool System

## Overview

Zai.Vim provides an extensible tool system that allows AI assistants to interact with the system through a set of well-defined tools. Tools are organized into toolsets, each focusing on a specific domain (file operations, web operations, etc.).

## Tool Architecture

### Tool Registration

Tools are defined in Python modules under `python3/tool_*.py`. Each tool module:
- Defines a class with methods that implement tool functions
- Registers itself in the global tool registry
- Provides JSON schema for tool parameters (in `tool_*.json` files)

### Tool Loading

Tools are loaded dynamically through the `:use tool {toolset}` command:
```vim
"use tool file
```

### Tool Invocation

When AI calls a tool:
1. Zai.Vim's tool manager locates the tool by function name
2. Invokes the corresponding `invoke_{function_name}()` method
3. Returns results to the AI

## Available Toolsets

### file - File Operations
Provides file reading, writing, searching, and diffing capabilities.

**Key Functions:**
- `invoke_read_file` - Read file content
- `invoke_write_file` - Write content to files
- `invoke_search_files` - Search for files by pattern
- `invoke_diff_files` - Compare two files

See [file.md](file.md) for detailed documentation.

### web - Web Operations
Provides web search, content fetching, and file downloading capabilities.

**Key Functions:**
- `invoke_web_search` - Web search using SearXNG metasearch engine
- `invoke_web_get_content` - Fetch and parse web page content
- `invoke_web_download_file` - Download files from URLs

**Features:**
- SearXNG integration for multi-engine search
- Intelligent content extraction with trafilatura
- Automatic fallback to simple search engines

See [web.md](web.md) for detailed documentation.

### shell - Shell Execution
Provides secure shell command execution in Docker containers.

**Key Functions:**
- `invoke_execute_shell` - Execute commands in isolated Docker container

**Features:**
- Docker-based isolation for security
- Auto-managed `taskbox` container
- Support for long-running processes

See [shell.md](shell.md) for detailed documentation.

### grep - File Content Search
Provides file content searching capabilities (like Unix grep).

**Key Functions:**
- `invoke_grep` - Search for patterns in files

**Features:**
- Support for regex patterns
- Recursive directory search
- Context-aware matching

See [grep.md](grep.md) for detailed documentation.

### ai - AI Capabilities
Provides AI-powered image generation capabilities.

**Key Functions:**
- `invoke_generate_image` - Generate images using AI

**Features:**
- Integration with image generation APIs
- Configurable models

See [ai.md](ai.md) for detailed documentation.

### archive - Conversation Archiving
Provides session archiving and conversation history management.

**Key Functions:**
- `invoke_archive_session` - Archive session to file

**Features:**
- Save/load conversation history
- Session preview

See [archive.md](archive.md) for detailed documentation.

### browser - Browser Automation
Provides browser automation capabilities (experimental).

**Features:**
- Open URLs in browser
- Get dynamic page content
- Take screenshots

**Note:** This tool is experimental and may have additional dependencies.

See [browser.md](browser.md) for detailed documentation.

### searxng - SearXNG Integration
Provides SearXNG metasearch engine integration for web search.

**Key Functions:**
- `invoke_web_search` - Web search with multiple engines

**Features:**
- Multi-engine support (DuckDuckGo, Google, Bing, Brave, Baidu, etc.)
- Category filtering (general, images, videos, news)
- Time range filtering
- Automatic Docker container management

See [searxng.md](searxng.md) for detailed documentation.

## Tool Development

### Creating a New Tool

To add a new tool:

1. Create `python3/tool_{name}.py`
2. Define your tool class with methods
3. Create `python3/tool_{name}.json` with parameter schemas
4. Register the tool in the tool registry

### Tool Module Template

```python
#!/usr/bin/env python3
"""
Tool description
"""
import sys
from pathlib import Path
from typing import Dict, Any

class ToolClassName:
    """Tool description"""

    def invoke_tool_function(self, param1: str, param2: int) -> str:
        """
        Tool function description

        Args:
            param1: Parameter description
            param2: Parameter description

        Returns:
            Result description
        """
        # Implementation
        return result

# Tool initialization
tool_instance = ToolClassName()
```

### Tool JSON Schema

```json
[
  {
    "type": "function",
    "function": {
      "name": "tool_function",
      "description": "Tool description",
      "parameters": {
        "type": "object",
        "properties": {
          "param1": {
            "type": "string",
            "description": "Parameter description"
          }
        },
        "required": ["param1"]
      }
    }
  }
]
```

### Best Practices

- **Error Handling**: Always use try-except blocks
- **Type Hints**: Use Python type hints for better code clarity
- **Documentation**: Provide clear docstrings for all public methods
- **Testing**: Test tools independently before integration
- **Security**: Validate user inputs and sanitize paths

## Tool Configuration

Tools can be configured through:

1. **User Configuration** (`~/.local/share/zai/assistants.yaml`)
   - API keys for external services
   - Default model settings
   - Tool-specific settings

2. **Project Configuration** (`zai.project/zai_project.yaml`)
   - Project-specific tool settings
   - Sandbox directories
   - Docker container settings

## Tool Management Commands

### Using Tools in Vim

Load a toolset:
```vim
:use tool file
```

Unload a toolset:
```vim
:AI tool remove file
```

List available tools:
```vim
:AI tool list
```

Check tool status:
```vim
:AI tool status
```

### Tool Troubleshooting

**Tool not found:**
- Ensure tool module exists in `python3/tool_*.py`
- Check tool is registered in tool registry
- Verify tool is loaded with `:AI tool status`

**Tool execution failed:**
- Check configuration (API keys, credentials)
- Verify dependencies are installed
- Check sandbox permissions
- Review error messages in chat buffer

## Related Documentation

- [Configuration Guide](../configuration/)
- [Command Reference](../commands/)
- [Development Guide](development.md)

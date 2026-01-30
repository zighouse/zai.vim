# Searxng Tool

## Overview

The `searxng` toolset provides searxng capabilities for Zai.Vim's AI assistant.

## Available Functions

### web search

```python
invoke_web_search(request, engine, category, time_range, max_results, return_format)
```

Execute web search using SearXNG

    Args:
        request: Search query
        engine: Specific search engine to use (empty for auto selection)
        category: Search category (e.g., 'general', 'images', 'videos', 'news')
        time_range: Time range filter ('day', 'week', 'month', 'year')
        language: Language code (e.g., 'en', 'zh', 'auto')
        safesearch: Safe search level (0=off, 1=moderate, 2=strict)
        max_results: Maximum number of results to return
        return_format: Output format ('markdown', 'links', 'html', 'json')

    Returns:
        Formatted search results



## Implementation Details

Source Code: [`python3/tool_searxng.py`](../../python3/tool_searxng.py)

## Configuration

The `searxng` tool can be configured through:

- **User Config**: `~/.local/share/zai/assistants.yaml`
- **Project Config**: `zai.project/zai_project.yaml`

## Usage Examples

Load the tool:
```vim
:use tool searxng
```

Use in AI chat:
```
# AI will call the appropriate function
```

## Troubleshooting

**Tool not available:**
- Verify tool is loaded: `:AI tool status`
- Check if tool module exists: `ls python3/tool_searxng.py`
- Install any missing dependencies

**Execution errors:**
- Check configuration files
- Verify permissions (especially for file and shell tools)
- Review error messages in AI chat buffer

## Related Documentation

- [Tool System Overview](README.md)
- [Configuration Guide](../configuration/)

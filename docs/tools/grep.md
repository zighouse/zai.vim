# Grep Tool

## Overview

The `grep` toolset provides grep capabilities for Zai.Vim's AI assistant.

## Available Functions

### grep

```python
invoke_grep(pattern, path, recursive, case_sensitive, use_regex, max_results, include_pattern, exclude_pattern, show_line_numbers, context_lines)
```

在文件中搜索文本模式，返回格式化的搜索结果
    
    注意：
    1. 搜索范围限制在沙盒主目录内以确保安全
    2. 输出路径始终相对于沙盒根目录，便于其他工具（如read_file）使用



## Implementation Details

Source Code: [`python3/tool_grep.py`](../../python3/tool_grep.py)

## Configuration

The `grep` tool can be configured through:

- **User Config**: `~/.local/share/zai/assistants.yaml`
- **Project Config**: `zai.project/zai_project.yaml`

## Usage Examples

Load the tool:
```vim
:use tool grep
```

Use in AI chat:
```
# AI will call the appropriate function
```

## Troubleshooting

**Tool not available:**
- Verify tool is loaded: `:AI tool status`
- Check if tool module exists: `ls python3/tool_grep.py`
- Install any missing dependencies

**Execution errors:**
- Check configuration files
- Verify permissions (especially for file and shell tools)
- Review error messages in AI chat buffer

## Related Documentation

- [Tool System Overview](README.md)
- [Configuration Guide](../configuration/)

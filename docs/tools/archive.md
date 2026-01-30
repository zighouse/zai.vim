# Archive Tool

## Overview

The `archive` toolset provides archive capabilities for Zai.Vim's AI assistant.

## Available Functions

### fetch archive

```python
invoke_fetch_archive(archive_file, page_type, page_size, page_number)
```

读取归档文件，支持分页

    参数:
        archive_file: 归档文件名
        page_type: 分页类型，'line' 按行数分页，'length' 按字符长度分页
        page_size: 每页大小（行数或字符数）
        page_number: 页码（从1开始）

    返回:
        归档文件内容（分页或全部）



## Implementation Details

Source Code: [`python3/tool_archive.py`](../../python3/tool_archive.py)

## Configuration

The `archive` tool can be configured through:

- **User Config**: `~/.local/share/zai/assistants.yaml`
- **Project Config**: `zai.project/zai_project.yaml`

## Usage Examples

Load the tool:
```vim
:use tool archive
```

Use in AI chat:
```
# AI will call the appropriate function
```

## Troubleshooting

**Tool not available:**
- Verify tool is loaded: `:AI tool status`
- Check if tool module exists: `ls python3/tool_archive.py`
- Install any missing dependencies

**Execution errors:**
- Check configuration files
- Verify permissions (especially for file and shell tools)
- Review error messages in AI chat buffer

## Related Documentation

- [Tool System Overview](README.md)
- [Configuration Guide](../configuration/)

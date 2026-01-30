# File Tool

## Overview

The `file` toolset provides file capabilities for Zai.Vim's AI assistant.

## Available Functions

### copy file

```python
invoke_copy_file(source, destination)
```

复制沙盒内的文件或目录到指定路径，支持合并多个文件
    Args:
        source: 单个源文件/目录路径，或多个源文件路径列表
        destination: 目标路径
    Returns:
        str: 操作结果信息字符串


### descript file

```python
invoke_descript_file(path)
```

描述文件类型和格式，使用 file 命令或 Python 内置方法
    Args:
        path: 文件路径
    Returns:
        str: 文件描述信息


### diff file

```python
invoke_diff_file(file1, file2, output_format, context_lines)
```

比较两个文件的差异，生成类似 Linux diff 命令的差异输出

    Args:
        file1: 第一个文件路径
        file2: 第二个文件路径
        output_format: 差异输出格式：unified（统一格式，默认）、context（上下文格式）、normal（普通格式）
        context_lines: 上下文行数（仅对 unified 和 context 格式有效），默认为 3

    Returns:
        str: 差异输出结果


### ls

```python
invoke_ls(path)
```

列出沙盒内指定目录的内容，返回格式化的字符串


### mkdir

```python
invoke_mkdir(path)
```

在沙盒内创建目录


### patch file

```python
invoke_patch_file(file_path, patch_content, backup, reverse)
```

将差异补丁应用到文件，类似于 Linux patch 命令的功能

    Args:
        file_path: 要应用补丁的文件路径
        patch_content: 补丁内容，可以是 unified diff 格式或其他支持的格式
        backup: 是否在应用补丁前创建备份文件，默认为 true
        reverse: 是否反向应用补丁（撤销补丁），默认为 false

    Returns:
        str: 补丁应用结果


### read file

```python
invoke_read_file(path)
```

读取沙盒内的文件内容


### search in file

```python
invoke_search_in_file(path, pattern, use_regex, case_sensitive, max_results, context_lines)
```

在文件中搜索指定的文本或模式

    Args:
        path: 文件路径
        pattern: 要搜索的文本或正则表达式模式
        use_regex: 是否使用正则表达式进行搜索，默认为 false（字符串匹配）
        case_sensitive: 是否区分大小写，默认为 true
        max_results: 最大返回结果数，0 表示返回所有结果，默认为 0
        context_lines: 返回匹配项的上下文行数，默认为 2

    Returns:
        str: 搜索结果信息字符串


### substitute file

```python
invoke_substitute_file(path, old_text, new_text, use_regex, count)
```

对文本文件的局部内容进行替换

    Args:
        path: 文件路径
        old_text: 要替换的旧文本或正则表达式模式
        new_text: 替换后的新文本
        use_regex: 是否使用正则表达式进行匹配，默认为 false（字符串匹配）
        count: 替换次数，0 表示替换所有匹配项，默认为 0

    Returns:
        str: 操作结果信息字符串


### write file

```python
invoke_write_file(path, content, mode)
```

向沙盒内的文件写入内容



## Implementation Details

Source Code: [`python3/tool_file.py`](../../python3/tool_file.py)

## Configuration

The `file` tool can be configured through:

- **User Config**: `~/.local/share/zai/assistants.yaml`
- **Project Config**: `zai.project/zai_project.yaml`

## Usage Examples

Load the tool:
```vim
:use tool file
```

Use in AI chat:
```
# AI will call the appropriate function
```

## Troubleshooting

**Tool not available:**
- Verify tool is loaded: `:AI tool status`
- Check if tool module exists: `ls python3/tool_file.py`
- Install any missing dependencies

**Execution errors:**
- Check configuration files
- Verify permissions (especially for file and shell tools)
- Review error messages in AI chat buffer

## Related Documentation

- [Tool System Overview](README.md)
- [Configuration Guide](../configuration/)

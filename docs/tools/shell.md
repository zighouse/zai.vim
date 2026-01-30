# Shell Tool

## Overview

The `shell` toolset provides shell capabilities for Zai.Vim's AI assistant.

## Available Functions

### execute shell

```python
invoke_execute_shell(command, timeout, working_dir, enable_network, language, libraries, persistent)
```

在taskbox容器中执行shell命令
    
    Args:
        command: 要执行的shell命令
        timeout: 超时时间（秒）
        working_dir: 工作目录（容器内路径）
        enable_network: 是否启用网络访问
        language: 语言环境
        libraries: 需要安装的库列表
        persistent: 是否使用持久化容器（跨调用保持状态）
        
    Returns:
        执行结果字典


### shell cleanup

```python
invoke_shell_cleanup()
```

清理持久化容器（如果存在）


### shell sandbox info

```python
invoke_shell_sandbox_info()
```

获取沙盒环境信息



## Implementation Details

Source Code: [`python3/tool_shell.py`](../../python3/tool_shell.py)

## Configuration

The `shell` tool can be configured through:

- **User Config**: `~/.local/share/zai/assistants.yaml`
- **Project Config**: `zai.project/zai_project.yaml`

## Usage Examples

Load the tool:
```vim
:use tool shell
```

Use in AI chat:
```
# AI will call the appropriate function
```

## Troubleshooting

**Tool not available:**
- Verify tool is loaded: `:AI tool status`
- Check if tool module exists: `ls python3/tool_shell.py`
- Install any missing dependencies

**Execution errors:**
- Check configuration files
- Verify permissions (especially for file and shell tools)
- Review error messages in AI chat buffer

## Related Documentation

- [Tool System Overview](README.md)
- [Configuration Guide](../configuration/)

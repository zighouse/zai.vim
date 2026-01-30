# Ai Tool

## Overview

The `ai` toolset provides ai capabilities for Zai.Vim's AI assistant.

## Available Functions

### generate image

```python
invoke_generate_image(prompt, base_url, model, api_key_name, output_path, output_dir, size, quality, n, timeout)
```

使用AI生成图片

    Args:
        prompt: 图片生成提示词
        output_path: 输出图片文件路径
        output_dir: 输出目录（如果output_path未指定，则在此目录下生成图片）
        size: 图片尺寸，如 "1024x1024", "512x512"
        quality: 图片质量，如 "standard", "hd"
        n: 生成图片数量
        timeout: 请求超时时间（秒）

    Returns:
        Dict: 包含生成结果的信息



## Implementation Details

Source Code: [`python3/tool_ai.py`](../../python3/tool_ai.py)

## Configuration

The `ai` tool can be configured through:

- **User Config**: `~/.local/share/zai/assistants.yaml`
- **Project Config**: `zai.project/zai_project.yaml`

## Usage Examples

Load the tool:
```vim
:use tool ai
```

Use in AI chat:
```
# AI will call the appropriate function
```

## Troubleshooting

**Tool not available:**
- Verify tool is loaded: `:AI tool status`
- Check if tool module exists: `ls python3/tool_ai.py`
- Install any missing dependencies

**Execution errors:**
- Check configuration files
- Verify permissions (especially for file and shell tools)
- Review error messages in AI chat buffer

## Related Documentation

- [Tool System Overview](README.md)
- [Configuration Guide](../configuration/)

# Browser Tool

## Overview

The `browser` toolset provides browser capabilities for Zai.Vim's AI assistant.

## Available Functions

### get page content

```python
invoke_get_page_content(url, wait_time, extract_text, browser)
```

使用浏览器获取网页内容，包括动态加载的内容
    
    Args:
        url: 要获取内容的URL地址
        wait_time: 等待页面加载完成的时间（秒）
        extract_text: 是否提取纯文本内容
        browser: 浏览器类型
        
    Returns:
        str: 网页内容或错误信息


### open browser

```python
invoke_open_browser(url, browser, headless, timeout)
```

打开浏览器并访问指定URL
    
    Args:
        url: 要访问的URL地址
        browser: 浏览器类型，'firefox' 或 'chrome'，默认自动选择
        headless: 是否使用无头模式（不显示浏览器界面）
        timeout: 页面加载超时时间（秒）
        
    Returns:
        str: 操作结果信息


### screenshot

```python
invoke_screenshot(url, output_path, browser, full_page)
```

对网页进行截图
    
    Args:
        url: 要截图的URL地址
        output_path: 截图保存路径
        browser: 浏览器类型
        full_page: 是否截取完整页面
        
    Returns:
        str: 操作结果信息



## Implementation Details

Source Code: [`python3/tool_browser.py`](../../python3/tool_browser.py)

## Configuration

The `browser` tool can be configured through:

- **User Config**: `~/.local/share/zai/assistants.yaml`
- **Project Config**: `zai.project/zai_project.yaml`

## Usage Examples

Load the tool:
```vim
:use tool browser
```

Use in AI chat:
```
# AI will call the appropriate function
```

## Troubleshooting

**Tool not available:**
- Verify tool is loaded: `:AI tool status`
- Check if tool module exists: `ls python3/tool_browser.py`
- Install any missing dependencies

**Execution errors:**
- Check configuration files
- Verify permissions (especially for file and shell tools)
- Review error messages in AI chat buffer

## Related Documentation

- [Tool System Overview](README.md)
- [Configuration Guide](../configuration/)

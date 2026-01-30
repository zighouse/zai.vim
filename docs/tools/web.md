# Web Tool

## Overview

The `web` toolset provides web capabilities for Zai.Vim's AI assistant.

## Available Functions

### web download file

```python
invoke_web_download_file(url, output_path, output_dir, filename, timeout)
```

从URL下载文件

    Args:
        url: 要下载文件的URL地址
        output_path: 完整的输出文件路径（包含文件名）
        output_dir: 输出目录（如果output_path未指定，则在此目录下生成文件）
        filename: 文件名（如果output_path未指定，则使用此文件名）
        timeout: 下载超时时间（秒）

    Returns:
        Dict: 包含下载结果的信息


### web get content

```python
invoke_web_get_content(url, return_format)
```

获取指定URL的网页内容，优先使用智能提取（trafilatura），失败时回退到 elinks 或 html2text

    Args:
        url: 要获取内容的URL地址
        return_format: 返回内容的格式，'clean_text' 或 'markdown' 或 'html' 或 'links'

    Returns:
        str: 清理后的文本、网页内容或者链接列表的字符串表示


### web parse links

```python
invoke_web_parse_links(content, base_url)
```

解析HTML内容中的URL链接，并可选地将相对链接补全为绝对链接

    Args:
        content: 要解析的HTML内容
        base_url: 基准URL，用于补全相对链接。如果为None，则返回原始链接

    Returns:
        List[Dict]: 包含URL和可选标题的链接列表


### web search

```python
invoke_web_search(request, engine, category, time_range, max_results, return_format)
```

执行网络搜索（使用 SearXNG，失败时回退到旧实现）

    Args:
        request: 搜索关键词或查询内容
        engine: 指定搜索引擎（留空则自动选择）。可选值包括: 'bing', 'duckduckgo', 'google', 'brave', 'startpage', 'yandex', 'baidu', 'qwant' 等（取决于SearXNG配置）
        category: 搜索类别。可选值: 'general' (常规), 'images' (图片), 'videos' (视频), 'news' (新闻), 'map' (地图), 'music' (音乐), 'it' (IT), 'science' (科学) 等（取决于SearXNG配置）
        time_range: 时间范围过滤 ('day', 'week', 'month', 'year')
        max_results: 最大返回结果数量
        return_format: 返回格式: 'markdown' (默认), 'links' (仅链接), 'json' (原始JSON), 'html' (HTML格式)

    Returns:
        str: 搜索结果



## Implementation Details

Source Code: [`python3/tool_web.py`](../../python3/tool_web.py)

## Configuration

The `web` tool can be configured through:

- **User Config**: `~/.local/share/zai/assistants.yaml`
- **Project Config**: `zai.project/zai_project.yaml`

## Usage Examples

Load the tool:
```vim
:use tool web
```

Use in AI chat:
```
# AI will call the appropriate function
```

## Troubleshooting

**Tool not available:**
- Verify tool is loaded: `:AI tool status`
- Check if tool module exists: `ls python3/tool_web.py`
- Install any missing dependencies

**Execution errors:**
- Check configuration files
- Verify permissions (especially for file and shell tools)
- Review error messages in AI chat buffer

## Related Documentation

- [Tool System Overview](README.md)
- [Configuration Guide](../configuration/)

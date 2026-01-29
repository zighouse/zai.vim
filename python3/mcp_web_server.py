#!/usr/bin/env python3
"""
MCP Server for web search and content fetching
将 tool_web.py 包装成 MCP 服务器
"""
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

# 添加工具目录到 Python 路径
TOOL_DIR = Path(__file__).parent
sys.path.insert(0, str(TOOL_DIR))

try:
    from mcp.server.models import InitializationOptions
    from mcp.server import NotificationOptions, Server
    from mcp.server.stdio import stdio_server
    from mcp.types import (
        Resource,
        Tool,
        TextContent,
        ImageContent,
        EmbeddedResource,
    )
except ImportError:
    print("Error: mcp package not installed. Install with: pip install mcp", file=sys.stderr)
    sys.exit(1)

# 导入你的 web 工具函数
from tool_searxng import invoke_web_search
from tool_web import invoke_web_get_content, invoke_web_download_file

# 创建 MCP 服务器实例
server = Server("web-search-server")

@server.list_resources()
async def handle_list_resources() -> list[Resource]:
    """列出可用的资源"""
    return []

@server.list_tools()
async def handle_list_tools() -> list[Tool]:
    """列出可用的工具"""
    return [
        Tool(
            name="web_search",
            description="执行网络搜索，基于 SearXNG 元搜索引擎，支持 DuckDuckGo、Google、Bing、Brave 等多个搜索引擎",
            inputSchema={
                "type": "object",
                "properties": {
                    "request": {
                        "type": "string",
                        "description": "搜索关键词或查询内容"
                    },
                    "engine": {
                        "type": "string",
                        "description": "搜索引擎名称（留空或 auto 为自动选择）：duckduckgo, google, bing, brave, baidu, yandex, qwant, startpage",
                        "default": ""
                    },
                    "category": {
                        "type": "string",
                        "description": "搜索分类：general, images, videos, news 等",
                        "default": ""
                    },
                    "time_range": {
                        "type": "string",
                        "description": "时间范围过滤：day, week, month, year",
                        "default": ""
                    },
                    "language": {
                        "type": "string",
                        "description": "语言代码（如：en, zh, auto）",
                        "default": "auto"
                    },
                    "safesearch": {
                        "type": "integer",
                        "description": "安全搜索级别：0=关闭, 1=适中, 2=严格",
                        "default": 0
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "最大返回结果数量",
                        "default": 10
                    },
                    "return_format": {
                        "type": "string",
                        "description": "返回格式：markdown, html, links, json",
                        "enum": ["markdown", "html", "links", "json"],
                        "default": "markdown"
                    }
                },
                "required": ["request"]
            }
        ),
        Tool(
            name="web_get_content",
            description="获取指定URL的网页内容",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "要获取内容的URL地址"
                    },
                    "return_format": {
                        "type": "string",
                        "description": "返回格式：clean_text, markdown, html, links",
                        "enum": ["clean_text", "markdown", "html", "links"],
                        "default": "clean_text"
                    }
                },
                "required": ["url"]
            }
        ),
        Tool(
            name="web_download_file",
            description="从URL下载文件（用于下载图片、压缩包等LLM不便直接处理的内容）",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "要下载文件的URL地址"
                    },
                    "output_path": {
                        "type": "string",
                        "description": "完整的输出文件路径（包含文件名），如果未指定则自动生成"
                    },
                    "output_dir": {
                        "type": "string",
                        "description": "输出目录，如果未指定则使用默认下载目录"
                    },
                    "filename": {
                        "type": "string",
                        "description": "文件名，如果未指定则从URL中提取或使用时间戳"
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "下载超时时间（秒），默认60秒",
                        "default": 60
                    }
                },
                "required": ["url"]
            }
        )
    ]

@server.call_tool()
async def handle_call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent | ImageContent | EmbeddedResource]:
    """处理工具调用"""
    try:
        if name == "web_search":
            request = arguments.get("request", "")
            engine = arguments.get("engine", "")
            category = arguments.get("category", "")
            time_range = arguments.get("time_range", "")
            language = arguments.get("language", "auto")
            safesearch = arguments.get("safesearch", 0)
            max_results = arguments.get("max_results", 10)
            return_format = arguments.get("return_format", "markdown")

            if not request:
                return [TextContent(type="text", text="错误：缺少必需参数 'request'")]

            result = invoke_web_search(
                request=request,
                engine=engine,
                category=category,
                time_range=time_range,
                language=language,
                safesearch=safesearch,
                max_results=max_results,
                return_format=return_format
            )
            return [TextContent(type="text", text=result)]

        elif name == "web_get_content":
            url = arguments.get("url", "")
            return_format = arguments.get("return_format", "clean_text")

            if not url:
                return [TextContent(type="text", text="错误：缺少必需参数 'url'")]

            result = invoke_web_get_content(url=url, return_format=return_format)
            return [TextContent(type="text", text=result)]

        elif name == "web_download_file":
            url = arguments.get("url", "")
            output_path = arguments.get("output_path")
            output_dir = arguments.get("output_dir")
            filename = arguments.get("filename")
            timeout = arguments.get("timeout", 60)

            if not url:
                return [TextContent(type="text", text="错误：缺少必需参数 'url'")]

            result = invoke_web_download_file(
                url=url,
                output_path=output_path,
                output_dir=output_dir,
                filename=filename,
                timeout=timeout
            )
            return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

        else:
            return [TextContent(type="text", text=f"未知工具: {name}")]

    except Exception as e:
        return [TextContent(type="text", text=f"工具执行错误: {str(e)}")]

async def main():
    """主函数"""
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="web-search-server",
                server_version="1.0.0",
                capabilities=server.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={}
                )
            )
        )

if __name__ == "__main__":
    asyncio.run(main())

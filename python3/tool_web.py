#!/usr/bin/env python3
import requests
import re
from urllib.parse import urljoin, urlparse
from typing import List, Dict, Optional, Literal
import time

def get_content(url: str, return_format: str = "html") -> str:
    """
    获取指定URL的网页内容
    
    Args:
        url: 要获取内容的URL地址
        return_format: 返回内容的格式，'html' 或 'links'
        
    Returns:
        str: 网页内容或链接列表的字符串表示
    """
    try:
        # 添加基本的请求头，模拟浏览器访问
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()  # 如果状态码不是200，抛出异常
        
        content = response.text
        
        if return_format == "links":
            links = parse_links(content)
            if links:
                result = []
                for link in links:
                    caption = link.get('caption', 'No caption')
                    result.append(f"{caption}: {link['url']}")
                return "\n".join(result)
            else:
                return "No links found in the content"
        else:
            return content
        
    except requests.exceptions.RequestException as e:
        return f"Error fetching content from {url}: {str(e)}"
    except Exception as e:
        return f"Unexpected error: {str(e)}"

def search(request: str, base_url: str = "https://html.duckduckgo.com/html/", max_results: int = 10, return_format: str = "html") -> str:
    """
    执行网络搜索
    
    Args:
        request: 搜索关键词或查询内容
        base_url: 搜索引擎的基础URL（默认为DuckDuckGo）
        max_results: 最大返回结果数量
        return_format: 返回内容的格式，'html' 或 'links'
        
    Returns:
        str: 搜索结果或错误消息
    """
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        }
        
        # DuckDuckGo 搜索参数
        if "duckduckgo.com" in base_url:
            params = {
                'q': request,
                'kl': 'us-en'
            }
            response = requests.post(base_url, data=params, headers=headers, timeout=15)
        else:
            # 其他搜索引擎（简单GET请求）
            params = {'q': request}
            response = requests.get(base_url, params=params, headers=headers, timeout=15)
        
        response.raise_for_status()
        
        content = response.text
        
        if return_format == "links":
            # 直接返回解析后的链接
            links = parse_links(content)
            
            # 过滤和格式化结果
            results = []
            for link in links[:max_results]:
                if link.get('url') and not link['url'].startswith('javascript:'):
                    caption = link.get('caption', 'No caption')
                    results.append(f"{caption}: {link['url']}")
            
            if results:
                return f"Search results for '{request}':\n" + "\n".join(results)
            else:
                return f"No search results found for '{request}'"
        else:
            # 返回原始HTML内容
            return content
            
    except requests.exceptions.RequestException as e:
        return f"Search error: {str(e)}"
    except Exception as e:
        return f"Unexpected search error: {str(e)}"

def parse_links(content: str) -> List[Dict[str, str]]:
    """
    解析HTML内容中的URL链接
    
    Args:
        content: 要解析的HTML内容
        
    Returns:
        List[Dict]: 包含URL和可选标题的链接列表
    """
    links = []
    
    try:
        # 使用正则表达式匹配 <a> 标签
        # 匹配模式：<a href="URL"[^>]*>CAPTION</a>
        pattern = r'<a\s+[^>]*href=["\']([^"\']*)["\'][^>]*>([^<]*)</a>'
        matches = re.findall(pattern, content, re.IGNORECASE)
        
        for url, caption in matches:
            # 清理标题文本
            caption = re.sub(r'\s+', ' ', caption.strip())
            
            # 过滤掉空链接和常见的不需要的链接
            if url and not url.startswith('#') and len(caption) > 0:
                links.append({
                    'url': url,
                    'caption': caption
                })
        
        # 如果没有找到链接，尝试更宽松的匹配
        if not links:
            # 匹配所有 href 属性
            href_pattern = r'href=["\']([^"\'\s>]*)["\']'
            href_matches = re.findall(href_pattern, content, re.IGNORECASE)
            
            for url in href_matches:
                if url and not url.startswith('#') and not url.startswith('javascript:'):
                    links.append({
                        'url': url,
                        'caption': 'Link'
                    })
    
    except Exception as e:
        # 如果解析出错，返回空列表
        print(f"Link parsing error: {e}")
    
    return links

# 测试代码（如果直接运行）
if __name__ == "__main__":
    # 测试 get_content
    print("Testing get_content with html format...")
    content = get_content("https://httpbin.org/html")
    print(f"Content length: {len(content)}")
    
    print("\nTesting get_content with links format...")
    links_content = get_content("https://httpbin.org/html", return_format="links")
    print(f"Links found:\n{links_content}")
    
    # 测试 parse_links
    print("\nTesting parse_links...")
    test_html = '''
    <html>
    <body>
    <a href="https://example.com">Example</a>
    <a href="/relative">Relative Link</a>
    <a href="#section">Section</a>
    </body>
    </html>
    '''
    links = parse_links(test_html)
    for link in links:
        print(f"Link: {link}")
    
    # 测试 search
    print("\nTesting search with links format...")
    results = search("python programming", max_results=3, return_format="links")
    print(results)
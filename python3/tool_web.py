#!/usr/bin/env python3
import requests
import re
import subprocess
import shutil
import time
from urllib.parse import urljoin, urlparse
from typing import List, Dict, Optional, Literal, Any
from pathlib import Path

from toolcommon import sanitize_path

def get_content(url: str, return_format: str = "clean_text") -> str:
    """
    获取指定URL的网页内容，优先使用elinks导出干净的文本内容

    Args:
        url: 要获取内容的URL地址
        return_format: 返回内容的格式，'clean_text' 或 'html' 或 'links'

    Returns:
        str: 清理后的文本、网页内容或者链接列表的字符串表示
    """
    try:
        # 如果请求clean_text且elinks可用，优先使用elinks
        if return_format == "clean_text" and is_elinks_available():
            return get_content_with_elinks(url)

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
        elif return_format == "clean_text":
            # 返回清理后的纯文本内容
            return extract_clean_text(content)
        else:
            # 返回清理后的HTML内容
            return clean_html_content(content)

    except requests.exceptions.RequestException as e:
        return f"Error fetching content from {url}: {str(e)}"
    except Exception as e:
        return f"Unexpected error: {str(e)}"

def is_elinks_available() -> bool:
    """
    检查系统是否安装了elinks程序
    """
    return shutil.which("elinks") is not None

def get_content_with_elinks(url: str) -> str:
    """
    使用elinks程序获取网页的纯文本内容
    """
    try:
        # 使用elinks以dump模式获取纯文本内容
        # -dump 1: 输出格式化文本后退出
        # -dump-width 120: 输出行按 120 字符换行
        # -no-references: 不显示链接引用编号
        # -no-numbering: 不显示行号
        result = subprocess.run(
            ["elinks", "-dump", "1", "-dump-width", "120", "-no-references", "-no-numbering", url],
            capture_output=True,
            text=True,
            timeout=15,
            check=True
        )

        if result.returncode == 0:
            content = result.stdout.strip()
            # 进一步清理elinks输出的多余空行
            lines = [line.strip() for line in content.split('\n') if line.strip()]
            return '\n'.join(lines)
        else:
            # 如果elinks失败，回退到常规方法
            return get_content_fallback(url)

    except subprocess.TimeoutExpired:
        return f"Error: elinks timeout when fetching {url}"
    except subprocess.CalledProcessError as e:
        return f"Error: elinks failed with return code {e.returncode}"
    except Exception as e:
        return f"Error using elinks: {str(e)}"

def get_content_fallback(url: str) -> str:
    """
    elinks失败时的回退方案
    """
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        return extract_clean_text(response.text)
    except Exception as e:
        return f"Fallback also failed: {str(e)}"

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

def clean_html_content(html_content: str) -> str:
    """
    清理HTML内容，移除script、style等标签，保留主要内容
    """
    try:
        from bs4 import BeautifulSoup, Comment

        soup = BeautifulSoup(html_content, 'html.parser')

        # 移除script标签
        for script in soup.find_all('script'):
            script.decompose()

        # 移除style标签
        for style in soup.find_all('style'):
            style.decompose()

        # 移除注释
        for comment in soup.find_all(string=lambda text: isinstance(text, Comment)):
            comment.extract()

        # 移除meta、link等元数据标签
        for meta in soup.find_all('meta'):
            meta.decompose()
        for link in soup.find_all('link'):
            link.decompose()

        # 移除noscript标签
        for noscript in soup.find_all('noscript'):
            noscript.decompose()

        # 返回清理后的HTML
        return str(soup)

    except ImportError:
        # 如果没有安装BeautifulSoup，使用简单的正则方法
        import re
        # 移除script标签
        html_content = re.sub(r'<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>', '', html_content, flags=re.IGNORECASE)
        # 移除style标签
        html_content = re.sub(r'<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>', '', html_content, flags=re.IGNORECASE)
        # 移除注释
        html_content = re.sub(r'<!--.*?-->', '', html_content, flags=re.DOTALL)
        return html_content

def extract_clean_text(html_content: str) -> str:
    """
    从HTML中提取干净的文本内容
    """
    try:
        from bs4 import BeautifulSoup, Comment

        soup = BeautifulSoup(html_content, 'html.parser')

        # 移除不需要的标签
        for element in soup(['script', 'style', 'meta', 'link', 'noscript']):
            element.decompose()

        # 移除注释
        for comment in soup.find_all(string=lambda text: isinstance(text, Comment)):
            comment.extract()

        # 获取文本并清理空白字符
        text = soup.get_text()

        # 清理多余的空白字符
        lines = (line.strip() for line in text.splitlines())
        chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
        text = ' '.join(chunk for chunk in chunks if chunk)

        return text

    except ImportError:
        # 如果没有BeautifulSoup，返回清理后的HTML
        clean_html = clean_html_content(html_content)
        # 简单的文本提取
        import re
        text = re.sub(r'<[^>]+>', ' ', clean_html)  # 移除所有标签
        text = re.sub(r'\s+', ' ', text)  # 合并多个空白字符
        return text.strip()

def download_file(
    url: str,
    output_path: Optional[str] = None,
    output_dir: Optional[str] = None,
    filename: Optional[str] = None,
    timeout: int = 60
) -> Dict[str, Any]:
    """
    从URL下载文件

    Args:
        url: 要下载文件的URL地址
        output_path: 完整的输出文件路径（包含文件名）
        output_dir: 输出目录（如果output_path未指定，则在此目录下生成文件）
        filename: 文件名（如果output_path未指定，则使用此文件名）
        timeout: 下载超时时间（秒）

    Returns:
        Dict: 包含下载结果的信息
    """
    try:
        file_path = _get_download_output_path(url, output_path, output_dir, filename)
        file_path.parent.mkdir(parents=True, exist_ok=True)
        downloaded_path = download_file_robust(url, file_path, timeout)

        if downloaded_path:
            return {
                "success": True,
                "message": f"文件下载成功",
                "file_path": str(downloaded_path),
                "url": url,
                "file_size": downloaded_path.stat().st_size if downloaded_path.exists() else 0
            }
        else:
            return {
                "success": False,
                "error": f"所有下载方法都失败了: {url}",
                "url": url
            }

    except Exception as e:
        return {
            "success": False,
            "error": f"下载文件时发生错误: {str(e)}",
            "url": url
        }


def download_file_robust(
    url: str,
    output_path: Path,
    timeout: int,
    headers: Dict[str, str] = {}
) -> Optional[Path]:
    file_path = _download_with_requests(url, output_path, timeout)
    if file_path:
        return file_path

    file_path = _download_with_wget(url, output_path, timeout)
    if file_path:
        return file_path

    file_path = _download_with_curl(url, output_path, timeout)
    if file_path:
        return file_path

    print(f"所有下载方法都失败了: {url}")
    return None


def _download_with_requests(
    url: str,
    output_path: Path,
    timeout: int,
    headers: Dict[str, str] = {}
) -> Optional[Path]:
    try:
        # 尝试不同的请求头组合
        headers_combinations = [
            {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            },
            {
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                "Accept": "*/*",
                "Accept-Language": "en-US,en;q=0.9"
            },
            {}  # 空请求头
        ]
        if headers:
            headers_combinations.insert(0, headers)

        for headers_try in headers_combinations:
            try:
                response = requests.get(url, headers=headers_try, timeout=timeout, stream=True)
                response.raise_for_status()

                with open(output_path, "wb") as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)

                print(f"使用requests下载成功: {output_path}")
                return output_path

            except requests.exceptions.HTTPError as e:
                if e.response.status_code == 403:
                    continue  # 尝试下一个请求头组合
                else:
                    raise

        return None

    except Exception as e:
        print(f"requests下载失败: {str(e)}")
        return None


def _download_with_wget(
    url: str,
    output_path: Path,
    timeout: int
) -> Optional[Path]:
    if not shutil.which("wget"):
        return None

    try:
        cmd = [
            "wget",
            "-O", str(output_path),
            "-T", str(timeout),  # 超时时间
            url
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)

        if result.returncode == 0:
            print(f"使用wget下载成功: {output_path}")
            return output_path
        else:
            print(f"wget下载失败: {result.stderr}")
            return None

    except Exception as e:
        print(f"wget下载失败: {str(e)}")
        return None


def _download_with_curl(
    url: str,
    output_path: Path,
    timeout: int
) -> Optional[Path]:
    if not shutil.which("curl"):
        return None

    try:
        cmd = [
            "curl",
            "-L",  # 跟随重定向
            "-o", str(output_path),
            "--connect-timeout", str(timeout),
            "--max-time", str(timeout),
            url
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)

        if result.returncode == 0:
            print(f"使用curl下载成功: {output_path}")
            return output_path
        else:
            print(f"curl下载失败: {result.stderr}")
            return None

    except Exception as e:
        print(f"curl下载失败: {str(e)}")
        return None


def _get_download_output_path(
    url: str,
    output_path: Optional[str],
    output_dir: Optional[str],
    filename: Optional[str]
) -> Path:
    """获取下载文件的输出路径"""
    if output_path:
        return sanitize_path(output_path)

    # 确定输出目录
    if output_dir:
        output_dir_path = sanitize_path(output_dir)
    else:
        output_dir_path = sanitize_path() / "downloads"

    # 确定文件名
    if filename:
        file_name = filename
    else:
        # 从URL中提取文件名，或使用时间戳
        parsed_url = urlparse(url)
        url_filename = Path(parsed_url.path).name
        if url_filename and url_filename != "/":
            file_name = url_filename
        else:
            timestamp = int(time.time())
            file_name = f"downloaded_file_{timestamp}"

    return output_dir_path / file_name


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

    # 测试 download_file
    print("\nTesting download_file...")
    result = download_file("https://httpbin.org/image/jpeg", filename="test_image.jpg")
    print(f"Download result: {result}")

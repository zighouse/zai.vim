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

def _remove_data_images(markdown_text):
    pattern = r'!\[[^\]]*\]\(data:image[^)]+\)'
    cleaned_text = re.sub(pattern, '', markdown_text)
    return cleaned_text

def _remove_metas(text):
    lines = text.split('\n')
    cleaned_lines = []
    in_metadata_block = False

    for line in lines:
        # 检测metadata行的开始
        if re.match(r'^(meta-|title:|source_repo=|analytics-)', line.lower()):
            in_metadata_block = True
            continue

        # 检测base64编码的内容行
        if re.match(r'^[A-Za-z0-9+/]{20,}={0,2}$', line.strip()):
            in_metadata_block = True
            continue

        # 检测分隔符
        if line.strip() == '---':
            if in_metadata_block:
                in_metadata_block = False
                continue
            else:
                cleaned_lines.append(line)
                continue

        # 如果不在metadata块中，保留该行
        if not in_metadata_block:
            cleaned_lines.append(line)

    return '\n'.join(cleaned_lines)

def _fix_multiline_links(markdown_text):
    lines = markdown_text.split('\n')
    result_lines = []
    i = 0

    while i < len(lines):
        line = lines[i].rstrip()

        # 检查是否以 "- [" 开头，可能是跨行链接的开始
        if line.strip().startswith('- [') and not line.strip().endswith(']'):
            # 收集链接的所有部分
            link_parts = []
            j = i

            # 收集直到找到闭合的 "]"
            while j < len(lines) and ']' not in lines[j]:
                link_parts.append(lines[j].strip())
                j += 1

            if j < len(lines):
                link_parts.append(lines[j].strip())
                # 现在收集URL部分
                url_line = j
                while url_line < len(lines) and '(' not in lines[url_line]:
                    url_line += 1

                if url_line < len(lines):
                    # 提取URL
                    url_match = re.search(r'\(\s*([^)]+)\s*\)', lines[url_line])
                    if url_match:
                        url = url_match.group(1).strip()
                        # 构建单行链接
                        link_text = ' '.join(' '.join(part.split()) for part in link_parts)
                        # 清理格式
                        link_text = re.sub(r'-\s*\[\s*', '- [', link_text)
                        link_text = re.sub(r'\s*\]\s*', ']', link_text)
                        result_lines.append(f'{link_text}({url})')
                        i = url_line + 1
                        continue

        # 如果不是跨行链接，直接添加该行
        result_lines.append(line)
        i += 1

    return '\n'.join(result_lines)

def _compress_blank_lines_line_by_line(markdown_text):
    lines = markdown_text.split('\n')
    result_lines = []
    previous_line_was_blank = False

    for line in lines:
        # 检查当前行是否为空白行（只包含空白字符或为空）
        is_blank = line.strip() == ''

        if is_blank:
            # 如果前一行不是空白行，则保留这个空白行
            if not previous_line_was_blank:
                result_lines.append('')
                previous_line_was_blank = True
            # 如果前一行已经是空白行，则跳过这个空白行
        else:
            # 非空白行，直接添加
            result_lines.append(line.rstrip())  # 移除行尾空白
            previous_line_was_blank = False

    # 如果最后一行是空白行，移除它
    if result_lines and result_lines[-1] == '':
        result_lines.pop()

    return '\n'.join(result_lines)

def _html_to_markdown(content):
    from html_to_markdown import convert, ConversionOptions
    markdown = convert(content)
    markdown = _remove_data_images(markdown)
    markdown = _remove_metas(markdown)
    markdown = _fix_multiline_links(markdown)
    markdown = _compress_blank_lines_line_by_line(markdown)
    return markdown

def invoke_get_content(url: str, return_format: str = "clean_text") -> str:
    """
    获取指定URL的网页内容，优先使用elinks导出干净的文本内容

    Args:
        url: 要获取内容的URL地址
        return_format: 返回内容的格式，'clean_text' 或 'markdown' 或 'html' 或 'links'

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

        raw_content = response.content
        # 优先使用HTTP响应头中的编码
        encoding_from_header = None
        if 'content-type' in response.headers:
            content_type = response.headers['content-type'].lower()
            charset_match = re.search(r'charset\s*=\s*([^\s;]+)', content_type)
            if charset_match:
                encoding_from_header = charset_match.group(1).lower()
                if encoding_from_header == 'gb2312':
                    encoding_from_header = 'gb18030'

        # 解码为Unicode字符串
        try:
            if encoding_from_header:
                content = raw_content.decode(encoding_from_header, errors='ignore')
            else:
                # 尝试使用 chardet 来检测
                import chardet
                detected_encoding = chardet.detect(raw_content)['encoding']
                content = raw_content.decode(detected_encoding, errors='ignore')
        except (UnicodeDecodeError, LookupError):
            try:
                content = raw_content.decode('utf-8', errors='ignore')
            except UnicodeDecodeError:
                content = raw_content.decode('latin-1', errors='ignore')

        if return_format == "links":
            links = invoke_parse_links(content)
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
        elif return_format == "markdown":
            return _html_to_markdown(content)
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

def process_bing_markdown(markdown_text):
    """
    从Bing搜索结果的Markdown文本中提取核心搜索结果部分。
    策略：定位搜索结果开始和结束的标志性行。
    """
    lines = markdown_text.splitlines()
    start_index = None
    end_index = None

    # 1. 寻找搜索结果开始的标志：通常是包含"About X results"或第一个明确的结果项标题的行。
    # 在提供的示例中，'About 10,900,000 results' 是一个很好的开始标志。
    for i, line in enumerate(lines):
        if re.search(r'^About\s+[\d,]+.*results', line.strip()):
            start_index = i
            break
    # 如果没找到上述模式，则寻找第一个以数字编号开头的结果项（例如 "1. ["）
    if start_index is None:
        for i, line in enumerate(lines):
            if re.match(r'^\d+\.\s*\[', line.strip()):
                start_index = i
                break

    # 2. 寻找搜索结果结束的标志：通常是分页导航（如"Pagination"）或页脚信息（如"增值电信业务"）开始之前。
    # 在示例中，'#### Pagination' 是结果列表结束的明确信号。
    for i, line in enumerate(lines):
        if line.strip().startswith('#### Pagination'):
            end_index = i
            break
    # 如果没有找到分页，则寻找典型的页脚关键词
    if end_index is None:
        footer_keywords = ['京ICP备', '京公网安备', 'Privacy', 'Terms', 'All', 'Past 24 hours']
        for i, line in enumerate(lines):
            if any(keyword in line for keyword in footer_keywords):
                end_index = i
                break

    # 3. 进行切片提取
    if start_index is not None and end_index is not None and start_index < end_index:
        extracted_lines = lines[start_index:end_index]
    elif start_index is not None:
        # 如果只找到了开始，提取到末尾
        extracted_lines = lines[start_index:]
    elif end_index is not None:
        # 如果只找到了结束，提取从开头到结束
        extracted_lines = lines[:end_index]
    else:
        # 如果都没找到，返回原文本或空字符串，这里选择返回原文本以便检查
        extracted_lines = lines
        print("警告：未找到明确的开始或结束边界。返回全部内容。")

    return '\n'.join(extracted_lines)

def preprocess_duckduckgo_html(html_content):
    """预处理DuckDuckGo HTML，移除导航元素"""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html_content, 'html.parser')

    # 移除表单和选择框
    for form in soup.find_all('form'):
        form.decompose()

    # 移除包含区域和时间选择的div
    for div in soup.find_all('div', class_='frm__select'):
        div.decompose()

    # 移除header区域
    header = soup.find('div', id='header')
    if header:
        header.decompose()

    return str(soup)

def process_duckduckgo_markdown(markdown_text):
    """
    简化 duckduckgo 结果 Markdown内容：每节保留标题链接，去除其他重复链接和图标，保留关键描述
    """
    # 分割成不同的部分（每个##开始的部分）
    sections = re.split(r'\n## ', markdown_text)
    simplified_sections = []

    index = 1
    for section in sections:
        if not section.strip():
            continue

        # 提取标题行（第一行）
        lines = section.strip().split('\n')
        if not lines:
            continue

        # 提取标题和链接
        title_match = re.search(r'\[([^\]]+)\]\(([^)]+)\)', lines[0])
        if not title_match:
            # 如果没有链接格式，使用原始标题
            simplified_sections.append("## " + section)
            continue

        title_text = title_match.group(1)
        main_url = title_match.group(2)

        # 构建标题行（保留链接）
        title_line = f"## {index}. [{title_text}]({main_url})"
        index = index + 1

        # 寻找描述性文本
        descriptions = []
        for line in lines[1:]:
            # 跳过图标行
            if re.match(r'^\s*\[<img[^>]+>\].*$', line.strip()):
                continue

            # 提取链接文本（去除链接标记）
            if '](' in line and line.strip().startswith('['):
                link_text_match = re.match(r'^\s*\[([^\]]+)\]\([^)]+\)', line)
                if link_text_match:
                    link_text = link_text_match.group(1)
                    descriptions.append(link_text)
            else:
                # 普通文本行
                descriptions.append(line.strip())

        # 如果有描述文本，添加到结果
        if descriptions:
            # 去重描述文本
            unique_descriptions = []
            seen = set()
            for desc in descriptions:
                if desc not in seen and len(desc) > 10:  # 过滤掉太短的文本
                    seen.add(desc)
                    unique_descriptions.append(desc)

            # 如果找到了描述文本，只保留第一条有意义的描述
            if unique_descriptions:
                # 选择最长的描述文本（通常包含最多信息）
                best_description = max(unique_descriptions, key=len)
                simplified_sections.append(f"{title_line}\n{best_description}")
            else:
                simplified_sections.append(title_line)
        else:
            simplified_sections.append(title_line)

    return "\n\n".join(simplified_sections)

def invoke_search(request: str, base_url: str = "https://html.duckduckgo.com/html/", max_results: int = 10, return_format: str = "markdown") -> str:
    """
    执行网络搜索

    Args:
        request: 搜索关键词或查询内容
        base_url: 搜索引擎的基础URL（默认为DuckDuckGo）
        max_results: 最大返回结果数量
        return_format: 返回内容的格式，'html' 或 'markdown' 或 'links'

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

        #1. DuckDuckGo：使用 POST 请求，参数在 `data` 中
        #2. Bing：使用 GET 请求，URL 格式为 `/search?q=关键词&form=QBLH`
        #3. Google：使用 GET 请求，URL 格式为 `/search?q=关键词&hl=en&gl=us`
        #4. 百度：使用 GET 请求，URL 格式为 `/s?wd=关键词&ie=utf-8`

        # DuckDuckGo 搜索参数
        if "duckduckgo.com" in base_url:
            params = {
                'q': request,
                'kl': 'us-en'
            }
            response = requests.post(base_url, data=params, headers=headers, timeout=15)
        elif "bing.com" in base_url or "cn.bing.com" in base_url:
            # Bing 搜索使用 GET 请求，参数在 URL 中
            search_url = f"{base_url.rstrip('/')}/search"
            params = {
                'q': request,
                'form': 'QBLH'  # Bing 搜索表单标识
            }
            response = requests.get(search_url, params=params, headers=headers, timeout=15)
        elif "google.com" in base_url:
            # Google 搜索使用 GET 请求
            search_url = f"{base_url.rstrip('/')}/search"
            params = {
                'q': request,
                'hl': 'en',      # 语言设置为英文
                'gl': 'us',      # 国家设置为美国
                'gws_rd': 'ssl'  # SSL 相关参数
            }
            response = requests.get(search_url, params=params, headers=headers, timeout=15)
        elif "baidu.com" in base_url:
            # 百度搜索使用 GET 请求
            search_url = f"{base_url.rstrip('/')}/s"
            params = {
                'wd': request,    # 百度使用 wd 参数
                'ie': 'utf-8'     # 编码设置
            }
            response = requests.get(search_url, params=params, headers=headers, timeout=15)
        else:
            # 默认处理：假设是 GET 请求，使用 q 参数
            search_url = base_url
            params = {
                'q': request
            }
            response = requests.get(search_url, params=params, headers=headers, timeout=15)

        response.raise_for_status()

        content = preprocess_duckduckgo_html(response.text)

        if return_format == "markdown":
            markdown_content = _html_to_markdown(content)
            if "duckduckgo.com" in base_url:
                return process_duckduckgo_markdown(markdown_content)
            elif "bing.com" in base_url or "cn.bing.com" in base_url:
                return process_bing_markdown(markdown_content)
            return markdown_content
        elif return_format == "links":
            # 直接返回解析后的链接
            links = invoke_parse_links(content)

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

def invoke_parse_links(content: str) -> List[Dict[str, str]]:
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

def invoke_download_file(
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

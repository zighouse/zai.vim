#!/usr/bin/env python3
import json
import os
import re
import requests
import shutil
import subprocess
import sys
import time
import urllib

from pathlib import Path
from typing import List, Dict, Optional, Literal, Any, Tuple
from urllib.parse import urlparse, quote_plus, urljoin

from toolcommon import sanitize_path

# 尝试导入 trafilatura
try:
    import trafilatura
    HAVE_TRAFILATURA = True
except ImportError:
    HAVE_TRAFILATURA = False

_DEFAULT_SEARCH_ENGINE = "https://html.duckduckgo.com/html/"

def _remove_data_images(markdown_text):
    pattern = r'!\[[^\]]*\]\(data:image[^)]+\)'
    cleaned_text = re.sub(pattern, '', markdown_text)
    return cleaned_text

def _remove_images(markdown_text):
    empty_image_link_pattern = re.compile(r"!\[\]\(.*?\)", re.MULTILINE)
    cleaned_text = empty_image_link_pattern.sub("", markdown_text)
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

def _remove_empty_links(markdown_text):
    empty_link_pattern = re.compile(r"\[\]\(.*?\)", re.MULTILINE)
    cleaned_text = empty_link_pattern.sub("", markdown_text)
    return cleaned_text

#_url_pattern = re.compile(r'(https?://\S+)')
_url_pattern = re.compile(r'(https?://[^\s<>(){}"\']+)')
_fragment_url_pattern = re.compile(r'(https?://[^#\s]+)#:~:text=([^\s\)]+)')
_link_or_url_pattern = re.compile(r'\[(.*?)\]\((.*?)\)|(https?://\S+)')
_link_pattern = re.compile(r'\[([^\]]+)\]\(([^)]+)\)')
def _parse_fragment_url(url):
    """ 从 URL 中提取 Text Fragment，移除 Fragment，并返回处理后的 URL 和 Fragment 文本。"""
    fragment_match = _fragment_url_pattern.match(url)
    if fragment_match:
        base_url = fragment_match.group(1)
        fragment_code = fragment_match.group(2)
        fragment = urllib.parse.unquote(fragment_code)
        return base_url, fragment
    return url, None

def _clean_url_labels(text):
    """
    清理 Markdown 链接标签中的 url
    1. [labelhttps://...](url)
    2. [label http://...](url)
    3. [https://...label](url)
    """
    def clean_label(match):
        full_label = match.group(1)
        url = match.group(2)
        def removement(match):
            return ""
        label = _url_pattern.sub(removement, full_label).strip()
        return f'[{label}]({url})'
    return _link_pattern.sub(clean_label, text)

def _process_url_fragment(markdown_text):
    """
    处理 Markdown 文本中的 URL：
    1. [label + url?](url-with-fragment) -> [label](cleaned_url) + fragment_text
    2. standalone_url-with-fragment -> cleaned_url + fragment_text
    """
    def process_match(match):
        if match.group(1) is not None: # Matched [link_text](url)
            link_label = match.group(1)
            link_url = match.group(2)
            cleaned_url, fragment = _parse_fragment_url(link_url)
            if fragment is not None:
                def removement(match):
                    return ""
                clean_link_text = _url_pattern.sub(removement, link_label).strip()
                return f'[{clean_link_text}]({cleaned_url}) {fragment}'
            else:
                return f'[{link_label}]({link_url})'
        elif match.group(3) is not None: # Matched standalone url
            original_url = match.group(3)
            cleaned_url, fragment = _parse_fragment_url(original_url)
            if fragment is not None:
                return f'{cleaned_url} {fragment}'
            else:
                return original_url
        return match.group(0) # Should not happen
    return _link_or_url_pattern.sub(process_match, markdown_text)

def _deduplicate_by_url(markdown_text):
    """
    通过URL对段落进行去重，保留内容更长的段落，
    返回段落列表
    """
    paragraphs = markdown_text.split('\n\n')
    url_to_paragraph = {}
    to_remove = set()
    for i, para in enumerate(paragraphs):
        urls = _url_pattern.findall(para)
        if urls:
            # 使用第一个URL作为标识符（通常是最相关的）
            primary_url = urls[0]
            if primary_url in url_to_paragraph:
                # url 相同时，删除短的段落
                existing_idx = url_to_paragraph[primary_url]
                existing_para = paragraphs[existing_idx]
                if len(para) > len(existing_para):
                    to_remove.add(existing_idx)
                    url_to_paragraph[primary_url] = i
                else:
                    to_remove.add(i)
            else:
                url_to_paragraph[primary_url] = i
    deduplicated_paragraphs = []
    for i, para in enumerate(paragraphs):
        if i not in to_remove and para.strip():  # 保留非空段落
            deduplicated_paragraphs.append(para)
    return deduplicated_paragraphs
    return '\n\n'.join(deduplicated_paragraphs)

def _compress_blank_lines_line_by_line(markdown_text):
    lines = markdown_text.split('\n')
    result_lines = []
    previous_line_was_blank = False
    for line in lines:
        if line.strip() == '':
            if not previous_line_was_blank:
                result_lines.append('')
                previous_line_was_blank = True
        else:
            result_lines.append(line.rstrip())  # 移除行尾空白
            previous_line_was_blank = False
    if result_lines and result_lines[-1] == '':
        result_lines.pop()
    return '\n'.join(result_lines)

def _extract_main_content_intelligent(html_content: str, url: str = None, format: str = 'txt') -> Optional[Dict[str, Any]]:
    """
    使用 trafilatura 智能提取网页正文内容，提取失败时返回 None

    Args:
        html_content: HTML 内容
        url: 页面 URL（用于更准确的内容提取）
        format: 输出格式，'txt' 或 'markdown'

    Returns:
        Dict: 包含 title, description, content, url 的字典，失败返回 None
    """
    if not HAVE_TRAFILATURA:
        return None

    try:
        # 确定输出格式
        output_format = 'markdown' if format == 'markdown' else 'txt'

        # 使用 trafilatura 提取主要内容，保留链接
        extracted_content = trafilatura.extract(
            html_content,
            include_comments=False,
            include_tables=True,
            include_links=True,  # 保留链接
            include_formatting=True,  # 保留格式
            no_fallback=False,
            url=url,
            output_format=output_format
        )

        # 如果提取失败或内容为空
        if not extracted_content or len(extracted_content.strip()) < 50:
            return None

        # 提取元数据（使用 metadata extraction function）
        metadata = trafilatura.metadata.extract_metadata(html_content)

        # metadata 返回的是 Document 对象，需要访问其属性
        title = metadata.title if metadata else ''
        description = metadata.description if metadata else ''
        author = metadata.author if metadata else ''
        date = metadata.date if metadata else ''

        return {
            "title": title or '',
            "description": description or '',
            "author": author or '',
            "date": date or '',
            "content": extracted_content,
            "url": url
        }
    except Exception as e:
        # trafilatura 提取失败，返回 None 以便回退
        import traceback
        print(f"[trafilatura] extraction failed: {e}", file=sys.stderr)
        print(f"[trafilatura] traceback: {traceback.format_exc()}", file=sys.stderr)
        return None

def _html_to_markdown(content):
    """
    使用 html2text 将 HTML 转换为 Markdown，相比 html_to_markdown 更稳定。
    FIXME: 处理这个 url 时发生了 convert 的崩溃:
    https://blog.csdn.net/qq_43252731/article/details/148872910
    """
    try:
        import html2text
        h = html2text.HTML2Text()
        h.ignore_links = False
        h.ignore_images = False
        h.body_width = 0  # 不换行
        markdown = h.handle(content)
        markdown = _remove_data_images(markdown)
        markdown = _remove_metas(markdown)
        markdown = _fix_multiline_links(markdown)
        markdown = _remove_empty_links(markdown)
        markdown = _compress_blank_lines_line_by_line(markdown)
        return markdown
    except Exception as e:
        import traceback
        import tempfile

        timestamp = int(time.time())
        temp_dir = tempfile.gettempdir()
        error_file = os.path.join(temp_dir, f"error_{timestamp}.log")
        try:
            with open(error_file, 'w', encoding='utf-8') as f:
                f.write(content[:50000])  # 只保存前50000字符避免过大
                f.write('\n\n=== Error ===\n')
                f.write(str(e))
                f.write('\n')
                f.write(traceback.format_exc())
            print(f"[html2text error] convert content failed, error content is saved in {error_file}", file=sys.stderr)
        except Exception as log_err:
            print(f"[html2text error] convert content failed: {e}", file=sys.stderr)
        return "convert content failed"

def invoke_web_get_content(url: str, return_format: str = "clean_text") -> str:
    """
    获取指定URL的网页内容，优先使用智能提取（trafilatura），失败时回退到 elinks 或 html2text

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

        parsed = urlparse(url)
        encoding_from_header = None
        if parsed.scheme in ('http', 'https'):
            response = requests.get(url, headers=headers, timeout=10)
            response.raise_for_status()  # 如果状态码不是200，抛出异常

            raw_content = response.content
            # 优先使用HTTP响应头中的编码
            if 'content-type' in response.headers:
                content_type = response.headers['content-type'].lower()
                charset_match = re.search(r'charset\s*=\s*([^\s;]+)', content_type)
                if charset_match:
                    encoding_from_header = charset_match.group(1).lower()
                    if encoding_from_header == 'gb2312':
                        encoding_from_header = 'gb18030'
        elif parsed.scheme == 'file' or parsed.scheme == '':
            response = urllib.request.urlopen(url)
            #content = response.read().decode('utf-8')
            raw_content = response.read()
        else:
            return f"Unsupported get content from `{url}`"

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
            links = invoke_web_parse_links(content, base_url=url)
            if links:
                result = []
                for link in links:
                    caption = link.get('caption', 'No caption')
                    result.append(f"{caption}: {link['url']}")
                return "\n".join(result)
            else:
                return "No links found in the content"
        elif return_format == "clean_text":
            # 尝试使用 trafilatura 智能提取
            extracted = _extract_main_content_intelligent(content, url, format='txt')
            if extracted:
                return extracted['content']
            else:
                # 回退到原来的方案
                print(f"[web_get_content] trafilatura failed, falling back to extract_clean_text", file=sys.stderr)
                return extract_clean_text(content)
        elif return_format == "markdown":
            # 尝试使用 trafilatura 智能提取（使用 markdown 格式保留链接）
            extracted = _extract_main_content_intelligent(content, url, format='markdown')
            if extracted:
                # 构建结构化 Markdown 输出
                parts = []
                if extracted['title']:
                    parts.append(f"# {extracted['title']}")
                if extracted['description']:
                    parts.append(f"\n> {extracted['description']}\n")
                if extracted['content']:
                    parts.append(extracted['content'])
                return '\n'.join(parts)
            else:
                # 回退到原来的方案
                print(f"[web_get_content] trafilatura failed, falling back to html2text", file=sys.stderr)
                content = make_links_absolute(content, url)
                text = _html_to_markdown(content)
                text = _clean_url_labels(text)
                text = _remove_empty_links(text)
                text = _process_url_fragment(text)
                paras = _deduplicate_by_url(text)
                text = '\n\n'.join(paras)
                return text
        else:
            # 返回清理后的HTML内容
            content = make_links_absolute(content, url)
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
        parsed = urlparse(url)
        if parsed.scheme in ('http', 'https'):
            response = requests.get(url, headers=headers, timeout=10)
            response.raise_for_status()
            return extract_clean_text(response.text)
        elif parsed.scheme == 'file' or parsed.scheme == '':
            response = urllib.request.urlopen(url)
            content = response.read().decode('utf-8')
            return extract_clean_text(content)
        else:
            return f"Unsupported get content from `{url}`"
    except Exception as e:
        return f"Fallback also failed: {str(e)}"

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

def make_links_absolute(html_content: str, base_url: str) -> str:
    """
    将HTML内容中的所有相对链接补全为绝对链接
    Args:
        html_content: HTML内容
        base_url: 基准URL，用于补全相对链接
    Returns:
        str: 补全链接后的HTML内容
    """
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html_content, 'html.parser')
        # 补全所有 <a> 标签的 href 属性
        for a_tag in soup.find_all('a', href=True):
            try:
                href = a_tag['href']
                # 跳过锚点链接、javascript链接等
                if href and not href.startswith('#') and not href.startswith('javascript:'):
                    # 补全相对链接
                    absolute_url = urljoin(base_url, href)
                    a_tag['href'] = absolute_url
            except Exception as e:
                # 如果补全失败，保持原样
                pass
        # 补全所有 <img> 标签的 src 属性
        for img_tag in soup.find_all('img', src=True):
            try:
                src = img_tag['src']
                if src:
                    absolute_url = urljoin(base_url, src)
                    img_tag['src'] = absolute_url
            except Exception as e:
                pass
        # 补全其他可能有链接的属性
        for tag in soup.find_all(True):
            for attr in ['src', 'href', 'action', 'data-src', 'data-href']:
                if tag.has_attr(attr):
                    try:
                        value = tag[attr]
                        if value and not value.startswith('#') and not value.startswith('javascript:'):
                            absolute_url = urljoin(base_url, value)
                            tag[attr] = absolute_url
                    except Exception as e:
                        pass
        return str(soup)
    except ImportError:
        # 如果没有BeautifulSoup，使用正则表达式进行简单补全
        # 只处理最常见的href属性
        import re
        # 匹配 href="..." 或 href='...'
        def replace_href(match):
            quote_char = match.group(1)  # " 或 '
            href = match.group(2)
            # 如果已经是绝对链接或特殊链接，保持原样
            if (href.startswith('http://') or href.startswith('https://') or 
                href.startswith('#') or href.startswith('javascript:')):
                return match.group(0)
            try:
                absolute_url = urljoin(base_url, href)
                return f'href={quote_char}{absolute_url}{quote_char}'
            except:
                return match.group(0)
        # 处理双引号和单引号的href属性
        html_content = re.sub(r'href=(["\'])(.*?)\1', replace_href, html_content, flags=re.IGNORECASE)
        return html_content

def preprocess_html_with_absolute_links(html_content: str, base_url: str) -> str:
    """
    预处理HTML内容，将相对链接补全为绝对链接
    Args:
        html_content: HTML内容
        base_url: 基准URL
    Returns:
        str: 补全链接后的HTML内容
    """
    return make_links_absolute(html_content, base_url)

# {
#   "type": "function",
#   "function": {
#     "name": "web_search",
#     "description": "执行网络搜索（当同时提供了 SearXNG 元搜索工具时，优先使用 SearXNG）",
#     "parameters": {
#       "type": "object",
#       "properties": {
#         "request": {
#           "type": "string",
#           "description": "搜索关键词或查询内容"
#         },
#         "engine": {
#           "type": "string",
#           "description": "搜索引擎名称，可选值：'duckduckgo', 'baidu', 'auto'。如果未指定（即指定为空字符串''），则使用base_url或默认配置",
#           "enum": ["duckduckgo", "baidu", "auto"],
#           "default": "duckduckgo"
#         },
#         "base_url": {
#           "type": "string",
#           "description": "搜索引擎的基础URL（可选，如果指定engine则忽略此参数）",
#           "default": "https://html.duckduckgo.com/html/"
#         },
#         "max_results": {
#           "type": "integer",
#           "description": "最大返回结果数量（可选，默认为10）",
#           "default": 10
#         },
#         "return_format": {
#           "type": "string",
#           "description": "返回内容的格式，'html' 返回原始搜索结果页面, 'markdown' 返回markdown格式的搜索结果，'links' 返回解析后的搜索结果链接",
#           "enum": ["html", "markdown", "links"],
#           "default": "markdown"
#         }
#       },
#       "required": ["request"]
#     }
#   }
# },
def _invoke_web_search_fallback(request: str, engine: str = "duckduckgo", base_url: str = _DEFAULT_SEARCH_ENGINE, max_results: int = 10, return_format: str = "markdown") -> str:
    """
    旧的 web_search 实现（作为 fallback）

    Args:
        request: 搜索关键词或查询内容
        engine: 搜索引擎名称，可选值：'duckduckgo', 'baidu'。如果未指定，则使用base_url或默认配置
        base_url: 搜索引擎的基础URL（可选，如果指定engine则忽略此参数）
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

        # 确定使用哪个搜索引擎
        selected_base_url = base_url

        if engine == "duckduckgo":
            selected_base_url = "https://html.duckduckgo.com/html/"
        elif engine == "baidu":
            selected_base_url = "https://www.baidu.com"
        # 否则使用传入的 base_url

        # DuckDuckGo：使用 POST 请求，参数在 `data` 中
        # 百度：使用 GET 请求，URL 格式为 `/s?wd=关键词&ie=utf-8`

        if "duckduckgo.com" in selected_base_url:
            params = {
                'q': request,
                'kl': 'us-en'
            }
            response = requests.post(selected_base_url, data=params, headers=headers, timeout=15)
        elif "baidu.com" in selected_base_url:
            search_url = f"{selected_base_url.rstrip('/')}/s"
            params = {
                'wd': request,    # 百度使用 wd 参数
                'ie': 'utf-8'     # 编码设置
            }
            response = requests.get(search_url, params=params, headers=headers, timeout=15)
        else:
            search_url = selected_base_url
            params = {
                'q': request
            }
            response = requests.get(search_url, params=params, headers=headers, timeout=15)

        if response:
            response.raise_for_status()
            content = preprocess_duckduckgo_html(response.text)

        if return_format == "markdown":
            markdown_content = _html_to_markdown(content)
            if "duckduckgo.com" in selected_base_url:
                return process_duckduckgo_markdown(markdown_content)
            return markdown_content
        elif return_format == "links":
            # 直接返回解析后的链接
            links = invoke_web_parse_links(content, base_url=url)

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

def invoke_web_parse_links(content: str, base_url: str = None) -> List[Dict[str, str]]:
    """
    解析HTML内容中的URL链接，并可选地将相对链接补全为绝对链接

    Args:
        content: 要解析的HTML内容
        base_url: 基准URL，用于补全相对链接。如果为None，则返回原始链接

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
            # 补全相对链接
            if url and base_url:
                try:
                    url = urljoin(base_url, url)
                except Exception as e:
                    # 如果urljoin失败，保持原样
                    pass

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
                    # 补全相对链接
                    if base_url:
                        try:
                            url = urljoin(base_url, url)
                        except Exception as e:
                            # 如果urljoin失败，保持原样
                            pass
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

def invoke_web_download_file(
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
    if output_dir:
        output_dir_path = sanitize_path(output_dir)
    else:
        output_dir_path = sanitize_path() / "downloads"
    if filename:
        file_name = filename
    else:
        parsed_url = urlparse(url)
        url_filename = Path(parsed_url.path).name
        if url_filename and url_filename != "/":
            file_name = url_filename
        else:
            timestamp = int(time.time())
            file_name = f"downloaded_file_{timestamp}"
    return output_dir_path / file_name

def invoke_web_search(
    request: str,
    engine: str = "",
    category: str = "",
    time_range: str = "",
    max_results: int = 10,
    return_format: str = "markdown"
) -> str:
    """
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
    """
    try:
        # 尝试使用 SearXNG
        import tool_searxng
        return tool_searxng.invoke_web_search(
            request=request,
            engine=engine,
            category=category,
            time_range=time_range,
            max_results=max_results,
            return_format=return_format
        )
    except Exception as e:
        # SearXNG 不可用，回退到旧实现
        print(f"[web_search] SearXNG 不可用 ({e})，使用旧实现", file=sys.stderr)
        # 映射参数到旧实现
        old_engine = engine if engine in ("duckduckgo", "baidu") else "duckduckgo"
        old_format = return_format if return_format in ("markdown", "html", "links") else "markdown"
        return _invoke_web_search_fallback(
            request=request,
            engine=old_engine,
            max_results=max_results,
            return_format=old_format
        )


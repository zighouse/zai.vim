#!/usr/bin/env python3
"""
File toolbox —— 动态兼容层
所有导出函数统一加上 invoke_ 前缀，供 ToolManager.call_tool 路由
"""
import shutil
import os
import stat
import re
from datetime import datetime
from toolcommon import sanitize_path


def invoke_ls(path: str = "") -> str:
    """列出沙盒内指定目录的内容，返回格式化的字符串"""
    try:
        target_dir = sanitize_path(path)

        if not target_dir.exists():
            return f"错误：目录 '{path}' 不存在"

        if not target_dir.is_dir():
            return f"错误：'{path}' 不是目录"

        items = []
        for item in target_dir.iterdir():
            try:
                if not os.access(item, os.R_OK):
                    continue

                stat_info = item.stat()
                mode = stat_info.st_mode

                if stat.S_ISDIR(mode):
                    item_type = "目录"
                elif stat.S_ISLNK(mode):
                    item_type = "链接"
                elif stat.S_ISREG(mode):
                    item_type = "文件"
                else:
                    item_type = "其他"

                size = stat_info.st_size
                mtime = datetime.fromtimestamp(stat_info.st_mtime)
                datetime_str = mtime.strftime("%Y-%m-%d %H:%M:%S")

                items.append([item_type, size, datetime_str, item.name])

            except (OSError, PermissionError):
                continue

        items.sort(key=lambda x: x[2], reverse=True)

        if not items:
            return f"目录 '{path}' 为空"

        # 计算各列的最大宽度
        max_type_width = max(len(item[0]) for item in items)
        max_size_width = max(len(f"{item[1]:,}") if item[0] == "文件" else 2 for item in items)  # 文件显示数字，目录显示"-"
        max_name_width = max(len(item[3]) for item in items)

        # 确保表头宽度足够
        max_type_width = max(max_type_width, 4)  # "类型"占4字符
        max_size_width = max(max_size_width, 6)  # "大小"占6字符
        max_name_width = max(max_name_width, 4)  # "名称"占4字符

        # 构建表头
        header_type = "类型".ljust(max_type_width)
        header_size = "大小".ljust(max_size_width)
        header_time = "修改时间"
        header_name = "名称".ljust(max_name_width)

        header = f"{header_type} {header_size} {header_time} {header_name}"

        # 构建分隔线（精确匹配表头长度）
        separator = "-" * len(header)

        # 构建表格内容
        lines = [f"目录 '{path}' 的内容：", header, separator]

        for item_type, size, datetime_str, name in items:
            # 格式化类型列
            type_str = item_type.ljust(max_type_width)

            # 格式化大小列：文件显示具体大小，目录显示"-"
            if item_type == "文件":
                size_str = f"{size:,}".rjust(max_size_width)  # 右对齐，千分位分隔
            else:
                size_str = "-".center(max_size_width)  # 居中对齐

            # 格式化时间列（固定19字符）
            time_str = datetime_str.ljust(19)

            # 格式化名称列
            name_str = name.ljust(max_name_width)

            line = f"{type_str} {size_str} {time_str} {name_str}"
            lines.append(line)

        return "\n".join(lines)

    except ValueError as e:
        return f"安全错误：{e}"
    except Exception as e:
        return f"错误：{str(e)}"


def invoke_read_file(path: str) -> str:
    """读取沙盒内的文件内容"""
    try:
        target_file = sanitize_path(path)

        if not target_file.exists():
            return f"错误：文件 '{path}' 不存在"

        if not target_file.is_file():
            return f"错误：'{path}' 不是文件"

        with open(target_file, 'r', encoding='utf-8') as f:
            return f.read()

    except ValueError as e:
        return f"安全错误：{e}"
    except Exception as e:
        return f"错误：{str(e)}"


def invoke_write_file(path: str, content: str, mode: str = "w") -> str:
    """向沙盒内的文件写入内容"""
    try:
        target_file = sanitize_path(path)

        # 确保父目录存在
        target_file.parent.mkdir(parents=True, exist_ok=True)

        with open(target_file, mode, encoding='utf-8') as f:
            f.write(content)

        return f"成功写入文件 '{path}'"

    except ValueError as e:
        return f"安全错误：{e}"
    except Exception as e:
        return f"错误：{str(e)}"


def invoke_mkdir(path: str) -> str:
    """在沙盒内创建目录"""
    try:
        target_dir = sanitize_path(path)

        if target_dir.exists():
            return f"错误：路径 '{path}' 已存在"

        target_dir.mkdir(parents=True, exist_ok=True)
        return f"成功创建目录 '{path}'"

    except ValueError as e:
        return f"安全错误：{e}"
    except Exception as e:
        return f"错误：{str(e)}"


def invoke_copy_file(source, destination: str) -> str:
    """
    复制沙盒内的文件或目录到指定路径，支持合并多个文件
    Args:
        source: 单个源文件/目录路径，或多个源文件路径列表
        destination: 目标路径
    Returns:
        str: 操作结果信息字符串
    """
    try:
        dest_path = sanitize_path(destination)

        # 处理多个源文件合并的情况
        if isinstance(source, list):
            return _merge_multiple_files(source, dest_path)

        # 处理单个源路径的情况
        source_path = sanitize_path(source)

        # 检查源路径是否存在
        if not source_path.exists():
            return f"错误：源路径 '{source}' 不存在"

        # 如果是文件，直接复制
        if source_path.is_file():
            shutil.copy2(source_path, dest_path)
            return f"成功复制文件 '{source}' -> '{destination}'"

        # 如果是目录，递归复制
        elif source_path.is_dir():
            shutil.copytree(source_path, dest_path)
            return f"成功复制目录 '{source}' -> '{destination}'"

        else:
            return f"错误：未知的源路径类型 '{source}'"

    except ValueError as e:
        return f"安全错误：{e}"
    except FileExistsError:
        return f"错误：目标路径 '{destination}' 已存在"
    except Exception as e:
        return f"错误：复制失败 - {str(e)}"


def _merge_multiple_files(sources: list, dest_path):
    """
    合并多个文件到一个目标文件
    Args:
        sources: 源文件路径列表
        dest_path: 目标文件路径
    Returns:
        str: 操作结果信息字符串
    """
    try:
        # 检查所有源文件是否存在且为文件
        source_paths = []
        for source in sources:
            source_path = sanitize_path(source)
            if not source_path.exists():
                return f"错误：源文件 '{source}' 不存在"
            if not source_path.is_file():
                return f"错误：源路径 '{source}' 不是文件"
            source_paths.append(source_path)

        # 创建目标文件的父目录（如果不存在）
        dest_path.parent.mkdir(parents=True, exist_ok=True)

        # 使用追加模式合并文件
        with open(dest_path, 'w', encoding='utf-8') as dest_file:
            for i, source_path in enumerate(source_paths):
                try:
                    with open(source_path, 'r', encoding='utf-8') as src_file:
                        content = src_file.read()
                        dest_file.write(content)

                        # 如果不是最后一个文件，添加换行符分隔（可选）
                        if i < len(source_paths) - 1:
                            dest_file.write('\n')

                except UnicodeDecodeError:
                    # 如果是二进制文件，使用二进制模式
                    with open(source_path, 'rb') as src_file:
                        content = src_file.read()
                        # 对于二进制文件，需要切换到二进制模式
                        dest_file.close()  # 先关闭文本模式文件
                        with open(dest_path, 'ab' if i > 0 else 'wb') as dest_file_bin:
                            dest_file_bin.write(content)
                        # 重新打开文本模式文件用于后续写入
                        dest_file = open(dest_path, 'a', encoding='utf-8')

        source_names = ', '.join(sources)
        return f"成功合并文件 [{source_names}] -> '{dest_path}'"

    except Exception as e:
        return f"错误：合并文件失败 - {str(e)}"


def invoke_descript_file(path: str) -> str:
    """
    描述文件类型和格式，使用 file 命令或 Python 内置方法
    Args:
        path: 文件路径
    Returns:
        str: 文件描述信息
    """
    try:
        target_file = sanitize_path(path)

        if not target_file.exists():
            return f"错误：文件 '{path}' 不存在"

        if not target_file.is_file():
            return f"错误：'{path}' 不是文件"

        # 首先尝试使用 file 命令（Linux/Unix 系统）
        import subprocess
        import shutil

        # 检查 file 命令是否可用
        if shutil.which('file'):
            try:
                result = subprocess.run(
                    ['file', '-b', str(target_file)],
                    capture_output=True,
                    text=True,
                    timeout=10
                )
                if result.returncode == 0:
                    description = result.stdout.strip()
                    return f"文件 '{path}' 的描述：{description}"
            except (subprocess.TimeoutExpired, subprocess.SubprocessError):
                pass  # 如果 file 命令失败，回退到 Python 方法

        # 如果 file 命令不可用或失败，使用 Python 内置方法
        return _describe_file_with_python(target_file, path)

    except ValueError as e:
        return f"安全错误：{e}"
    except Exception as e:
        return f"错误：{str(e)}"


def _describe_file_with_python(file_path, original_path):
    """使用 Python 内置方法描述文件类型"""
    import stat
    try:
        stat_info = file_path.stat()
        size = stat_info.st_size

        # 检查文件大小
        if size == 0:
            return f"文件 '{original_path}' 的描述：空文件"

        # 尝试使用 python-magic 库（如果可用）
        try:
            import magic
            mime = magic.Magic(mime=True)
            mime_type = mime.from_file(str(file_path))
            description = f"{mime_type} ({size} 字节)"
            return f"文件 '{original_path}' 的描述：{description}"
        except ImportError:
            pass  # 如果 python-magic 不可用，继续使用其他方法

        # 基于文件扩展名和内容的简单检测
        description = _simple_file_detection(file_path, size)
        return f"文件 '{original_path}' 的描述：{description}"

    except Exception:
        # 最后的回退方案
        return f"文件 '{original_path}' 的基本信息：{size} 字节"

def _simple_file_detection(file_path, size):
    """使用简单方法检测文件类型"""
    extension = file_path.suffix.lower()

    # 常见文件类型的扩展名映射
    extension_map = {
        '.txt': '文本文件',
        '.py': 'Python 脚本',
        '.js': 'JavaScript 文件',
        '.json': 'JSON 数据文件',
        '.xml': 'XML 文件',
        '.html': 'HTML 文档',
        '.css': 'CSS 样式表',
        '.md': 'Markdown 文档',
        '.pdf': 'PDF 文档',
        '.jpg': 'JPEG 图像',
        '.jpeg': 'JPEG 图像',
        '.png': 'PNG 图像',
        '.gif': 'GIF 图像',
        '.bmp': 'BMP 图像',
        '.svg': 'SVG 矢量图像',
        '.mp3': 'MP3 音频',
        '.mp4': 'MP4 视频',
        '.avi': 'AVI 视频',
        '.zip': 'ZIP 压缩文件',
        '.tar': 'TAR 归档文件',
        '.gz': 'GZIP 压缩文件',
        '.exe': '可执行文件',
        '.dll': '动态链接库',
        '.so': '共享库',
        '.bin': '二进制文件',
        '.log': '日志文件',
        '.csv': 'CSV 数据文件',
        '.sql': 'SQL 脚本',
        '.sh': 'Shell 脚本',
        '.bat': '批处理文件',
        '.ps1': 'PowerShell 脚本',
    }

    if extension in extension_map:
        return f"{extension_map[extension]} ({size} 字节)"

    # 尝试读取文件开头来判断类型
    try:
        with open(file_path, 'rb') as f:
            header = f.read(512)  # 读取前512字节

        # 常见文件类型的魔术数字
        if header.startswith(b'\x89PNG\r\n\x1a\n'):
            return f"PNG 图像 ({size} 字节)"
        elif header.startswith(b'\xff\xd8\xff'):
            return f"JPEG 图像 ({size} 字节)"
        elif header.startswith(b'GIF8'):
            return f"GIF 图像 ({size} 字节)"
        elif header.startswith(b'%PDF'):
            return f"PDF 文档 ({size} 字节)"
        elif header.startswith(b'PK\x03\x04'):
            return f"ZIP 压缩文件 ({size} 字节)"
        elif header.startswith(b'\x1f\x8b'):
            return f"GZIP 压缩文件 ({size} 字节)"
        elif header.startswith(b'\x7fELF'):
            return f"ELF 可执行文件 ({size} 字节)"
        elif b'<!DOCTYPE html' in header[:100] or b'<html' in header[:100]:
            return f"HTML 文档 ({size} 字节)"
        elif b'<?xml' in header[:100]:
            return f"XML 文档 ({size} 字节)"

        # 检查是否为文本文件
        try:
            header.decode('utf-8')
            return f"文本文件 ({size} 字节)"
        except UnicodeDecodeError:
            return f"二进制文件 ({size} 字节)"

    except Exception:
        return f"未知文件类型 ({size} 字节)"

def invoke_substitute_file(path: str, old_text: str, new_text: str, use_regex: bool = False, count: int = 0) -> str:
    """
    对文本文件的局部内容进行替换

    Args:
        path: 文件路径
        old_text: 要替换的旧文本或正则表达式模式
        new_text: 替换后的新文本
        use_regex: 是否使用正则表达式进行匹配，默认为 false（字符串匹配）
        count: 替换次数，0 表示替换所有匹配项，默认为 0

    Returns:
        str: 操作结果信息字符串
    """
    try:
        target_file = sanitize_path(path)

        if not target_file.exists():
            return f"错误：文件 '{path}' 不存在"

        if not target_file.is_file():
            return f"错误：'{path}' 不是文件"

        with open(target_file, 'r', encoding='utf-8') as f:
            content = f.read()

        if use_regex:
            try:
                if count == 0:
                    new_content, replacements = re.subn(old_text, new_text, content)
                else:
                    pattern = re.compile(old_text)
                    new_content = content
                    replacements = 0
                    for i in range(count):
                        new_content, n = pattern.subn(new_text, new_content, 1)
                        replacements += n
                        if n == 0:
                            break
            except re.error as e:
                return f"错误：无效的正则表达式 '{old_text}' - {str(e)}"
        else:
            if count == 0:
                new_content = content.replace(old_text, new_text)
                replacements = content.count(old_text)
            else:
                new_content = content
                replacements = 0
                start = 0
                for i in range(count):
                    pos = new_content.find(old_text, start)
                    if pos == -1:
                        break
                    new_content = new_content[:pos] + new_text + new_content[pos + len(old_text):]
                    start = pos + len(new_text)
                    replacements += 1

        if replacements == 0:
            return f"警告：在文件 '{path}' 中未找到匹配的文本"

        with open(target_file, 'w', encoding='utf-8') as f:
            f.write(new_content)

        return f"成功在文件 '{path}' 中完成 {replacements} 处替换"

    except ValueError as e:
        return f"安全错误：{e}"
    except Exception as e:
        return f"错误：{str(e)}"

def invoke_search_in_file(path: str, pattern: str, use_regex: bool = False, case_sensitive: bool = True, max_results: int = 0, context_lines: int = 2) -> str:
    """
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
    """
    try:
        target_file = sanitize_path(path)

        # 检查文件是否存在
        if not target_file.exists():
            return f"错误：文件 '{path}' 不存在"

        if not target_file.is_file():
            return f"错误：'{path}' 不是文件"

        # 读取文件内容
        with open(target_file, 'r', encoding='utf-8') as f:
            lines = f.readlines()

        # 准备搜索结果
        results = []
        result_count = 0

        # 执行搜索操作
        for line_num, line in enumerate(lines, 1):
            if use_regex:
                # 使用正则表达式搜索
                try:
                    flags = 0 if case_sensitive else re.IGNORECASE
                    matches = list(re.finditer(pattern, line, flags))
                    for match in matches:
                        if max_results > 0 and result_count >= max_results:
                            break

                        start_pos = match.start()
                        end_pos = match.end()
                        matched_text = match.group()

                        # 添加上下文
                        context_start = max(0, line_num - context_lines - 1)
                        context_end = min(len(lines), line_num + context_lines)
                        context = lines[context_start:context_end]

                        results.append({
                            'line': line_num,
                            'position': start_pos,
                            'matched_text': matched_text,
                            'context': context,
                            'context_start_line': context_start + 1
                        })
                        result_count += 1
                except re.error as e:
                    return f"错误：无效的正则表达式 '{pattern}' - {str(e)}"
            else:
                # 使用字符串搜索
                search_text = line if case_sensitive else line.lower()
                search_pattern = pattern if case_sensitive else pattern.lower()

                start_pos = 0
                while True:
                    pos = search_text.find(search_pattern, start_pos)
                    if pos == -1:
                        break

                    if max_results > 0 and result_count >= max_results:
                        break

                    # 添加上下文
                    context_start = max(0, line_num - context_lines - 1)
                    context_end = min(len(lines), line_num + context_lines)
                    context = lines[context_start:context_end]

                    results.append({
                        'line': line_num,
                        'position': pos,
                        'matched_text': line[pos:pos + len(pattern)],
                        'context': context,
                        'context_start_line': context_start + 1
                    })
                    result_count += 1
                    start_pos = pos + 1

        # 格式化输出结果
        if not results:
            return f"在文件 '{path}' 中未找到匹配的文本"

        output_lines = [f"在文件 '{path}' 中找到 {len(results)} 个匹配项：\n"]

        for i, result in enumerate(results, 1):
            output_lines.append(f"匹配项 {i}:")
            output_lines.append(f"  位置：第 {result['line']} 行，第 {result['position'] + 1} 列")
            output_lines.append(f"  匹配文本：{result['matched_text']}")
            output_lines.append(f"  上下文：")

            # 显示上下文
            for j, context_line in enumerate(result['context']):
                current_line_num = result['context_start_line'] + j
                line_prefix = "> " if current_line_num == result['line'] else "  "
                output_lines.append(f"  {line_prefix}{current_line_num}: {context_line.rstrip()}")

            output_lines.append("")

        if max_results > 0 and result_count >= max_results:
            output_lines.append(f"（由于 max_results 限制，只显示前 {max_results} 个结果）")

        return "\n".join(output_lines)

    except ValueError as e:
        return f"安全错误：{e}"
    except Exception as e:
        return f"错误：{str(e)}"

def invoke_diff_file(file1: str, file2: str, output_format: str = "unified", context_lines: int = 3) -> str:
    """
    比较两个文件的差异，生成类似 Linux diff 命令的差异输出

    Args:
        file1: 第一个文件路径
        file2: 第二个文件路径
        output_format: 差异输出格式：unified（统一格式，默认）、context（上下文格式）、normal（普通格式）
        context_lines: 上下文行数（仅对 unified 和 context 格式有效），默认为 3

    Returns:
        str: 差异输出结果
    """
    try:
        target_file1 = sanitize_path(file1)
        target_file2 = sanitize_path(file2)

        if not target_file1.exists():
            return f"错误：文件 '{file1}' 不存在"
        if not target_file2.exists():
            return f"错误：文件 '{file2}' 不存在"

        if not target_file1.is_file():
            return f"错误：'{file1}' 不是文件"
        if not target_file2.is_file():
            return f"错误：'{file2}' 不是文件"

        with open(target_file1, 'r', encoding='utf-8') as f:
            lines1 = f.readlines()
        with open(target_file2, 'r', encoding='utf-8') as f:
            lines2 = f.readlines()

        diff_result = _compute_diff(lines1, lines2, output_format, context_lines)
        return diff_result

    except ValueError as e:
        return f"安全错误：{e}"
    except Exception as e:
        return f"错误：{str(e)}"


def _compute_diff(lines1, lines2, output_format, context_lines):
    """计算两个文件内容的差异"""
    import difflib

    if output_format == "unified":
        diff = difflib.unified_diff(
            lines1, lines2,
            fromfile='file1', tofile='file2',
            lineterm='', n=context_lines
        )
    elif output_format == "context":
        diff = difflib.context_diff(
            lines1, lines2,
            fromfile='file1', tofile='file2',
            lineterm='', n=context_lines
        )
    else:  # normal
        diff = difflib.ndiff(lines1, lines2)

    diff_lines = list(diff)

    if not diff_lines:
        return "文件 'file1' 和 'file2' 内容相同"

    return '\n'.join(diff_lines)


def invoke_patch_file(file_path: str, patch_content: str, backup: bool = True, reverse: bool = False) -> str:
    """
    将差异补丁应用到文件，类似于 Linux patch 命令的功能

    Args:
        file_path: 要应用补丁的文件路径
        patch_content: 补丁内容，可以是 unified diff 格式或其他支持的格式
        backup: 是否在应用补丁前创建备份文件，默认为 true
        reverse: 是否反向应用补丁（撤销补丁），默认为 false

    Returns:
        str: 补丁应用结果
    """
    try:
        target_file = sanitize_path(file_path)

        # 检查文件是否存在
        if not target_file.exists():
            return f"错误：文件 '{file_path}' 不存在"
        if not target_file.is_file():
            return f"错误：'{file_path}' 不是文件"

        # 创建备份文件
        backup_file = None
        if backup:
            backup_file = target_file.with_suffix(target_file.suffix + '.bak')
            import shutil
            shutil.copy2(target_file, backup_file)

        # 读取原始文件内容
        with open(target_file, 'r', encoding='utf-8') as f:
            original_content = f.read()

        # 应用补丁
        try:
            patched_content = _apply_patch(original_content, patch_content, reverse)
        except Exception as e:
            # 如果补丁应用失败，恢复备份
            if backup and backup_file and backup_file.exists():
                shutil.copy2(backup_file, target_file)
            return f"错误：补丁应用失败 - {str(e)}"

        # 写入补丁后的内容
        with open(target_file, 'w', encoding='utf-8') as f:
            f.write(patched_content)

        result = f"成功将补丁应用到文件 '{file_path}'"
        if backup:
            result += f"（已创建备份文件：{backup_file.name}）"

        return result

    except ValueError as e:
        return f"安全错误：{e}"
    except Exception as e:
        return f"错误：{str(e)}"


def _apply_patch(original_content, patch_content, reverse):
    """应用补丁到文件内容"""
    import difflib

    # 将原始内容分割为行
    original_lines = original_content.splitlines(keepends=True)

    # 解析补丁内容
    patch_lines = patch_content.splitlines(keepends=True)

    # 简单的补丁应用逻辑（仅支持 unified diff 格式）
    if patch_lines and patch_lines[0].startswith('---'):
        # 检测到 unified diff 格式
        return _apply_unified_patch(original_lines, patch_lines, reverse)
    else:
        # 对于其他格式，使用更通用的方法
        return _apply_generic_patch(original_content, patch_content, reverse)


def _apply_unified_patch(original_lines, patch_lines, reverse):
    """应用 unified diff 格式的补丁"""
    result_lines = original_lines.copy()

    i = 0
    while i < len(patch_lines):
        line = patch_lines[i]

        # 寻找补丁块开始
        if line.startswith('@@'):
            # 解析补丁头
            import re
            header_match = re.match(r'@@ -([0-9]+),?([0-9]*) \+([0-9]+),?([0-9]*) @@', line)
            if not header_match:
                i += 1
                continue

            old_start = int(header_match.group(1))
            old_count = int(header_match.group(2)) if header_match.group(2) else 1
            new_start = int(header_match.group(3))
            new_count = int(header_match.group(4)) if header_match.group(4) else 1

            i += 1

            # 处理补丁块
            old_index = old_start - 1
            patch_operations = []

            for j in range(i, min(i + old_count + new_count, len(patch_lines))):
                patch_line = patch_lines[j]
                if patch_line.startswith(' '):
                    # 未更改的行
                    patch_operations.append(('keep', patch_line[1:]))
                    old_index += 1
                elif patch_line.startswith('-'):
                    # 删除的行
                    patch_operations.append(('remove', patch_line[1:]))
                    old_index += 1
                elif patch_line.startswith('+'):
                    # 添加的行
                    patch_operations.append(('add', patch_line[1:]))
                else:
                    break

            # 应用补丁操作
            if reverse:
                # 反向应用：交换添加和删除操作
                for op, content in patch_operations:
                    if op == 'remove':
                        # 反向时：删除变为添加
                        result_lines.insert(old_start - 1, content)
                    elif op == 'add':
                        # 反向时：添加变为删除
                        # 找到并删除对应的行
                        for k in range(len(result_lines)):
                            if result_lines[k] == content:
                                del result_lines[k]
                                break
            else:
                # 正向应用补丁
                current_pos = old_start - 1
                for op, content in patch_operations:
                    if op == 'remove':
                        if current_pos < len(result_lines) and result_lines[current_pos] == content:
                            del result_lines[current_pos]
                        else:
                            raise ValueError(f"无法应用补丁：在第 {current_pos + 1} 行找不到要删除的内容")
                    elif op == 'add':
                        result_lines.insert(current_pos, content)
                        current_pos += 1
                    elif op == 'keep':
                        current_pos += 1

            i += len(patch_operations)
        else:
            i += 1

    return ''.join(result_lines)


def _apply_generic_patch(original_content, patch_content, reverse):
    """应用通用格式的补丁"""
    # 这是一个简化的实现，实际应用中可能需要更复杂的逻辑
    if reverse:
        # 对于反向补丁，我们尝试撤销更改
        # 这里使用简单的字符串替换作为回退方案
        lines = patch_content.splitlines()
        for line in lines:
            if line.startswith('-'):
                # 在反向模式中，删除行变为添加行
                content_to_add = line[1:]
                original_content = original_content.replace(content_to_add, '', 1)
            elif line.startswith('+'):
                # 在反向模式中，添加行变为删除行
                content_to_remove = line[1:]
                original_content = original_content.replace(content_to_remove, '', 1)
    else:
        # 正向应用补丁
        lines = patch_content.splitlines()
        for line in lines:
            if line.startswith('-'):
                # 删除行
                content_to_remove = line[1:]
                original_content = original_content.replace(content_to_remove, '', 1)
            elif line.startswith('+'):
                # 添加行
                content_to_add = line[1:]
                # 在文件末尾添加
                original_content += '\n' + content_to_add

    return original_content

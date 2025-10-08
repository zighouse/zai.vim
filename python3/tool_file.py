#!/usr/bin/env python3
"""
File toolbox —— 动态兼容层
所有导出函数统一加上 invoke_ 前缀，供 ToolManager.call_tool 路由
"""
import shutil
import os
import stat
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


def invoke_write_file(path: str, mode: str, content: str) -> str:
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


def invoke_copy_file(source: str, destination: str) -> str:
    """
    复制沙盒内的文件或目录到指定路径
    Args:
        source: 源文件或目录路径
        destination: 目标路径
    Returns:
        str: 操作结果信息字符串
    """
    try:
        # 使用现有的路径安全检查
        source_path = sanitize_path(source)
        dest_path = sanitize_path(destination)

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

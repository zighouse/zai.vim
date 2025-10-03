import shutil
import os
import stat
from appdirs import user_data_dir
from datetime import datetime
from pathlib import Path

def sandbox_home():
    zai_home = Path(user_data_dir("zai", "zighouse"))
    try:
        zai_home.mkdir(parents=True, exist_ok=True)
        return zai_home / "sandbox"
    except:
        return Path("sandbox")

def _sanitize_path(user_path):
    """将用户路径转换为沙盒内的安全路径"""
    if not user_path or user_path == "":
        return sandbox_home()

    # 解析路径并确保它在沙盒内
    sandbox_root = sandbox_home().resolve()
    target_path = (sandbox_root / user_path).resolve()

    # 安全检查：确保目标路径在沙盒根目录内
    if sandbox_root not in target_path.parents and target_path != sandbox_root:
        raise ValueError(f"路径 '{user_path}' 试图逃逸沙盒")

    return target_path

def ls(path=""):
    """列出沙盒内指定目录的内容，返回格式化的字符串"""
    try:
        target_dir = _sanitize_path(path)

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

def read_file(path):
    """读取沙盒内的文件内容"""
    try:
        target_file = _sanitize_path(path)

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

def write_file(path, content):
    """向沙盒内的文件写入内容"""
    try:
        target_file = _sanitize_path(path)

        # 确保父目录存在
        target_file.parent.mkdir(parents=True, exist_ok=True)

        with open(target_file, 'w', encoding='utf-8') as f:
            f.write(content)

        return f"成功写入文件 '{path}'"

    except ValueError as e:
        return f"安全错误：{e}"
    except Exception as e:
        return f"错误：{str(e)}"

def mkdir(path):
    """在沙盒内创建目录"""
    try:
        target_dir = _sanitize_path(path)

        if target_dir.exists():
            return f"错误：路径 '{path}' 已存在"

        target_dir.mkdir(parents=True, exist_ok=True)
        return f"成功创建目录 '{path}'"

    except ValueError as e:
        return f"安全错误：{e}"
    except Exception as e:
        return f"错误：{str(e)}"

def copy_file(source: str, destination: str) -> str:
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
        source_path = _sanitize_path(source)
        dest_path = _sanitize_path(destination)

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

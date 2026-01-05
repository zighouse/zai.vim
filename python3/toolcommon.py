#!/usr/bin/env python3
import os
import sys
import json
from pathlib import Path
from typing import Dict, Any, List, Optional, Union
from appdirs import user_data_dir

# YAML support
try:
    import yaml
    HAVE_YAML = True
except ImportError:
    HAVE_YAML = False
    print(f"PyYAML not available, you should `pip install PyYAML`", file=sys.stderr)

# 导入 config 模块中的注释剥离函数
try:
    from config import _strip_comments
except ImportError:
    # 如果 config 模块不可用，实现一个简化版本
    import re
    # json strings
    _STRING_RE = re.compile(r'"(?:\\["\\/bfnrt]|\\u[0-9a-fA-F]{4}|[^"\\])*"')
    # json comments
    _COMMENT_RE = re.compile(r'//[^\n]*|/\*.*?\*/', re.S)
    
    def _strip_comments(text: str) -> str:
        str_list: List[str] = []
        def placeholder(_m):
            str_list.append(_m.group(0))
            return f'\x00__STR_{len(str_list)-1}__\x00'
        masked = _STRING_RE.sub(placeholder, text)
        cleaned = _COMMENT_RE.sub('', masked)
        for idx, s in enumerate(str_list):
            cleaned = cleaned.replace(f'\x00__STR_{idx}__\x00', s)
        return cleaned

# 默认沙盒路径
_sandbox_home = None
_sandbox_home_printed = False

# 项目配置缓存
_project_config_cache: Dict[str, Optional[List[Dict[str, Any]]]] = {}

def set_sandbox_home(new_path: str):
    """
    设置新的沙盒根目录路径

    Args:
        new_path: 新的沙盒根目录路径
    """
    global _sandbox_home

    if not new_path or not isinstance(new_path, str):
        raise ValueError("沙盒路径必须是有效的字符串")

    # 创建路径对象并确保目录存在
    new_sandbox_path = Path(new_path).resolve()

    try:
        new_sandbox_path.mkdir(parents=True, exist_ok=True)
        _sandbox_home = new_sandbox_path
        _sandbox_home_printed = False
        return _sandbox_home
    except Exception as e:
        raise ValueError(f"无法创建沙盒目录 '{new_path}': {e}")


def _find_project_config_file(start_path: Optional[Union[str, Path]] = None) -> Optional[Path]:
    """
    从指定路径开始向上遍历目录树，查找 zai.project/zai_project.yaml 文件。
    为了兼容性，也支持旧格式的 zai_project.yaml 文件。
    
    Args:
        start_path: 起始路径（默认为当前工作目录）
    
    Returns:
        找到的配置文件路径，如果未找到则返回 None
    """
    if start_path is None:
        start_path = os.getcwd()
    current = Path(start_path).resolve()
    
    # 如果 start_path 是文件，则从其所在目录开始查找
    if current.is_file():
        current = current.parent
    
    # 向上遍历目录树
    while True:
        # 优先检查新格式：zai.project/zai_project.yaml
        new_format_file = current / "zai.project" / "zai_project.yaml"
        if new_format_file.is_file():
            return new_format_file
        
        # 为了兼容性，检查旧格式：zai_project.yaml
        old_format_file = current / "zai_project.yaml"
        if old_format_file.is_file() and current.name != "zai.project":
            print(f"警告: 使用旧格式配置文件 {old_format_file}，建议迁移到 zai.project/zai_project.yaml", file=sys.stderr)
            return old_format_file
        
        # 到达根目录时停止
        parent = current.parent
        if parent == current:
            break
        current = parent
    
    return None


def load_project_config(config_file: Optional[Union[str, Path]] = None) -> Optional[List[Dict[str, Any]]]:
    """
    加载项目配置文件（仅支持 YAML 格式）。
    
    Args:
        config_file: 配置文件路径。如果为 None，则从当前工作目录向上查找。
    
    Returns:
        配置对象列表，如果未找到或解析失败则返回 None
    """
    if config_file is None:
        config_file = _find_project_config_file()
        if config_file is None:
            return None
    else:
        config_file = Path(config_file)
        if not config_file.is_file():
            return None
    
    config_file_str = str(config_file)
    
    # 检查缓存
    if config_file_str in _project_config_cache:
        return _project_config_cache[config_file_str]
    
    try:
        with open(config_file, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # 只支持 YAML 格式
        if config_file.suffix.lower() not in ('.yaml', '.yml'):
            print(f"错误：只支持 YAML 格式配置文件，不支持 {config_file.suffix} 格式", file=sys.stderr)
            _project_config_cache[config_file_str] = None
            return None
        
        # 解析 YAML
        try:
            import yaml
            config_data = yaml.safe_load(content)
            print(f"已加载项目配置：{config_file}", file=sys.stderr)
        except ImportError:
            print(f"错误：需要 PyYAML 库来解析 YAML 文件 {config_file}", file=sys.stderr)
            _project_config_cache[config_file_str] = None
            return None
        
        # 验证配置格式：应该是一个列表
        if not isinstance(config_data, list):
            print(f"警告：配置文件应为列表，实际类型为 {type(config_data)}", file=sys.stderr)
            # 尝试包装为列表
            config_data = [config_data]
        
        # 验证列表中的每个元素都是字典
        for i, item in enumerate(config_data):
            if not isinstance(item, dict):
                print(f"警告：配置项 {i} 应为字典，实际类型为 {type(item)}，已跳过", file=sys.stderr)
        
        # 只保留字典项
        config_data = [item for item in config_data if isinstance(item, dict)]
        
        if config_data:
            print(f"  找到 {len(config_data)} 个配置项", file=sys.stderr)
            # 打印第一项摘要
            first = config_data[0]
            if 'sandbox_home' in first:
                print(f"  沙盒目录：{first['sandbox_home']}", file=sys.stderr)
            if 'shell_container' in first:
                print(f"  容器配置：{first['shell_container'].get('image', 'unknown')}", file=sys.stderr)
        
        # 缓存结果
        _project_config_cache[config_file_str] = config_data
        return config_data
    
    except yaml.YAMLError as e:
        print(f"错误：无法解析 YAML 配置文件 {config_file}: {e}", file=sys.stderr)
        _project_config_cache[config_file_str] = None
        return None
    except Exception as e:
        print(f"错误：读取配置文件 {config_file} 时发生错误: {e}", file=sys.stderr)
        _project_config_cache[config_file_str] = None
        return None


def get_project_config(cwd: Optional[Union[str, Path]] = None) -> Optional[Dict[str, Any]]:
    """
    获取当前工作目录对应的项目配置（返回第一个配置项）。
    
    Args:
        cwd: 当前工作目录。如果为 None，则使用 os.getcwd()。
    
    Returns:
        第一个配置项字典，如果未找到配置则返回 None。
    """
    config_list = load_project_config()
    if not config_list:
        return None
    # 返回第一个配置项
    return config_list[0]

def sandbox_home(cwd: Optional[Union[str, Path]] = None) -> Path:
    """
    获取当前沙盒根目录。
    
    优先使用项目配置中的 sandbox_home，否则使用自定义设置或默认路径。
    
    Args:
        cwd: 当前工作目录，用于查找项目配置。如果为 None，则使用 os.getcwd()。
    
    Returns:
        沙盒根目录路径
    """
    global _sandbox_home, _sandbox_home_printed
    
    # 如果已经设置了自定义沙盒路径，直接返回
    if _sandbox_home is not None:
        if not _sandbox_home_printed:
            print(f"使用命令指定的沙盒目录：{_sandbox_home}", file=sys.stderr)
            _sandbox_home_printed = True
        return _sandbox_home
    
    # 尝试获取项目配置
    try:
        config = get_project_config(cwd)
        if config and 'sandbox_home' in config:
            sandbox_path = Path(config['sandbox_home']).resolve()
            # 确保目录存在
            sandbox_path.mkdir(parents=True, exist_ok=True)
            if not _sandbox_home_printed:
                print(f"使用项目配置的沙盒目录：{sandbox_path}", file=sys.stderr)
                _sandbox_home_printed = True
            return sandbox_path
    except Exception as e:
        print(f"警告：无法从项目配置获取沙盒目录：{e}", file=sys.stderr)
    
    # 否则使用默认路径
    zai_home = Path(user_data_dir("zai", "zighouse"))
    try:
        zai_home.mkdir(parents=True, exist_ok=True)
        return zai_home / "sandbox"
    except:
        return Path("sandbox")


def sanitize_path(user_path: str = "", cwd: Optional[Union[str, Path]] = None):
    """
    将用户路径转换为沙盒内的安全路径。
    
    Args:
        user_path: 用户提供的路径（相对或绝对）
        cwd: 当前工作目录，用于沙盒目录查找。如果为 None，则使用 os.getcwd()。
    
    Returns:
        沙盒内的绝对路径
    """
    if not user_path or user_path == "":
        return sandbox_home(cwd)

    # 解析路径并确保它在沙盒内
    sandbox_root = sandbox_home(cwd).resolve()
    target_path = (sandbox_root / user_path).resolve()

    # 安全检查：确保目标路径在沙盒根目录内
    if sandbox_root not in target_path.parents and target_path != sandbox_root:
        raise ValueError(f"路径 '{user_path}' 试图逃逸沙盒")

    return target_path

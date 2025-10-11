#!/usr/bin/env python3
from appdirs import user_data_dir
from pathlib import Path

# 默认沙盒路径
_sandbox_home = None

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
        return _sandbox_home
    except Exception as e:
        raise ValueError(f"无法创建沙盒目录 '{new_path}': {e}")

def sandbox_home() -> Path:
    """获取当前沙盒根目录"""
    global _sandbox_home

    # 如果已经设置了自定义沙盒路径，直接返回
    if _sandbox_home is not None:
        return _sandbox_home

    # 否则使用默认路径
    zai_home = Path(user_data_dir("zai", "zighouse"))
    try:
        zai_home.mkdir(parents=True, exist_ok=True)
        return zai_home / "sandbox"
    except:
        return Path("sandbox")

def sanitize_path(user_path: str = ""):
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

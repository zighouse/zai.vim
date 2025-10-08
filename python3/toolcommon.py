#!/usr/bin/env python3
from appdirs import user_data_dir
from pathlib import Path

def sandbox_home():
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

#!/usr/bin/env python3
import json
import re
from pathlib import Path
from typing import List, Any, Union
from appdirs import user_data_dir

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

def _normalize_keys(obj: Any) -> Any:
    """filter keys and normalize `-` as `_`"""
    if isinstance(obj, list):
        return [_normalize_keys(item) for item in obj]
    elif isinstance(obj, dict):
        normalized = {}
        for key, value in obj.items():
            # 将键名中的连字符转换为下划线
            normalized_key = key.replace('-', '_') if isinstance(key, str) else key
            normalized[normalized_key] = _normalize_keys(value)
        return normalized
    else:
        return obj

def load_config(conf_path: str):
    try:
        with open(conf_path, "r", encoding="utf-8") as f:
            config_data = json.loads(_strip_comments(f.read()))
            return _normalize_keys(config_data)
    except Exception as e:
        print(f'load config error: {e}')
        return []

def config_path_assistants() -> str:
    conf_dir = Path(user_data_dir("zai", "zighouse"))
    try:
        conf_dir.mkdir(parents=True, exist_ok=True)
        return conf_dir / "assistants.json"
    except:
        return "assistants.json"

def load_assistants():
    return load_config(config_path_assistants())

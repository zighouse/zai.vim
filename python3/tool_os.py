#!/usr/bin/env python3
"""
OS工具集 - 提供系统相关的信息获取功能
"""

import os
import sys
import json
import platform
import datetime
import locale
import time
from typing import Dict, Any, Optional


def get_date_info(format_type: str = "all") -> Dict[str, Any]:
    """
    获取日期和时间信息

    Args:
        format_type: 日期格式类型
            - "date_only": 仅日期
            - "datetime": 日期加时间
            - "utc": UTC时间
            - "timestamp": 时间戳
            - "all": 所有信息

    Returns:
        包含日期时间信息的字典
    """
    now = datetime.datetime.now()
    utc_now = datetime.datetime.utcnow()

    result = {}

    if format_type in ["date_only", "all"]:
        result["current_date"] = now.strftime("%Y-%m-%d")
        result["current_date_cn"] = now.strftime("%Y年%m月%d日")

    if format_type in ["datetime", "all"]:
        result["current_datetime"] = now.strftime("%Y-%m-%d %H:%M:%S")
        result["current_datetime_cn"] = now.strftime("%Y年%m月%d日 %H时%M分%S秒")

    if format_type in ["utc", "all"]:
        result["utc_datetime"] = utc_now.strftime("%Y-%m-%d %H:%M:%S UTC")

    if format_type in ["timestamp", "all"]:
        result["timestamp"] = int(time.time())
        result["timestamp_millis"] = int(time.time() * 1000)

    if format_type == "all":
        result["timezone"] = time.tzname[0] if time.daylight else time.tzname[1]
        result["day_of_week"] = now.strftime("%A")
        result["day_of_week_cn"] = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"][now.weekday()]

    return result


def get_locale_info() -> Dict[str, Any]:
    """
    获取系统语言和区域设置信息

    Returns:
        包含语言区域信息的字典
    """
    try:
        lang, encoding = locale.getdefaultlocale()
    except:
        lang, encoding = None, None

    result = {
        "system_language": lang or "未知",
        "encoding": encoding or "未知",
        "default_encoding": sys.getdefaultencoding(),
        "filesystem_encoding": sys.getfilesystemencoding()
    }

    return result


def get_os_version_info() -> Dict[str, Any]:
    """
    获取操作系统版本信息

    Returns:
        包含操作系统信息的字典
    """
    system_info = platform.uname()

    result = {
        "system": system_info.system,
        "node": system_info.node,
        "release": system_info.release,
        "version": system_info.version,
        "machine": system_info.machine,
        "processor": system_info.processor,
        "platform": platform.platform(),
        "python_version": platform.python_version(),
        "python_implementation": platform.python_implementation()
    }

    # 系统特定信息
    if platform.system() == "Windows":
        result["windows_version"] = platform.win32_ver()
    elif platform.system() == "Linux":
        import distro
        # 使用推荐的distro方法替代过时的linux_distribution()
        result["linux_distribution"] = {
            "id": distro.id(),
            "name": distro.name(),
            "version": distro.version(),
            "codename": distro.codename(),
            "like": distro.like(),
            "info": distro.info()
        }
    elif platform.system() == "Darwin":
        result["mac_version"] = platform.mac_ver()

    return result


def os_tools(action: str, format: str = "all") -> Dict[str, Any]:
    """
    OS工具集主函数

    Args:
        action: 要执行的操作类型
        format: 日期格式（仅适用于get_date操作）

    Returns:
        包含请求信息的字典
    """
    try:
        if action == "get_date":
            return get_date_info(format)
        elif action == "get_locale":
            return get_locale_info()
        elif action == "get_os_version":
            return get_os_version_info()
        else:
            return {"error": f"未知操作: {action}"}
    except Exception as e:
        return {"error": f"执行操作时出错: {str(e)}"}


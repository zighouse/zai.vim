# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
Session management for zai.vim - JSONL-based session persistence

This module provides SessionWriter for real-time session persistence in JSONL format.
Each line in the session file is a complete JSON object, making it crash-safe and
suitable for append-only writes.

Session data is stored in:
    ~/.local/share/zai/sessions/<sanitized-project-path>/<sessionId>.jsonl

The JSONL format is machine-readable and complementary to the Markdown audit logs
produced by Logger. Both systems run in parallel.
"""

import copy
import hashlib
import json
import os
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, Optional

from appdirs import user_data_dir


# 默认配置
_DEFAULT_MAX_CONTENT_SIZE = 10 * 1024 * 1024  # 10MB


def sanitize_path(path: str, max_length: int = 200) -> str:
    """
    将项目路径转为安全目录名

    规则:
    1. / 替换为 -
    2. 去除前导 -
    3. 超过 max_length 时截断并追加 sha256[:8] 后缀

    Args:
        path: 项目绝对路径
        max_length: 最大长度，默认 200

    Returns:
        安全的目录名字符串

    Examples:
        >>> sanitize_path("/usr/local/myproject")
        'usr-local-myproject'
        >>> # 超长路径会被截断并追加 hash
        >>> long_path = "/a/" + "x" * 300)
        >>> result = sanitize_path(long_path)
        >>> result.endswith('-' + hashlib.sha256(long_path.encode()).hexdigest()[:8])
        True
    """
    # 替换 / 为 -
    sanitized = path.replace('/', '-')

    # 去除前导 -
    if sanitized.startswith('-'):
        sanitized = sanitized[1:]

    # 处理长度超限
    if len(sanitized) > max_length:
        # 计算原始路径的 hash
        path_hash = hashlib.sha256(path.encode('utf-8')).hexdigest()[:8]
        # 截断并追加 hash
        sanitized = sanitized[:max_length - 9] + '-' + path_hash

    return sanitized


class SessionWriter:
    """
    JSONL 格式的会话实时持久化

    每条消息立即写入磁盘，保证崩溃安全。与 Logger（Markdown 审计日志）并行运行。

    JSONL 消息格式:
        {"type":"user","content":"...","uuid":"...","timestamp":"...","tokens":123}
        {"type":"assistant","content":"...","tool_calls":[...],"uuid":"...","parentUuid":"...","timestamp":"...","tokens":456}
        {"type":"tool_result","tool_call_id":"...","name":"...","content":"...","uuid":"...","timestamp":"..."}
        {"type":"metadata","key":"title","value":"...","uuid":"...","timestamp":"..."}
        {"type":"compact_boundary","summary":"...","archived_rounds":10,"tokens_before":50000,"tokens_after":2000,"timestamp":"..."}
    """

    def __init__(self, project_path: Optional[str] = None, max_content_size: int = _DEFAULT_MAX_CONTENT_SIZE):
        """
        初始化 SessionWriter

        Args:
            project_path: 项目根路径，用于按项目隔离会话文件。
                          如果为 None，使用 os.getcwd()。
            max_content_size: 单个消息内容的最大字节数，超过将被截断。
        """
        self._session_id: str = ""
        self._session_path: Optional[Path] = None
        self._file = None
        self._project_path: str = project_path or os.getcwd()
        self._max_content_size = max_content_size
        self._last_user_uuid: str = ""  # 用于构建 parentUuid 链
        self._write_failures: int = 0   # 写入失败计数

    def _get_sessions_dir(self) -> Path:
        """
        返回会话存储目录

        Returns:
            ~/.local/share/zai/sessions/<sanitized-project-path>/
        """
        base_dir = Path(user_data_dir("zai", "zighouse")) / "sessions"
        project_dir_name = sanitize_path(self._project_path)
        session_dir = base_dir / project_dir_name
        session_dir.mkdir(parents=True, exist_ok=True)
        return session_dir

    def _get_session_path(self, session_id: str) -> Path:
        """
        获取指定会话 ID 的文件路径

        Args:
            session_id: 会话 ID (YYYYMMDD_HHMMSS)

        Returns:
            完整的会话文件路径
        """
        return self._get_sessions_dir() / f"{session_id}.jsonl"

    def _generate_uuid(self) -> str:
        """
        生成 UUID4 字符串

        Returns:
            UUID4 字符串（无连字符）
        """
        return uuid.uuid4().hex

    def _truncate_content(self, content: str) -> str:
        """
        截断过长的内容

        Args:
            content: 原始内容

        Returns:
            截断后的内容（如果超过限制）
        """
        if len(content.encode('utf-8')) > self._max_content_size:
            truncated = content.encode('utf-8')[:self._max_content_size].decode('utf-8', errors='ignore')
            return truncated + "\n\n[... Content truncated due to size limit ...]"
        return content

    def _write_entry(self, entry: Dict[str, Any]) -> bool:
        """
        将 JSON 条目写入文件（一行），立即 flush

        Args:
            entry: 要写入的字典

        Returns:
            bool: 写入是否成功
        """
        if self._file is None:
            return False

        try:
            line = json.dumps(entry, ensure_ascii=False)
            self._file.write(line + '\n')
            self._file.flush()
            return True
        except (IOError, OSError) as e:
            self._write_failures += 1
            print(f"[SessionWriter] Warning: Failed to write entry: {e}", file=sys.stderr)
            return False

    def open(self, session_id: Optional[str] = None) -> bool:
        """
        创建新会话或打开已有会话

        Args:
            session_id: 会话 ID (YYYYMMDD_HHMMSS)，为 None 则生成新的

        Returns:
            bool: 是否成功打开
        """
        # 先关闭已打开的文件（防止句柄泄漏）
        self.close()

        if session_id:
            self._session_id = session_id
        else:
            self._session_id = datetime.now().strftime("%Y%m%d_%H%M%S")

        self._session_path = self._get_session_path(self._session_id)
        self._last_user_uuid = ""  # 重置 parentUuid 链
        self._write_failures = 0   # 重置失败计数

        try:
            # 以追加模式打开，支持恢复已有会话
            self._file = open(self._session_path, 'a', encoding='utf-8')
            return True
        except (IOError, OSError) as e:
            print(f"[SessionWriter] Failed to open session file: {e}", file=sys.stderr)
            self._file = None
            return False

    def close(self):
        """
        关闭文件句柄，flush 缓冲
        """
        if self._file:
            try:
                self._file.flush()
                self._file.close()
            except (IOError, OSError):
                pass
            self._file = None

    def is_open(self) -> bool:
        """
        检查会话是否已打开

        Returns:
            bool: 会话文件是否已成功打开
        """
        return self._file is not None

    def get_session_id(self) -> str:
        """
        返回当前 session_id

        Returns:
            当前会话 ID
        """
        return self._session_id

    def get_session_path(self) -> Optional[str]:
        """
        返回当前会话文件路径

        Returns:
            当前会话文件的绝对路径，如果未打开则返回 None
        """
        if self._session_path:
            return str(self._session_path.absolute())
        return None

    def get_write_failures(self) -> int:
        """
        获取写入失败次数

        Returns:
            累计的写入失败次数
        """
        return self._write_failures

    def _get_timestamp(self) -> str:
        """
        获取当前 ISO 8601 时间戳

        Returns:
            ISO 8601 格式的时间字符串
        """
        return datetime.utcnow().isoformat() + 'Z'

    def append_user_message(self, content: str, tokens: int = 0) -> str:
        """
        追加用户消息

        Args:
            content: 消息内容
            tokens: 消息的 token 数（可选）

        Returns:
            生成的 UUID，如果写入失败则返回空字符串
        """
        msg_uuid = self._generate_uuid()
        entry = {
            "type": "user",
            "content": self._truncate_content(content),
            "uuid": msg_uuid,
            "timestamp": self._get_timestamp()
        }
        if tokens > 0:
            entry["tokens"] = tokens

        if self._write_entry(entry):
            self._last_user_uuid = msg_uuid  # 更新 parentUuid 链
            return msg_uuid
        return ""

    def append_assistant_message(self,
                                  content: str,
                                  tool_calls: Optional[list] = None,
                                  tokens: int = 0,
                                  reasoning_tokens: int = 0) -> str:
        """
        追加助手消息

        Args:
            content: 消息内容
            tool_calls: 工具调用列表（可选）
            tokens: 消息的 token 数（可选）
            reasoning_tokens: 推理 token 数（可选）

        Returns:
            生成的 UUID，如果写入失败则返回空字符串
        """
        msg_uuid = self._generate_uuid()
        entry = {
            "type": "assistant",
            "content": self._truncate_content(content),
            "uuid": msg_uuid,
            "timestamp": self._get_timestamp()
        }
        # 添加 parentUuid 用于构建对话链
        if self._last_user_uuid:
            entry["parentUuid"] = self._last_user_uuid

        if tool_calls:
            # 深拷贝防止外部修改影响已写入的数据
            entry["tool_calls"] = copy.deepcopy(tool_calls)
        if tokens > 0:
            entry["tokens"] = tokens
        if reasoning_tokens > 0:
            entry["reasoning_tokens"] = reasoning_tokens

        if self._write_entry(entry):
            return msg_uuid
        return ""

    def append_tool_result(self, tool_call_id: str, name: str, content: str) -> str:
        """
        追加工具结果

        Args:
            tool_call_id: 工具调用 ID
            name: 工具名称
            content: 工具返回内容

        Returns:
            生成的 UUID，如果写入失败则返回空字符串
        """
        msg_uuid = self._generate_uuid()
        entry = {
            "type": "tool_result",
            "tool_call_id": tool_call_id,
            "name": name,
            "content": self._truncate_content(content),
            "uuid": msg_uuid,
            "timestamp": self._get_timestamp()
        }

        if self._write_entry(entry):
            return msg_uuid
        return ""

    def append_metadata(self, key: str, value: str) -> str:
        """
        追加元数据条目

        Args:
            key: 元数据键（如 'title', 'tag', 'model'）
            value: 元数据值

        Returns:
            生成的 UUID，如果写入失败则返回空字符串
        """
        msg_uuid = self._generate_uuid()
        entry = {
            "type": "metadata",
            "key": key,
            "value": value,
            "uuid": msg_uuid,
            "timestamp": self._get_timestamp()
        }

        if self._write_entry(entry):
            return msg_uuid
        return ""

    def append_compact_boundary(self,
                                 summary: str,
                                 archived_rounds: int,
                                 tokens_before: int,
                                 tokens_after: int) -> str:
        """
        追加压缩边界标记

        Args:
            summary: 压缩后的摘要内容
            archived_rounds: 归档的轮次数
            tokens_before: 压缩前的 token 数
            tokens_after: 压缩后的 token 数

        Returns:
            生成的 UUID，如果写入失败则返回空字符串
        """
        msg_uuid = self._generate_uuid()
        entry = {
            "type": "compact_boundary",
            "summary": self._truncate_content(summary),
            "archived_rounds": archived_rounds,
            "tokens_before": tokens_before,
            "tokens_after": tokens_after,
            "uuid": msg_uuid,
            "timestamp": self._get_timestamp()
        }

        if self._write_entry(entry):
            return msg_uuid
        return ""

    def __del__(self):
        """
        析构时关闭文件
        """
        self.close()

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


def get_sessions_dir(project_path: Optional[str] = None) -> Path:
    """
    返回会话存储目录

    Args:
        project_path: 项目根路径，用于按项目隔离。
                      如果为 None，使用 os.getcwd()。

    Returns:
        ~/.local/share/zai/sessions/<sanitized-project-path>/
    """
    path = project_path or os.getcwd()
    base_dir = Path(user_data_dir("zai", "zighouse")) / "sessions"
    project_dir_name = sanitize_path(path)
    session_dir = base_dir / project_dir_name
    session_dir.mkdir(parents=True, exist_ok=True)
    return session_dir


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
        return get_sessions_dir(self._project_path)

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


class SessionLoader:
    """
    JSONL 会话恢复加载器

    从 SessionWriter 写入的 JSONL 文件中加载会话数据，
    重建 aichat.py 的 _history round 结构。

    支持渐进式加载大文件（>5MB），只读取元数据和最近的对话。
    """

    PROGRESSIVE_LOAD_THRESHOLD = 5 * 1024 * 1024  # 5MB
    PROGRESSIVE_HEAD_SIZE = 64 * 1024  # 64KB
    PROGRESSIVE_TAIL_SIZE = 64 * 1024  # 64KB

    def __init__(self, project_path: Optional[str] = None):
        """
        初始化 SessionLoader

        Args:
            project_path: 项目根路径，用于定位会话目录。
                          如果为 None，使用 os.getcwd()。
        """
        self._project_path: str = project_path or os.getcwd()

    def _get_sessions_dir(self, project_path: Optional[str] = None) -> Path:
        """
        返回会话存储目录

        Args:
            project_path: 项目路径，默认使用 self._project_path

        Returns:
            ~/.local/share/zai/sessions/<sanitized-project-path>/
        """
        return get_sessions_dir(project_path or self._project_path)

    def _get_session_path(self, session_id: str, project_path: Optional[str] = None) -> Path:
        """
        获取指定会话 ID 的文件路径

        Args:
            session_id: 会话 ID (YYYYMMDD_HHMMSS)
            project_path: 项目路径，默认使用 self._project_path

        Returns:
            完整的会话文件路径
        """
        return self._get_sessions_dir(project_path) / f"{session_id}.jsonl"

    @staticmethod
    def _safe_parse_json(line: str) -> Optional[Dict[str, Any]]:
        """
        安全解析单行 JSON

        Args:
            line: 单行 JSON 字符串

        Returns:
            解析后的字典，解析失败返回 None
        """
        line = line.strip()
        if not line:
            return None
        try:
            return json.loads(line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def _rebuild_history(self, messages: list) -> list:
        """
        将扁平的消息列表重建为 round 结构

        按照 user 消息分轮：每条 user 消息开始一个新 round，
        后续的 assistant/tool_result 消息归入该 round 的 response。

        Args:
            messages: 按时间顺序排列的消息列表

        Returns:
            _history 格式的 round 列表
        """
        history = []
        current_round = None

        for msg in messages:
            msg_type = msg.get('type')

            if msg_type == 'user':
                # 保存上一个 round
                if current_round is not None:
                    history.append(current_round)
                # 开始新 round
                current_round = {
                    "request": {"role": "user", "content": msg["content"]},
                    "response": []
                }
                if msg.get("tokens"):
                    current_round["request"]["content_tokens"] = msg["tokens"]

            elif msg_type == 'assistant':
                if current_round is None:
                    current_round = {"request": None, "response": []}
                asst_msg = {"role": "assistant", "content": msg["content"]}
                if msg.get("tool_calls"):
                    asst_msg["tool_calls"] = msg["tool_calls"]
                if msg.get("tokens"):
                    asst_msg["content_tokens"] = msg["tokens"]
                if msg.get("reasoning_tokens"):
                    asst_msg["reasoning_tokens"] = msg["reasoning_tokens"]
                current_round["response"].append(asst_msg)

            elif msg_type == 'tool_result':
                if current_round is None:
                    current_round = {"request": None, "response": []}
                tool_msg = {
                    "role": "tool",
                    "tool_call_id": msg["tool_call_id"],
                    "name": msg["name"],
                    "content": msg["content"]
                }
                current_round["response"].append(tool_msg)

            # metadata 和 compact_boundary 不直接进入 round

        # 保存最后一个 round
        if current_round is not None:
            history.append(current_round)

        return history

    def _build_compact_round(self, boundary: Dict[str, Any]) -> Dict[str, Any]:
        """
        从 compact_boundary 条目构建 summary round

        Args:
            boundary: compact_boundary 类型的 JSONL 条目

        Returns:
            summary round 字典
        """
        return {
            "request": {
                "role": "system",
                "content": "<compact summary>\n" + boundary.get("summary", "")
            },
            "response": [],
            "summary": True,
            "archived_rounds": boundary.get("archived_rounds", 0),
            "tokens_before": boundary.get("tokens_before", 0),
            "tokens_after": boundary.get("tokens_after", 0)
        }

    def _progressive_load(self, file_path: Path):
        """
        渐进式加载大文件

        只读取文件头部和尾部，获取 metadata 和最近的对话内容。

        Args:
            file_path: JSONL 文件路径

        Returns:
            (messages, metadata, compact_boundary) 元组
        """
        file_size = file_path.stat().st_size
        metadata = {}

        # 1. 读取头部 metadata（使用二进制模式避免 UTF-8 seek 问题）
        head_bytes = min(self.PROGRESSIVE_HEAD_SIZE, file_size)
        with open(file_path, 'rb') as f:
            head_data = f.read(head_bytes).decode('utf-8', errors='ignore')
        for line in head_data.split('\n'):
            entry = self._safe_parse_json(line)
            if entry and entry.get('type') == 'metadata':
                metadata[entry['key']] = entry['value']

        # 2. 读取尾部内容（二进制模式安全 seek）
        tail_bytes = min(self.PROGRESSIVE_TAIL_SIZE, file_size)
        with open(file_path, 'rb') as f:
            seek_pos = max(0, file_size - tail_bytes)
            f.seek(seek_pos)
            raw_tail = f.read()
            tail_data = raw_tail.decode('utf-8', errors='ignore')
            # 如果不是从文件开头读取，丢弃第一个不完整的行
            if seek_pos > 0:
                newline_pos = tail_data.find('\n')
                if newline_pos >= 0:
                    tail_data = tail_data[newline_pos + 1:]

        # 3. 解析尾部消息
        messages = []
        compact_boundary = None
        for line in tail_data.split('\n'):
            entry = self._safe_parse_json(line)
            if not entry:
                continue
            if entry.get('type') == 'metadata':
                metadata[entry['key']] = entry['value']
            elif entry.get('type') == 'compact_boundary':
                compact_boundary = entry
            else:
                messages.append(entry)

        return messages, metadata, compact_boundary

    def _scan_session_stats(self, file_path: Path) -> Dict[str, Any]:
        """
        扫描会话文件获取统计信息

        逐行读取文件，统计轮数、token 数、metadata 等。

        Args:
            file_path: JSONL 文件路径

        Returns:
            统计信息字典
        """
        stats = {
            "rounds": 0,
            "total_tokens": 0,
            "metadata": {},
            "compact_boundaries": []
        }

        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                for line in f:
                    entry = self._safe_parse_json(line)
                    if not entry:
                        continue

                    entry_type = entry.get('type')
                    if entry_type == 'user':
                        stats["rounds"] += 1
                        stats["total_tokens"] += entry.get("tokens", 0)
                    elif entry_type == 'assistant':
                        stats["total_tokens"] += entry.get("tokens", 0)
                        stats["total_tokens"] += entry.get("reasoning_tokens", 0)
                    elif entry_type == 'metadata':
                        stats["metadata"][entry['key']] = entry['value']
                    elif entry_type == 'compact_boundary':
                        stats["compact_boundaries"].append(entry)
        except (IOError, OSError):
            pass

        return stats

    def load_session(self, session_id: str, progressive: bool = False) -> list:
        """
        加载指定会话并重建 _history round 结构

        Args:
            session_id: 会话 ID (YYYYMMDD_HHMMSS 格式)
            progressive: 是否启用渐进式加载

        Returns:
            _history 列表: [{"request": msg, "response": [msgs]}, ...]

        Raises:
            FileNotFoundError: 会话文件不存在
            ValueError: JSONL 文件格式损坏
        """
        file_path = self._get_session_path(session_id)

        if not file_path.exists():
            raise FileNotFoundError(f"Session file not found: {file_path}")

        file_size = file_path.stat().st_size

        # 空文件
        if file_size == 0:
            return []

        # 判断是否使用渐进式加载
        use_progressive = progressive or file_size > self.PROGRESSIVE_LOAD_THRESHOLD

        if use_progressive:
            messages, metadata, compact_boundary = self._progressive_load(file_path)
            history = self._rebuild_history(messages)
            if compact_boundary:
                compact_round = self._build_compact_round(compact_boundary)
                history.insert(0, compact_round)
            return history

        # 完整加载
        messages = []
        boundaries = []  # [(index_in_messages, boundary_entry), ...]
        parsed_any = False

        with open(file_path, 'r', encoding='utf-8') as f:
            for line in f:
                entry = self._safe_parse_json(line)
                if not entry:
                    continue
                parsed_any = True

                entry_type = entry.get('type')
                if entry_type == 'compact_boundary':
                    boundaries.append((len(messages), entry))
                elif entry_type in ('user', 'assistant', 'tool_result'):
                    messages.append(entry)
                # metadata 不进入消息列表

        if not parsed_any:
            raise ValueError(f"All lines in session file are corrupt: {file_path}")

        # 处理 compact_boundary：只保留最后一个 boundary 之后的消息
        # 并将所有 boundary 的 summary 合并为一个 summary round
        if boundaries:
            last_idx, last_boundary = boundaries[-1]
            messages_after = messages[last_idx:]
            # 合并所有 boundary 的 summary（最早的在前）
            combined_summary = "\n\n".join(
                b.get("summary", "") for _, b in boundaries if b.get("summary")
            )
            combined_boundary = {
                "summary": combined_summary,
                "archived_rounds": sum(b.get("archived_rounds", 0) for _, b in boundaries),
                "tokens_before": last_boundary.get("tokens_before", 0),
                "tokens_after": last_boundary.get("tokens_after", 0),
            }
            compact_round = self._build_compact_round(combined_boundary)
            history = self._rebuild_history(messages_after)
            history.insert(0, compact_round)
        else:
            history = self._rebuild_history(messages)

        return history

    def list_sessions(self, project_path: Optional[str] = None) -> list:
        """
        列出指定项目的所有会话

        Args:
            project_path: 项目路径，如果为 None 使用初始化时的路径

        Returns:
            会话摘要列表，按时间倒序排列
        """
        sessions_dir = self._get_sessions_dir(project_path)

        if not sessions_dir.exists():
            return []

        sessions = []
        for jsonl_file in sorted(sessions_dir.glob("*.jsonl"), reverse=True):
            session_id = jsonl_file.stem
            file_size = jsonl_file.stat().st_size

            # 快速摘要：只读取头部获取 metadata + 统计行数
            # 避免逐行扫描所有内容
            stats = self._quick_stats(jsonl_file)

            # 从文件名解析创建时间
            created_at = ""
            try:
                dt = datetime.strptime(session_id, "%Y%m%d_%H%M%S")
                created_at = dt.isoformat() + 'Z'
            except ValueError:
                pass

            sessions.append({
                "session_id": session_id,
                "file_path": str(jsonl_file.absolute()),
                "file_size": file_size,
                "created_at": created_at,
                "rounds": stats["rounds"],
                "total_tokens": stats["total_tokens"],
                "title": stats.get("title", ""),
                "model": stats.get("model", ""),
            })

        return sessions

    def _quick_stats(self, file_path: Path) -> Dict[str, Any]:
        """
        快速统计会话信息（只读取文件头尾）

        Args:
            file_path: JSONL 文件路径

        Returns:
            {"rounds": int, "total_tokens": int, "title": str, "model": str}
        """
        stats = {"rounds": 0, "total_tokens": 0}
        file_size = file_path.stat().st_size

        try:
            # 读取头部获取 metadata
            with open(file_path, 'rb') as f:
                head_data = f.read(min(self.PROGRESSIVE_HEAD_SIZE, file_size)).decode('utf-8', errors='ignore')
            for line in head_data.split('\n'):
                entry = self._safe_parse_json(line)
                if entry:
                    if entry.get('type') == 'metadata':
                        stats[entry['key']] = entry['value']
                    elif entry.get('type') == 'user':
                        stats["rounds"] += 1
                        stats["total_tokens"] += entry.get("tokens", 0)
                    elif entry.get('type') == 'assistant':
                        stats["total_tokens"] += entry.get("tokens", 0)

            # 对于小文件直接逐行统计 rounds
            if file_size <= self.PROGRESSIVE_HEAD_SIZE:
                return stats

            # 对于大文件，用尾部也统计 rounds（近似值）
            with open(file_path, 'rb') as f:
                seek_pos = max(0, file_size - self.PROGRESSIVE_TAIL_SIZE)
                f.seek(seek_pos)
                tail_data = f.read().decode('utf-8', errors='ignore')
                if seek_pos > 0:
                    newline_pos = tail_data.find('\n')
                    if newline_pos >= 0:
                        tail_data = tail_data[newline_pos + 1:]
            for line in tail_data.split('\n'):
                entry = self._safe_parse_json(line)
                if entry:
                    if entry.get('type') == 'user':
                        stats["rounds"] += 1
                        stats["total_tokens"] += entry.get("tokens", 0)
                    elif entry.get('type') == 'assistant':
                        stats["total_tokens"] += entry.get("tokens", 0)
                    elif entry.get('type') == 'metadata':
                        stats[entry['key']] = entry['value']

        except (IOError, OSError):
            pass

        return stats

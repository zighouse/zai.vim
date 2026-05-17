#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
Audit Logger - JSONL-based shell audit logging with credential sanitization.

Thread safety: THREAD_SAFE: SINGLE_WRITER
  - write_entry(): Vim main thread only
  - sanitize(): any thread (pure function)
  - _background_flush(): fire-and-forget thread
"""

from __future__ import annotations

# stdlib imports
import atexit
import json
import os
import queue
import re
import sys
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

# internal imports
from shell.error import SafetyError

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

AUDIT_DIR = Path.home() / ".local" / "share" / "zai" / "audit"

_CREDENTIAL_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # Private key blocks (PEM format) — multi-line, check first
    (re.compile(
        r'-----BEGIN\s+.*?PRIVATE\s+KEY-----[\s\S]*?-----END\s+.*?PRIVATE\s+KEY-----',
        re.IGNORECASE,
    ), '***PRIVATE KEY***'),

    # Environment variables containing sensitive keywords
    # Captures full var name (e.g. AWS_SECRET_ACCESS_KEY) before = or :
    (re.compile(
        r'(\b\w*(?:SECRET|TOKEN|PASSWORD|API[_-]?KEY|AUTH[_-]?TOKEN)\w*\s*[:=]\s*)\S+',
        re.IGNORECASE,
    ), r'\1***'),

    # Bearer tokens (HTTP Authorization headers)
    (re.compile(r'Bearer\s+[\w.-]+'), 'Bearer ***'),

    # JWT tokens (eyJ... format)
    (re.compile(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'), 'eyJ***'),

    # URL-style connection strings (postgres://, mysql://, etc.)
    (re.compile(
        r'(?i)(?:postgres|mysql|mongodb|redis|amqp)://\S+',
    ), '***DSN***'),

    # Variable-style DSN / connection_string
    (re.compile(
        r'(?i)(DSN|connection[_-]?string)\s*[:=]\s*\S+',
    ), r'\1=***'),

    # API keys in URL query params (?key=, ?api_key=)
    (re.compile(r'([?&])(?:api_)?key=?[A-Za-z0-9_-]+'), r'\1key=***'),
    # Token in URL query params (?token=)
    (re.compile(r'([?&])token=?[A-Za-z0-9_-]+'), r'\1token=***'),

    # CLI passwords (--password=, --pass=)
    (re.compile(r'(?i)--password[=\s]+\S+'), '--password=***'),
    # Note: standalone -p with space is NOT matched because it's ambiguous.
    # mkdir -p, cp -p, grep -p all use -p for non-password purposes.
    # MySQL uses -pSECRET (no space) for inline passwords, -p alone prompts.
]

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class AuditEntry:
    """Complete audit entry for a shell command execution.

    Note: Some fields may be None or contain different structures depending on
    degradation state (e.g., sandbox_config may have different fields when bwrap
    is unavailable). All fields are required but the internal structure may vary.
    """

    timestamp: str  # ISO 8601 format with microseconds
    session_id: str  # Current AI session identifier
    execution_id: str  # Unique command execution UUID
    command: dict  # {sanitized: str, parsed: list[dict]}
    harm_level: str  # "S" | "A" | "B" | "none"
    working_dir: str  # Current working directory
    safety_trace: list[dict]  # List of layer decisions
    sandbox_config: dict  # May vary based on degradation
    execution: dict  # {exit_code, success, duration_ms, ...}
    user_decision: str  # "allow_once" | "deny_once" | ...
    background: bool  # Whether command ran in background


# ---------------------------------------------------------------------------
# Credential Sanitization
# ---------------------------------------------------------------------------


def sanitize(text: str) -> str:
    """Sanitize credential patterns from text.

    Pure function, thread-safe, can be called concurrently (MUST-2 READ_ONLY).
    Applies credential pattern replacements in order - safe default: prefer
    over-sanitizing to under-sanitizing (NFR7).
    """
    if not text:
        return text
    for pattern, replacement in _CREDENTIAL_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


# ---------------------------------------------------------------------------
# Main implementation
# ---------------------------------------------------------------------------


class AuditLogger:
    """Singleton JSONL audit logger with fire-and-forget writes.

    Thread safety: THREAD_SAFE: SINGLE_WRITER
      - log(): can be called from any thread (puts to queue)
      - sanitize(): pure function, thread-safe
      - _background_flush(): daemon thread, sole writer
    """

    _instance: AuditLogger | None = None
    _lock = threading.Lock()

    def __new__(cls) -> AuditLogger:
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    instance = super().__new__(cls)
                    instance._initialized = False
                    cls._instance = instance
        return cls._instance

    def __init__(self) -> None:
        if self._initialized:
            return
        self._initialized = True
        self._write_queue: queue.Queue[AuditEntry | None] = queue.Queue()

        # Rotation state (Task 1: Subtask 1.1) — set BEFORE thread starts
        self._daily_count: int = 0
        self._current_date: str = ""
        self._rotate_lock = threading.Lock()
        self._write_counter: int = 0

        self._flush_thread = threading.Thread(
            target=self._background_flush, daemon=True,
        )
        self._flush_thread.start()
        atexit.register(self._flush)

    @staticmethod
    def sanitize(text: str) -> str:
        """Delegate to module-level sanitize() for API convenience."""
        return sanitize(text)

    def log(self, entry: AuditEntry) -> tuple[None, SafetyError | None]:
        """Fire-and-forget async write (MUST-1).

        Queues entry for background writing. Never blocks the caller.
        Returns (None, None) on success or (None, SafetyError) on queue failure.
        Audit failure is non-fatal (NFR3).
        """
        try:
            self._write_queue.put(entry)
            return (None, None)
        except Exception as e:
            print(
                f"[shell][WARN] audit log queue failed: {e}",
                file=sys.stderr,
            )
            return (None, SafetyError(
                layer="L5_audit",
                code="QUEUE_FAILED",
                message=f"audit queue failed: {e}",
                degraded=True,
            ))

    def _background_flush(self) -> None:
        """Background thread: write queue entries to disk with retry."""
        while True:
            try:
                entry = self._write_queue.get()
                if entry is None:
                    break  # Sentinel for shutdown
                self._write_with_retry(entry)
            except (OSError, IOError, queue.Empty):
                pass  # Expected I/O errors, non-fatal
            except Exception as e:
                print(
                    f"[shell][WARN] audit background flush error: {e}",
                    file=sys.stderr,
                )

    def _write_with_retry(self, entry: AuditEntry, max_retries: int = 3) -> None:
        """Write to disk with retry mechanism for transient errors."""
        for attempt in range(max_retries):
            try:
                self._write_to_disk(entry)
                return
            except (OSError, IOError) as e:
                if attempt < max_retries - 1:
                    time.sleep(1)
                else:
                    print(
                        f"[shell][WARN] audit log write failed after "
                        f"{max_retries} retries: {e}",
                        file=sys.stderr,
                    )

    def _get_log_path(self, date_str: str, sequence: int = 0) -> Path:
        """Get log file path. sequence=0 means base file, N means .(N+1).jsonl.

        Task 1, Subtask 1.2: 基础文件无序号，超限文件加 .N.jsonl
        """
        if sequence == 0:
            return AUDIT_DIR / f"audit-{date_str}.jsonl"
        return AUDIT_DIR / f"audit-{date_str}.{sequence + 1}.jsonl"

    def _write_to_disk(self, entry: AuditEntry) -> None:
        """Write a single audit entry with rotation support (Task 1, Subtask 1.3)."""
        AUDIT_DIR.mkdir(parents=True, exist_ok=True)

        with self._rotate_lock:
            today = datetime.now().strftime("%Y-%m-%d")

            # Reset counter on day change (AC: 新日切换)
            # Count existing lines in today's base file to support
            # multi-instance rotation (NFR16).  Without this, a second
            # Vim instance starting after 9 500 entries already exist
            # would never rotate — its per-instance counter starts at 0.
            if today != self._current_date:
                self._current_date = today
                base_path = self._get_log_path(today, 0)
                if base_path.exists():
                    try:
                        with open(base_path, "r") as f:
                            self._daily_count = sum(
                                1 for line in f if line.strip()
                            )
                    except OSError:
                        self._daily_count = 0
                else:
                    self._daily_count = 0

            sequence = self._daily_count // 10000  # 0 for first 10k, 1 for next, etc.
            log_path = self._get_log_path(today, sequence)

            line = json.dumps(asdict(entry), ensure_ascii=False)
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(line + "\n")

            self._daily_count += 1

        # Periodic cleanup trigger: run every 100 writes
        self._write_counter += 1
        if self._write_counter % 100 == 0:
            self._cleanup(retention_days=30)

    def _flush(self) -> None:
        """Flush remaining entries before Vim exits (risk I4 mitigation)."""
        while True:
            try:
                entry = self._write_queue.get_nowait()
                if entry is not None:
                    self._write_to_disk(entry)
            except queue.Empty:
                break
            except Exception:
                pass  # Non-fatal

    def query(
        self,
        session_id: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
    ) -> tuple[list[dict], SafetyError | None]:
        """Query audit log entries with optional filters (Task 2, MUST-1).

        Args:
            session_id: Filter by exact session ID match.
            start_time: ISO 8601 datetime range start (inclusive).
            end_time: ISO 8601 datetime range end (inclusive).

        Returns:
            (list[dict], None) sorted by timestamp ascending.
            ([], SafetyError) on read error — never raises (MUST-3).
        """
        try:
            results: list[dict] = []
            for log_file in sorted(AUDIT_DIR.glob("audit-*.jsonl")):
                if not log_file.is_file():
                    continue
                try:
                    with open(log_file, "r", encoding="utf-8") as f:
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                entry = json.loads(line)
                            except json.JSONDecodeError:
                                continue  # Skip corrupt lines
                            if self._matches(entry, session_id, start_time, end_time):
                                results.append(entry)
                except (OSError, IOError):
                    continue  # Skip unreadable files, keep going

            results.sort(key=lambda e: e.get("timestamp", ""))
            return (results, None)

        except (OSError, IOError) as e:
            return ([], SafetyError(
                layer="L5_audit",
                code="QUERY_FAILED",
                message=f"audit query failed: {e}",
                degraded=False,
            ))

    @staticmethod
    def _matches(
        entry: dict,
        session_id: str | None,
        start_time: str | None,
        end_time: str | None,
    ) -> bool:
        """AND logic filter for query matching (Task 2, Subtask 2.3)."""
        if session_id is not None and entry.get("session_id") != session_id:
            return False
        ts = entry.get("timestamp", "")
        if start_time is not None and ts < start_time:
            return False
        if end_time is not None and ts > end_time:
            return False
        return True

    def _cleanup(self, retention_days: int = 30) -> tuple[None, SafetyError | None]:
        """Delete log files older than retention_days (Task 3, FR26).

        Args:
            retention_days: 0 disables cleanup. Default 30.

        Returns:
            (None, None) on success, (None, SafetyError) on failure.
        """
        if retention_days <= 0:
            return (None, None)

        try:
            cutoff = datetime.now().timestamp() - retention_days * 86400
            for log_file in AUDIT_DIR.glob("audit-*.jsonl"):
                try:
                    if log_file.stat().st_mtime < cutoff:
                        log_file.unlink()
                except (OSError, IOError):
                    continue  # Skip individual file errors
            return (None, None)
        except (OSError, IOError) as e:
            print(
                f"[shell][WARN] audit cleanup failed: {e}",
                file=sys.stderr,
            )
            return (None, SafetyError(
                layer="L5_audit",
                code="CLEANUP_FAILED",
                message=f"audit cleanup failed: {e}",
                degraded=False,
            ))

    @classmethod
    def reset(cls) -> None:
        """Reset singleton for testing purposes only."""
        with cls._lock:
            if cls._instance is not None:
                old = cls._instance
                cls._instance = None
                try:
                    old._write_queue.put(None)
                    old._flush_thread.join(timeout=2.0)
                except Exception:
                    pass

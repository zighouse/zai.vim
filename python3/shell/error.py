#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""Safety error types and constants for the shell sandbox system.

THREAD_SAFE: READ_ONLY — this module defines only immutable data structures and constants.
"""

from __future__ import annotations

from dataclasses import dataclass

# Valid safety layer names. P2/P3 layers are reserved for future use.
VALID_LAYERS: frozenset[str] = frozenset({
    "L1_classifier",    # P1 安全分类助手
    "L2_policy",        # P0 权限引擎
    "L2.5_dataflow",    # P1 数据流检测
    "L3_sandbox",       # P1 OS 沙箱
    # P2 reserved layers
    "L2.5_injection",   # P2: 注入检测增强
    "L4_trash",         # P2: 垃圾站 + 回滚
    # P3 reserved layers
    "L3_gate",          # P3: S级门控确认
    "L3_watchdog",      # P3: 看门狗实时监控
    "L5_audit",         # P1 审计闭环
})


@dataclass(frozen=True)
class SafetyError:
    """Structured error returned by sandbox operations.

    All public shell/sandbox methods return (result, None) on success
    or (None, SafetyError) on failure (MUST-1).
    """

    layer: str
    code: str
    message: str
    degraded: bool = False

    def __post_init__(self) -> None:
        if self.layer not in VALID_LAYERS:
            raise ValueError(
                f"Invalid layer '{self.layer}', must be one of: {sorted(VALID_LAYERS)}"
            )
        if len(self.message) > 80:
            raise ValueError(
                f"message must be ≤ 80 chars, got {len(self.message)}"
            )
        if "\n" in self.message:
            raise ValueError("message must be single-line, no newlines")

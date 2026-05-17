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
    "L1_parser",
    "L2_policy",
    "L3_sandbox",
    # P2 reserved layers
    "L4_network",
    "L5_audit",
    # P3 reserved layers
    "L6_dataflow",
    "L7_classifier",
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

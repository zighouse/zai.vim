#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""Shell sandbox module — safety layers for AI command execution.

Public API (MUST-8):
    SafetyError    — structured error for sandbox operations
    VALID_LAYERS   — frozenset of valid safety layer names
    SandboxBuilder — detect and build sandbox configurations
    SandboxConfig  — immutable sandbox configuration
"""

from .error import SafetyError, VALID_LAYERS
from .sandbox import SandboxBuilder, SandboxConfig

__all__ = [
    "SafetyError",
    "VALID_LAYERS",
    "SandboxBuilder",
    "SandboxConfig",
]

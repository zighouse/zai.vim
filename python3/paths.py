"""
Centralized path management for zai.vim.

Provides a single source of truth for all user-level and project-level paths.
Supports three configuration mechanisms (in priority order):
  1. Environment variable ZAI_USER_DIR
  2. Runtime override via set_user_dir() (e.g. from Vim g:zai_user_dir)
  3. Auto-detection: ~/.zai/ if it exists, else legacy appdirs location

Project-level directory: .zai/ under project root.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from appdirs import user_data_dir as _appdirs_user_data_dir

_APP_NAME = "zai"
_APP_AUTHOR = "zighouse"

# Lazy singleton — set by set_user_dir() or detected on first get_user_dir() call
_user_dir: Optional[Path] = None


def get_user_dir() -> Path:
    """Return the user-level data directory.

    Priority:
      1. Previously set value (via set_user_dir or env var cached on first call)
      2. ZAI_USER_DIR environment variable
      3. ~/.zai/ if the directory exists
      4. Legacy appdirs location (~/.local/share/zai/ on Linux)
    """
    global _user_dir
    if _user_dir is not None:
        return _user_dir

    env = os.environ.get("ZAI_USER_DIR")
    if env:
        _user_dir = Path(env)
        return _user_dir

    new_dir = Path.home() / (".zai" if os.name == "nt" else ".zai")
    if new_dir.is_dir():
        _user_dir = new_dir
        return _user_dir

    _user_dir = Path(_appdirs_user_data_dir(_APP_NAME, _APP_AUTHOR))
    return _user_dir


def set_user_dir(path: Path | str) -> None:
    """Override the user-level directory at runtime."""
    global _user_dir
    _user_dir = Path(path)


# ---------------------------------------------------------------------------
# User-level subdirectories
# ---------------------------------------------------------------------------

def get_skills_dir() -> Path:
    return get_user_dir() / "skills"


def get_log_dir() -> Path:
    return get_user_dir() / "log"


def get_sessions_dir() -> Path:
    return get_user_dir() / "sessions"


def get_audit_dir() -> Path:
    return get_user_dir() / "audit"


def get_config_dir() -> Path:
    return get_user_dir()


def get_cache_dir() -> Path:
    return get_user_dir() / "cache"


# ---------------------------------------------------------------------------
# Specific files
# ---------------------------------------------------------------------------

def get_skill_state_file() -> Path:
    return get_user_dir() / "skill-state.yaml"


def get_skill_audit_file() -> Path:
    return get_user_dir() / "skill-audit.jsonl"


def get_assistants_config() -> Path:
    return get_user_dir() / "assistants.yaml"


def get_sandbox_cache_file() -> Path:
    return get_user_dir() / "sandbox_cache.json"


# ---------------------------------------------------------------------------
# Project-level paths
# ---------------------------------------------------------------------------

_PROJECT_DIR_NAME = ".zai"


def get_project_dir(cwd: Path | str | None = None) -> Path:
    """Return the project-level directory (default: .zai/ under cwd)."""
    base = Path(cwd) if cwd else Path.cwd()
    return base / _PROJECT_DIR_NAME


def get_project_skills_dir(cwd: Path | str | None = None) -> Path:
    """Return the project-level skills directory (.zai/skills/)."""
    return get_project_dir(cwd) / "skills"


def find_project_dir(start: Path | str | None = None) -> Optional[Path]:
    """Walk up from *start* (default cwd) to find a .zai/ directory."""
    current = Path(start) if start else Path.cwd()
    current = current.resolve()
    for parent in [current] + list(current.parents):
        candidate = parent / _PROJECT_DIR_NAME
        if candidate.is_dir():
            return candidate
        # Stop at home directory
        if parent == Path.home():
            break
    return None

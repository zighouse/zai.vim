"""
Centralized path management for zai.vim.

Provides a single source of truth for all user-level and project-level paths.
Supports three configuration mechanisms (in priority order):
  1. Environment variable ZAI_USER_DIR
  2. Runtime override via set_user_dir() (e.g. from Vim g:zai_user_dir)
  3. Auto-detection with legacy fallback

User-level directory resolution:
  - If ZAI_USER_DIR is set → use it
  - If ~/.zaivim/ exists AND contains key data files → use it
  - If legacy dir (~/.local/share/zai/) has data → use it
  - Otherwise → default to ~/.zaivim/ (for new installations)

Project-level directory: .zai/ under project root.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Optional

from appdirs import user_data_dir as _appdirs_user_data_dir

_APP_NAME = "zai"
_APP_AUTHOR = "zighouse"

# Files that indicate a directory is a genuine zai data directory.
# Only user-created config files count — auto-generated subdirs/logs do not.
_MARKER_FILES = ("assistants.yaml", "assistants.json")

# Lazy singleton — set by set_user_dir() or detected on first get_user_dir() call
_user_dir: Optional[Path] = None


def _has_data(directory: Path) -> bool:
    """Check if a directory contains user-created zai config files."""
    if not directory.is_dir():
        return False
    return any((directory / name).is_file() for name in _MARKER_FILES)


def _get_new_dir() -> Path:
    """Return the new-style directory path (~/.zaivim/)."""
    return Path.home() / ".zaivim"


def _get_legacy_dir() -> Path:
    """Return the legacy appdirs directory path."""
    return Path(_appdirs_user_data_dir(_APP_NAME, _APP_AUTHOR))


def get_user_dir() -> Path:
    """Return the user-level data directory.

    Priority:
      1. Previously set value (via set_user_dir or env var cached on first call)
      2. ZAI_USER_DIR environment variable
      3. ~/.zaivim/ if it contains key data files
      4. Legacy appdirs location if it contains data
      5. ~/.zaivim/ as default for new installations
    """
    global _user_dir
    if _user_dir is not None:
        return _user_dir

    # 1. Environment variable override
    env = os.environ.get("ZAI_USER_DIR")
    if env:
        _user_dir = Path(env)
        return _user_dir

    # 2. New directory with actual data
    new_dir = _get_new_dir()
    if _has_data(new_dir):
        _user_dir = new_dir
        return _user_dir

    # 3. Legacy directory with data
    legacy_dir = _get_legacy_dir()
    if _has_data(legacy_dir):
        _user_dir = legacy_dir
        return _user_dir

    # 4. Default: new directory for fresh installations
    _user_dir = new_dir
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


def migrate_to_new_dir() -> Path:
    """Migrate data from legacy directory to ~/.zaivim/.

    Copies all files and subdirectories from the legacy appdirs location
    to ~/.zaivim/. Existing files in ~/.zaivim/ are NOT overwritten.

    Returns the new directory path.
    """
    legacy = _get_legacy_dir()
    target = _get_new_dir()

    if not legacy.is_dir():
        target.mkdir(parents=True, exist_ok=True)
        return target

    target.mkdir(parents=True, exist_ok=True)

    for item in legacy.iterdir():
        dest = target / item.name
        if dest.exists():
            continue
        if item.is_file():
            shutil.copy2(item, dest)
        elif item.is_dir():
            shutil.copytree(item, dest, dirs_exist_ok=True)

    # Switch to new directory
    global _user_dir
    _user_dir = target
    return target

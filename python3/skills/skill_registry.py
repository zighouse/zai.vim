"""
Skill discovery and unified registry.

Two-level architecture:
- Level 1: Lightweight index (frontmatter only, loaded at startup)
- Level 2: Full metadata (loaded on demand when skill details needed)

Priority: project .zai/skills/ > user skills dir
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from paths import get_skills_dir, get_project_skills_dir

from .skill_parser import parse, parse_index_only
from .skill_types import (
    InvocationResult,
    SecurityDomain,
    SkillMetadata,
    SkillOrigin,
    SkillRegistryError,
    SkillStatus,
    TrustLevel,
)

logger = logging.getLogger(__name__)

_USER_SKILL_DIR = get_skills_dir()
_MANIFEST_FILE = ".scan-manifest.json"


class SkillRegistry:
    """Unified registry for all skills with two-level indexing."""

    def __init__(self, user_dir: Path = _USER_SKILL_DIR,
                 project_dir: Path | None = None):
        self._user_dir = user_dir
        self._project_dir = project_dir
        # name -> SkillMetadata (lightweight index, always in memory)
        self._skills: dict[str, SkillMetadata] = {}
        # name -> source path (for manifest tracking)
        self._paths: dict[str, str] = {}

    @property
    def cache_size(self) -> int:
        """Number of skills in the in-memory cache."""
        return self.count

    def cache_stats(self) -> dict[str, int]:
        """Return cache statistics for monitoring."""
        return {
            "total_skills": self.count,
            "enabled": sum(
                1 for m in self._skills.values()
                if not m.name.startswith("_shadowed:")
                and m.status == SkillStatus.ENABLED
            ),
            "disabled": sum(
                1 for m in self._skills.values()
                if m.status == SkillStatus.DISABLED
            ),
        }

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def scan(self, *, incremental: bool = True) -> int:
        """Scan skill directories and register discovered skills.

        Returns the number of newly registered skills.
        """
        new_count = 0
        dirs_to_scan: list[tuple[Path, bool]] = []

        if self._project_dir and self._project_dir.is_dir():
            dirs_to_scan.append((self._project_dir, True))

        if self._user_dir.is_dir():
            dirs_to_scan.append((self._user_dir, False))

        for skill_dir, is_project in dirs_to_scan:
            manifest = self._load_manifest(skill_dir) if incremental else {}
            for entry in sorted(skill_dir.iterdir()):
                if not entry.is_dir():
                    continue
                skill_md = entry / "SKILL.md"
                if not skill_md.is_file():
                    continue

                # Incremental: skip if mtime unchanged
                if incremental:
                    current_hash = _file_hash(skill_md)
                    cached = manifest.get(entry.name)
                    if cached == current_hash and entry.name in self._skills:
                        continue
                    manifest[entry.name] = current_hash

                try:
                    idx = parse_index_only(skill_md)
                    name = idx["name"]
                except Exception as e:
                    logger.warning("Failed to parse %s: %s", skill_md, e)
                    continue

                meta = SkillMetadata(
                    name=name,
                    description=idx["description"],
                    security_domain=SecurityDomain(idx["security_domain"]),
                    origin=SkillOrigin(idx["origin"]),
                    path=idx["path"],
                    version=idx["version"],
                    trust_level=TrustLevel(idx["trust_level"]),
                )

                # Project-level priority: shadow user-level same-name
                existing = self._skills.get(name)
                if existing is not None:
                    if is_project and existing.status != SkillStatus.SHADOWED:
                        # Project skill takes priority, shadow the existing
                        existing.status = SkillStatus.SHADOWED
                        shadow_key = f"_shadowed:{name}:{_safe_key(existing.path or '')}"
                        self._skills[shadow_key] = existing
                        self._skills[name] = meta
                        new_count += 1
                        continue
                    else:
                        # User skill with same name as project — shadow this one
                        meta.status = SkillStatus.SHADOWED
                        shadow_key = f"_shadowed:{name}:{_safe_key(meta.path or '')}"
                        self._skills[shadow_key] = meta
                        continue

                # Check for previously-registered skill now missing
                if name in self._paths and self._paths[name] != str(skill_md):
                    pass  # path changed, update normally

                self._skills[name] = meta
                self._paths[name] = str(skill_md)
                new_count += 1

            if incremental:
                self._save_manifest(skill_dir, manifest)

        # Mark missing: skills in registry whose path no longer exists
        for name, meta in list(self._skills.items()):
            if name.startswith("_shadowed:"):
                continue
            if meta.path and not Path(meta.path).exists():
                meta.status = SkillStatus.MISSING

        return new_count

    def get(self, name: str) -> SkillMetadata | None:
        """Get skill metadata by name. Loads full metadata on demand."""
        meta = self._skills.get(name)
        if meta is None:
            return None
        return meta

    def get_full(self, name: str) -> SkillMetadata | None:
        """Get full skill metadata (triggers full parse if needed)."""
        meta = self._skills.get(name)
        if meta is None or not meta.path:
            return None
        try:
            full = parse(meta.path)
            # Preserve registry-managed fields
            full.status = meta.status
            self._skills[name] = full
            return full
        except Exception:
            return meta

    def list_all(self) -> list[SkillMetadata]:
        """Return all non-shadowed skills."""
        return [
            m for m in self._skills.values()
            if m.status != SkillStatus.SHADOWED
        ]

    def register(self, meta: SkillMetadata) -> None:
        """Register a skill. Atomic: rolls back on failure."""
        if not meta.name:
            raise SkillRegistryError("Cannot register skill without name")
        backup_skill = self._skills.get(meta.name)
        backup_path = self._paths.get(meta.name)
        try:
            self._skills[meta.name] = meta
            self._paths[meta.name] = meta.path
        except Exception as e:
            if backup_skill is not None:
                self._skills[meta.name] = backup_skill
                self._paths[meta.name] = backup_path or ""
            else:
                self._skills.pop(meta.name, None)
                self._paths.pop(meta.name, None)
            raise SkillRegistryError(f"Registration failed for {meta.name}: {e}") from e

    def unregister(self, name: str) -> bool:
        """Unregister a skill. Atomic: rolls back on failure."""
        meta = self._skills.get(name)
        if meta is None:
            return False
        # Remove from registry first
        del self._skills[name]
        self._paths.pop(name, None)
        try:
            # Remove from filesystem
            if meta.path:
                skill_dir = Path(meta.path).parent
                if skill_dir.is_dir():
                    import shutil
                    shutil.rmtree(skill_dir)
            return True
        except Exception as e:
            # Rollback registry (filesystem deletion failed)
            self._skills[name] = meta
            self._paths[name] = meta.path or ""
            raise SkillRegistryError(f"Unregister failed for {name}: {e}") from e

    def set_status(self, name: str, status: SkillStatus) -> bool:
        """Set skill status. Returns False if skill not found."""
        meta = self._skills.get(name)
        if meta is None:
            return False
        meta.status = status
        return True

    @property
    def count(self) -> int:
        return len([n for n in self._skills if not n.startswith("_shadowed:")])

    # ------------------------------------------------------------------
    # Manifest for incremental scans
    # ------------------------------------------------------------------

    def _load_manifest(self, skill_dir: Path) -> dict[str, str]:
        manifest_path = skill_dir / _MANIFEST_FILE
        if manifest_path.is_file():
            try:
                return json.loads(manifest_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                pass
        return {}

    def _save_manifest(self, skill_dir: Path, manifest: dict[str, str]) -> None:
        manifest_path = skill_dir / _MANIFEST_FILE
        try:
            manifest_path.write_text(
                json.dumps(manifest, indent=2), encoding="utf-8"
            )
        except OSError as e:
            logger.warning("Failed to save manifest: %s", e)


def _file_hash(path: Path) -> str:
    """Compute SHA256 hash of a file for change detection."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _safe_key(path: str) -> str:
    """Sanitize path for use as dict key (no / or : collisions)."""
    return hashlib.sha256(path.encode()).hexdigest()[:12]

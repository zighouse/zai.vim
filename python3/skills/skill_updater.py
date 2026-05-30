"""
Skill updater — download new version, diff SKILL.md, atomic replace.

Downloads a new version of an installed skill, generates a change summary
comparing old and new SKILL.md frontmatter, then atomically replaces the
skill directory. Security-related changes (domain, output_schema) trigger
automatic trust downgrade to L1.
"""

from __future__ import annotations

import logging
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent))
from paths import get_skills_dir

from .skill_audit import SkillAuditLogger
from .skill_installer import SkillInstaller
from .skill_registry import SkillRegistry
from .skill_types import (
    ErrorCode,
    InvocationResult,
    SkillParseError,
    TrustLevel,
)

logger = logging.getLogger(__name__)


def _generate_diff_summary(old_meta, new_meta) -> dict[str, object]:
    """Compare two SkillMetadata and return changes.

    Returns dict with keys that changed, each value being
    {"old": ..., "new": ...}.
    """
    changes: dict[str, object] = {}
    fields = [
        ("version", "version"),
        ("description", "description"),
        ("security_domain", "security_domain"),
        ("output_schema", "output_schema"),
    ]

    for attr, label in fields:
        old_val = str(getattr(old_meta, attr, ""))
        new_val = str(getattr(new_meta, attr, ""))
        if old_val != new_val:
            changes[label] = {"old": old_val, "new": new_val}

    # Dependencies diff
    old_deps = old_meta.dependencies or {}
    new_deps = new_meta.dependencies or {}
    if old_deps != new_deps:
        added = {k: v for k, v in new_deps.items() if k not in old_deps}
        removed = {k: v for k, v in old_deps.items() if k not in new_deps}
        changed = {
            k: {"old": old_deps[k], "new": new_deps[k]}
            for k in new_deps
            if k in old_deps and old_deps[k] != new_deps[k]
        }
        changes["dependencies"] = {
            "added": added, "removed": removed, "changed": changed,
        }

    return changes


def _has_security_change(changes: dict) -> bool:
    """Check if changes affect security-sensitive fields."""
    return "security_domain" in changes or "output_schema" in changes


def _format_summary(changes: dict) -> str:
    """Format changes dict into a human-readable summary."""
    lines = []
    for field, detail in changes.items():
        if field == "dependencies":
            added = detail.get("added", {})
            removed = detail.get("removed", {})
            parts = []
            if added:
                parts.append(f"+{added}")
            if removed:
                parts.append(f"-{removed}")
            lines.append(f"  dependencies: {', '.join(parts)}")
        else:
            lines.append(
                f"  {field}: {detail.get('old', '')} -> {detail.get('new', '')}"
            )
    return "\n".join(lines)


def _replace_contents(target: Path, source: Path) -> None:
    """Atomically replace target directory contents with source's."""
    # Clear target
    for item in list(target.iterdir()):
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()
    # Copy new contents
    for item in source.iterdir():
        if item.is_dir():
            shutil.copytree(item, target / item.name)
        else:
            shutil.copy2(str(item), str(target / item.name))


class SkillUpdater:
    """Updates installed skills with atomic replace and diff reporting."""

    def __init__(self, registry: SkillRegistry,
                 skill_dir: Optional[Path] = None,
                 audit_logger: Optional[SkillAuditLogger] = None):
        self._registry = registry
        self._skill_dir = skill_dir or get_skills_dir()
        self._installer = SkillInstaller(
            registry=registry, skill_dir=self._skill_dir
        )
        self._audit = audit_logger or SkillAuditLogger()

    def update_from_url(
        self,
        name: str,
        url: str,
        checksum: Optional[str] = None,
    ) -> InvocationResult:
        """Download new version, generate diff, replace atomically.

        Returns InvocationResult with 'changes' and 'summary' in data.
        """
        # 1. Verify skill exists
        old_meta = self._registry.get_full(name)
        if old_meta is None:
            return InvocationResult(
                success=False,
                error=f"Skill not found: {name}",
                error_code=ErrorCode.SKILL_NOT_FOUND,
                recoverable=False,
            )

        skill_dir = Path(old_meta.path).parent if old_meta.path else None
        if skill_dir is None or not skill_dir.is_dir():
            return InvocationResult(
                success=False,
                error=f"Skill directory not found for: {name}",
                error_code=ErrorCode.SKILL_NOT_FOUND,
                recoverable=False,
            )

        # 2. Download and extract new version to temp
        tmp_extract: Optional[Path] = None
        tmp_archive: Optional[Path] = None
        swapped = False

        try:
            tmp_archive = self._installer._download(url)

            # Verify checksum if provided
            if checksum:
                if not self._installer._verify_checksum(tmp_archive, checksum):
                    return InvocationResult(
                        success=False,
                        error="Integrity check failed: checksum mismatch",
                        error_code=ErrorCode.SKILL_EXECUTION_ERROR,
                        recoverable=False,
                    )

            tmp_extract = Path(tempfile.mkdtemp(prefix="zai-update-"))
            new_src = self._installer._extract(tmp_archive, tmp_extract)

            # 3. Parse new SKILL.md
            new_meta = self._installer._validate_package(new_src)

            # Verify name matches
            if new_meta.name != name:
                return InvocationResult(
                    success=False,
                    error=(
                        f"Package name mismatch: expected '{name}', "
                        f"got '{new_meta.name}'"
                    ),
                    error_code=ErrorCode.SKILL_EXECUTION_ERROR,
                    recoverable=False,
                )

            # 4. Generate diff summary
            changes = _generate_diff_summary(old_meta, new_meta)
            summary = _format_summary(changes)

            # 5. Check if already up to date
            if not changes:
                return InvocationResult(
                    success=True,
                    data={
                        "name": name,
                        "summary": (
                            f"{name} is already up to date ({old_meta.version})"
                        ),
                        "changes": {},
                        "updated": False,
                    },
                )

            # 6. Atomic replace using directory swap
            # Rename current dir aside, create fresh dir with new content
            backup_path = skill_dir.with_name(skill_dir.name + ".bak")
            if backup_path.exists():
                shutil.rmtree(backup_path)
            shutil.move(str(skill_dir), str(backup_path))
            swapped = True

            skill_dir.mkdir(parents=True, exist_ok=True)
            _replace_contents(skill_dir, new_src)

            # 7. Update registry
            new_meta.path = str(skill_dir / "SKILL.md")
            new_meta.origin = old_meta.origin
            new_meta.trust_level = old_meta.trust_level
            new_meta.status = old_meta.status

            # 8. Security change → trust downgrade
            if _has_security_change(changes):
                new_meta.trust_level = TrustLevel.L1
                summary += (
                    "\n  [SECURITY] trust_level -> L1 (security change detected)"
                )

            self._registry.register(new_meta)

            # 9. Audit log
            self._audit.log_invocation(
                skill_name=name,
                result_summary="skill_updated",
                verify_decision="allowed",
                extra={
                    "old_version": old_meta.version,
                    "new_version": new_meta.version,
                    "security_downgrade": _has_security_change(changes),
                },
            )

            # 10. Cleanup backup (successful update)
            try:
                shutil.rmtree(backup_path)
            except OSError:
                pass

            return InvocationResult(
                success=True,
                data={
                    "name": name,
                    "summary": summary,
                    "changes": changes,
                    "updated": True,
                },
            )

        except Exception as e:
            # Rollback: if we swapped the directory, swap back
            if swapped and skill_dir is not None:
                backup_path = skill_dir.with_name(skill_dir.name + ".bak")
                try:
                    if backup_path.is_dir():
                        if skill_dir.is_dir():
                            shutil.rmtree(skill_dir)
                        shutil.move(str(backup_path), str(skill_dir))
                        # Re-register old metadata
                        self._registry.register(old_meta)
                except OSError as restore_err:
                    logger.error(
                        "Failed to rollback update for %s: %s",
                        name, restore_err,
                    )

            error_code = ErrorCode.SKILL_DOWNLOAD_ERROR
            recoverable = True
            if isinstance(e, SkillParseError):
                error_code = ErrorCode.SKILL_EXECUTION_ERROR
                recoverable = False
            return InvocationResult(
                success=False,
                error=(
                    f"Update failed: {e}, skill restored to previous version"
                ),
                error_code=error_code,
                recoverable=recoverable,
            )
        finally:
            # Cleanup temp files
            if tmp_archive is not None and tmp_archive.exists():
                try:
                    tmp_archive.unlink()
                except OSError:
                    pass
            if tmp_extract is not None and tmp_extract.exists():
                try:
                    shutil.rmtree(tmp_extract)
                except OSError:
                    pass

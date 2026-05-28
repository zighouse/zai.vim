"""
URL skill installer — download, verify, extract, and register external skills.

Atomic install flow: download → verify checksum → extract → validate SKILL.md
→ register. On any failure, all temp files and partial installs are cleaned up.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Optional

from .skill_parser import parse
from .skill_registry import SkillRegistry
from .skill_types import (
    ErrorCode,
    InvocationResult,
    SkillOrigin,
    SkillParseError,
    SkillRegistryError,
    TrustLevel,
)

logger = logging.getLogger(__name__)

_MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024  # 100 MB

_KEBAB_RE = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")


def _guess_suffix(url: str) -> str:
    """Guess archive suffix from URL, stripping query/fragment."""
    base = url.split("?")[0].split("#")[0].lower()
    if base.endswith(".tar.gz") or base.endswith(".tgz"):
        return ".tar.gz"
    if base.endswith(".zip"):
        return ".zip"
    return ".tar.gz"


def _is_safe_member(name: str) -> bool:
    """Reject path traversal and unsafe entries in archive members."""
    # Normalize backslashes (Windows-style paths)
    normalized = name.replace("\\", "/")
    # Reject absolute paths
    if normalized.startswith("/"):
        return False
    # Reject any path component that is ".."
    parts = normalized.split("/")
    if ".." in parts:
        return False
    return True


def _is_safe_tar_member(member: tarfile.TarInfo) -> bool:
    """Reject path traversal, symlinks pointing outside, and hardlinks."""
    if not _is_safe_member(member.name):
        return False
    # Reject symlinks that escape extraction directory
    if member.issym():
        if not _is_safe_member(member.linkname):
            return False
    # Reject hardlinks that escape
    if member.islnk():
        if not _is_safe_member(member.linkname):
            return False
    return True


class SkillInstaller:
    """Installs skill packages from URLs into the user skill directory."""

    def __init__(self, registry: SkillRegistry,
                 skill_dir: Optional[Path] = None):
        self._registry = registry
        self._skill_dir = skill_dir or (
            Path.home() / ".local" / "share" / "zai" / "skills"
        )
        self._skill_dir.mkdir(parents=True, exist_ok=True)

    def install_from_url(
        self,
        url: str,
        checksum: Optional[str] = None,
    ) -> InvocationResult:
        """Download, verify, extract, and register a skill from a URL.

        Args:
            url: URL pointing to a .tar.gz or .zip skill package.
            checksum: Expected SHA256 hex digest of the downloaded archive.

        Returns:
            InvocationResult with skill name in data on success.
        """
        tmp_archive: Optional[Path] = None
        tmp_extract: Optional[Path] = None
        final_dir: Optional[Path] = None

        try:
            # 1. Download
            tmp_archive = self._download(url)

            # 2. Verify checksum if provided
            if checksum:
                if not self._verify_checksum(tmp_archive, checksum):
                    return InvocationResult(
                        success=False,
                        error="Integrity check failed: checksum mismatch",
                        error_code=ErrorCode.SKILL_EXECUTION_ERROR,
                        recoverable=False,
                    )

            # 3. Extract
            tmp_extract = Path(tempfile.mkdtemp(prefix="zai-skill-"))
            skill_src = self._extract(tmp_archive, tmp_extract)

            # 4. Validate SKILL.md
            meta = self._validate_package(skill_src)

            # 5. Check not already installed
            existing = self._registry.get(meta.name)
            if existing is not None:
                return InvocationResult(
                    success=False,
                    error=(
                        f"Skill '{meta.name}' already installed. "
                        f"Use :ZaiSkillUpdate to update or "
                        f":ZaiSkillUninstall first."
                    ),
                    error_code=ErrorCode.SKILL_EXECUTION_ERROR,
                    recoverable=False,
                )

            # 6. Atomic move to final destination
            final_dir = self._skill_dir / meta.name
            try:
                final_dir.mkdir(exist_ok=False)
            except FileExistsError:
                return InvocationResult(
                    success=False,
                    error=f"Skill directory already exists: {final_dir}",
                    error_code=ErrorCode.SKILL_EXECUTION_ERROR,
                    recoverable=False,
                )
            # Move contents into the new directory
            for item in skill_src.iterdir():
                shutil.move(str(item), str(final_dir))

            # 7. Register with origin=EXTERNAL, trust_level=L1
            meta.path = str(final_dir / "SKILL.md")
            meta.origin = SkillOrigin.EXTERNAL
            meta.trust_level = TrustLevel.L1
            self._registry.register(meta)

            return InvocationResult(
                success=True,
                data={"name": meta.name, "path": str(final_dir)},
            )

        except Exception as e:
            # Rollback: remove final_dir if we created it
            if final_dir is not None and final_dir.exists():
                try:
                    shutil.rmtree(final_dir)
                except OSError:
                    pass
            error_code = ErrorCode.SKILL_DOWNLOAD_ERROR
            recoverable = True
            if isinstance(e, SkillRegistryError):
                error_code = ErrorCode.SKILL_REGISTRY_ERROR
                recoverable = False
            elif isinstance(e, SkillParseError):
                error_code = ErrorCode.SKILL_EXECUTION_ERROR
                recoverable = False
            return InvocationResult(
                success=False,
                error=str(e),
                error_code=error_code,
                recoverable=recoverable,
            )
        finally:
            # Always cleanup temp files
            if tmp_archive and tmp_archive.exists():
                try:
                    tmp_archive.unlink()
                except OSError:
                    pass
            if tmp_extract and tmp_extract.exists():
                try:
                    shutil.rmtree(tmp_extract)
                except OSError:
                    pass

    def _download(self, url: str, timeout: int = 30) -> Path:
        """Download URL to a temp file. Raises on failure."""
        suffix = _guess_suffix(url)
        tmp = tempfile.NamedTemporaryFile(
            delete=False, suffix=suffix, prefix="zai-dl-"
        )
        try:
            urllib.request.urlretrieve(url, tmp.name)
        except Exception as e:
            tmp.close()
            try:
                Path(tmp.name).unlink(missing_ok=True)
            except OSError:
                pass
            raise RuntimeError(
                f"Download failed for {url}: {e}"
            ) from e
        tmp.close()

        # Enforce size limit
        size = Path(tmp.name).stat().st_size
        if size > _MAX_DOWNLOAD_SIZE:
            Path(tmp.name).unlink(missing_ok=True)
            raise RuntimeError(
                f"Download too large: {size} bytes (max: {_MAX_DOWNLOAD_SIZE})"
            )

        return Path(tmp.name)

    def _extract(self, archive: Path, dest: Path) -> Path:
        """Extract archive to dest, return the directory containing SKILL.md."""
        name = archive.name.lower()
        if name.endswith(".tar.gz") or name.endswith(".tgz"):
            with tarfile.open(archive, "r:gz") as tf:
                safe_members = [
                    m for m in tf.getmembers()
                    if _is_safe_tar_member(m)
                ]
                tf.extractall(dest, members=safe_members)
        elif name.endswith(".zip"):
            with zipfile.ZipFile(archive) as zf:
                for info in zf.infolist():
                    if _is_safe_member(info.filename):
                        zf.extract(info, dest)
        else:
            raise RuntimeError(f"Unsupported archive format: {archive.name}")

        # Find the skill directory (contains SKILL.md)
        for d in dest.iterdir():
            if d.is_dir() and (d / "SKILL.md").is_file():
                return d
        # Check if root is the skill dir
        if (dest / "SKILL.md").is_file():
            return dest
        raise RuntimeError(
            "Invalid skill package: missing SKILL.md"
        )

    def _validate_package(self, skill_dir: Path):
        """Parse SKILL.md and return SkillMetadata. Raises on failure."""
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.is_file():
            raise RuntimeError(
                "Invalid skill package: missing SKILL.md"
            )
        meta = parse(skill_md)
        # Re-validate name safety (defense-in-depth)
        if not _KEBAB_RE.match(meta.name):
            raise RuntimeError(
                f"Invalid skill name '{meta.name}': must be kebab-case"
            )
        return meta

    @staticmethod
    def _verify_checksum(archive_path: Path, expected: str) -> bool:
        """Verify SHA256 checksum of a file."""
        h = hashlib.sha256()
        with open(archive_path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
        return hmac.compare_digest(h.hexdigest(), expected)

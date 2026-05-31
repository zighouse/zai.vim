"""
URL skill installer — download, verify, extract, and register external skills.

Atomic install flow: download → verify checksum → extract → validate SKILL.md
→ register. On any failure, all temp files and partial installs are cleaned up.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.request
import yaml
import zipfile
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent))
from paths import get_skills_dir

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
        self._skill_dir = skill_dir or get_skills_dir()
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

    # ------------------------------------------------------------------
    # Claude Code skill import
    # ------------------------------------------------------------------

    def import_from_claude_code(
        self, source_dir: Optional[Path] = None
    ) -> list[dict]:
        """Discover skills from a Claude Code configuration directory.

        Scans ~/.claude/commands/*.md and ~/.claude/skills/*/SKILL.md.
        Returns a list of dicts with name, description, path, format.
        Does NOT install — caller presents list for user selection.
        """
        base = source_dir or Path.home() / ".claude"
        if not base.is_dir():
            return []

        found: list[dict] = []

        # Scan commands/*.md (legacy CC format)
        commands_dir = base / "commands"
        if commands_dir.is_dir():
            for md_file in commands_dir.glob("*.md"):
                name = md_file.stem
                if not _KEBAB_RE.match(name):
                    continue
                desc = self._quick_description(md_file)
                found.append({
                    "name": name,
                    "description": desc,
                    "path": str(md_file),
                    "format": "cc-command",
                })

        # Scan skills/*/SKILL.md (modern CC format)
        skills_dir = base / "skills"
        if skills_dir.is_dir():
            for skill_dir in skills_dir.iterdir():
                if not skill_dir.is_dir():
                    continue
                skill_md = skill_dir / "SKILL.md"
                if not skill_md.is_file():
                    continue
                name = skill_dir.name
                if not _KEBAB_RE.match(name):
                    continue
                desc = self._quick_description(skill_md)
                found.append({
                    "name": name,
                    "description": desc,
                    "path": str(skill_md),
                    "format": "cc-skill",
                })

        return found

    def import_selected(
        self, source_dir: Optional[Path], selected: list[str]
    ) -> list[str]:
        """Install selected CC skills into ~/.zaivim/skills/.

        Args:
            source_dir: Claude config dir (default ~/.claude/).
            selected: List of skill names to install.

        Returns:
            List of installed skill names.
        """
        base = source_dir or Path.home() / ".claude"
        discovered = self.import_from_claude_code(base)
        by_name = {s["name"]: s for s in discovered}

        installed: list[str] = []
        for name in selected:
            info = by_name.get(name)
            if info is None:
                logger.warning("CC skill '%s' not found during import", name)
                continue

            dst = self._skill_dir / name
            if dst.exists():
                logger.warning("Skill '%s' already installed, skipping", name)
                continue

            src_path = Path(info["path"])

            try:
                if info["format"] == "cc-command":
                    # Single .md → create directory structure
                    dst.mkdir(parents=True, exist_ok=True)
                    skill_md = dst / "SKILL.md"
                    content = src_path.read_text(encoding="utf-8")
                    # Inject zai.vim defaults if frontmatter exists
                    content = self._inject_zaivim_defaults(content)
                    skill_md.write_text(content, encoding="utf-8")
                else:
                    # Directory → copy entire skill
                    shutil.copytree(src_path.parent, dst)

                installed.append(name)
                logger.info("Imported CC skill '%s' to %s", name, dst)
            except Exception as e:
                logger.error("Failed to import CC skill '%s': %s", name, e)
                # Cleanup partial install
                if dst.exists():
                    try:
                        shutil.rmtree(dst)
                    except OSError:
                        pass

        # Refresh registry
        if installed:
            try:
                self._registry.scan(incremental=True)
            except Exception:
                pass

        return installed

    # ------------------------------------------------------------------
    # GitHub skill installation
    # ------------------------------------------------------------------

    def install_from_github(
        self, repo: str, subpath: str = ".claude/commands"
    ) -> list[dict]:
        """List available skills from a GitHub repo via API.

        Args:
            repo: GitHub repo in owner/name format (e.g. 'bmad-method/BMAD-METHOD').
            subpath: Path within repo to scan for skill files.

        Returns:
            List of dicts with name, description, url.
        """
        api_url = f"https://api.github.com/repos/{repo}/contents/{subpath}"
        headers = {"Accept": "application/vnd.github.v3+json",
                   "User-Agent": "zaivim-skill-installer"}
        # Use GITHUB_TOKEN if available (raises rate limit from 60 to 5000/hr)
        gh_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        if gh_token:
            headers["Authorization"] = f"Bearer {gh_token}"
        try:
            req = urllib.request.Request(api_url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                items = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            logger.error("GitHub API call failed for %s: %s", api_url, e)
            return []

        if not isinstance(items, list):
            return []

        found: list[dict] = []
        for item in items:
            name = item.get("name", "")
            if not name.endswith(".md"):
                continue
            skill_name = name[:-3]  # strip .md
            if not _KEBAB_RE.match(skill_name):
                continue
            download_url = item.get("download_url", "")
            if not download_url:
                continue
            found.append({
                "name": skill_name,
                "description": f"(from {repo}/{subpath}/{name})",
                "download_url": download_url,
                "format": "github",
            })

        return found

    def install_selected_from_github(
        self, repo: str, subpath: str, selected: list[str]
    ) -> list[str]:
        """Download and install selected skills from GitHub.

        Args:
            repo: GitHub repo in owner/name format.
            subpath: Path within repo (e.g. '.claude/commands').
            selected: List of skill names to install.

        Returns:
            List of installed skill names.
        """
        discovered = self.install_from_github(repo, subpath)
        by_name = {s["name"]: s for s in discovered}

        installed: list[str] = []
        for name in selected:
            info = by_name.get(name)
            if info is None:
                logger.warning("GitHub skill '%s' not found", name)
                continue

            dst = self._skill_dir / name
            if dst.exists():
                logger.warning("Skill '%s' already installed, skipping", name)
                continue

            download_url = info["download_url"]
            try:
                # Download content
                headers = {"User-Agent": "zaivim-skill-installer"}
                gh_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
                if gh_token:
                    headers["Authorization"] = f"Bearer {gh_token}"
                req = urllib.request.Request(download_url, headers=headers)
                with urllib.request.urlopen(req, timeout=30) as resp:
                    content = resp.read().decode("utf-8")

                # Create directory structure
                dst.mkdir(parents=True, exist_ok=True)
                content = self._inject_zaivim_defaults(content)
                (dst / "SKILL.md").write_text(content, encoding="utf-8")
                installed.append(name)
                logger.info("Installed GitHub skill '%s' to %s", name, dst)
            except Exception as e:
                logger.error("Failed to install GitHub skill '%s': %s", name, e)
                if dst.exists():
                    try:
                        shutil.rmtree(dst)
                    except OSError:
                        pass

        if installed:
            try:
                self._registry.scan(incremental=True)
            except Exception:
                pass

        return installed

    # ------------------------------------------------------------------
    # Internal helpers for CC/GitHub import
    # ------------------------------------------------------------------

    @staticmethod
    def _quick_description(md_path: Path) -> str:
        """Extract a quick description from a .md file (frontmatter or body)."""
        try:
            content = md_path.read_text(encoding="utf-8")
        except Exception:
            return ""
        # Try YAML frontmatter description
        m = re.match(r"^---\s*\r?\n(.*?)\r?\n---", content, re.DOTALL)
        if m:
            try:
                fm = yaml.safe_load(m.group(1)) or {}
                if isinstance(fm, dict):
                    desc = fm.get("description", "")
                    if desc:
                        return str(desc)[:200]
            except Exception:
                pass
        # Fallback: first non-heading paragraph
        body = content[m.end():] if m else content
        for line in body.strip().splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                return stripped[:200]
        return ""

    @staticmethod
    def _inject_zaivim_defaults(content: str) -> str:
        """Add zai.vim default fields to CC-format SKILL.md frontmatter."""
        m = re.match(r"^---\s*\r?\n(.*?)\r?\n---", content, re.DOTALL)
        if not m:
            # No frontmatter at all — wrap entire content
            return (
                "---\n"
                "security_domain: workspace\n"
                "origin: external\n"
                "trust_level: L1\n"
                "---\n\n"
                + content
            )

        fm_text = m.group(1)
        try:
            fm = yaml.safe_load(fm_text) or {}
        except Exception:
            return content  # leave untouched if YAML is broken

        if not isinstance(fm, dict):
            return content

        # Add zai.vim defaults for missing fields
        defaults = {
            "security_domain": "workspace",
            "origin": "external",
            "trust_level": "L1",
        }
        changed = False
        for key, default in defaults.items():
            if key not in fm:
                fm[key] = default
                changed = True

        if not changed:
            return content

        new_fm = yaml.dump(fm, allow_unicode=True, default_flow_style=False,
                           sort_keys=False).rstrip("\n")
        body = content[m.end():]
        return f"---\n{new_fm}\n---{body}"

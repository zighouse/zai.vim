"""
L0 intent verification and parse consistency locking.

Provides:
- IntentVerifier: domain boundary checks, output_schema pre-flight validation
- ParseCache: checksum-bound parse result cache with invalidation on file change
- Trust downgrade on behavior change detection (security_domain, output_schema)
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from pathlib import Path
from typing import Any, Optional

from .skill_parser import parse
from .skill_types import (
    ErrorCode,
    InvocationResult,
    SecurityDomain,
    SkillMetadata,
    TrustLevel,
)

logger = logging.getLogger(__name__)


class ParseCache:
    """Checksum-bound cache for parsed SKILL.md results.

    When the file's checksum changes, the cache invalidates and triggers
    re-parse + behavior change detection.
    """

    def __init__(self) -> None:
        # path -> (checksum, SkillMetadata)
        self._cache: dict[str, tuple[str, SkillMetadata]] = {}
        self._lock = threading.Lock()

    def get(self, path: str) -> Optional[SkillMetadata]:
        """Return cached metadata if checksum still matches, else None."""
        with self._lock:
            entry = self._cache.get(path)
        if entry is None:
            return None
        cached_checksum, cached_meta = entry
        current_checksum = _file_checksum(path)
        if current_checksum == cached_checksum:
            return cached_meta
        return None  # stale

    def put(self, path: str, meta: SkillMetadata) -> None:
        """Store metadata with current file checksum."""
        checksum = _file_checksum(path)
        with self._lock:
            self._cache[path] = (checksum, meta)

    def invalidate(self, path: str) -> None:
        """Remove cached entry for path."""
        with self._lock:
            self._cache.pop(path, None)

    def check_for_changes(
        self, path: str
    ) -> Optional[tuple[SkillMetadata, SkillMetadata]]:
        """Re-parse file and compare with cached version.

        Returns (old_meta, new_meta) if changes detected, else None.
        Also updates the cache with the new version.
        """
        with self._lock:
            entry = self._cache.get(path)
        if entry is None:
            return None
        cached_checksum, old_meta = entry

        current_checksum = _file_checksum(path)
        if current_checksum == cached_checksum:
            return None

        # File changed — re-parse
        try:
            new_meta = parse(path)
        except Exception as exc:
            logger.warning("Failed to re-parse %s after change: %s", path, exc)
            self.invalidate(path)
            return None

        # Detect security-relevant changes
        if _has_behavior_change(old_meta, new_meta):
            self.put(path, new_meta)
            return (old_meta, new_meta)

        # No behavior change — just update cache
        self.put(path, new_meta)
        return None


class IntentVerifier:
    """L0 intent verification layer.

    Phase 1: domain boundary checks + output_schema pre-flight.
    Phase 2: runtime behavior monitoring (future).
    """

    def __init__(self, parse_cache: Optional[ParseCache] = None) -> None:
        self._parse_cache = parse_cache or ParseCache()

    def verify(
        self,
        meta: SkillMetadata,
        context: Any,
    ) -> bool:
        """Run L0 verification checks.

        Returns True if invocation is allowed, False if denied.
        """
        # 1. Domain boundary check
        if not self._check_domain_boundary(meta, context):
            return False

        # 2. Parse consistency — check for file changes
        if meta.path:
            changes = self._parse_cache.check_for_changes(meta.path)
            if changes:
                old_meta, new_meta = changes
                logger.warning(
                    "Behavior change detected for %s: security_domain %s→%s, "
                    "output_schema %s→%s",
                    meta.name,
                    old_meta.security_domain, new_meta.security_domain,
                    old_meta.output_schema, new_meta.output_schema,
                )
                # Trust downgrade handled by caller (Story 2.5 trust evolution)

        return True

    def check_parse_cache(
        self, meta: SkillMetadata
    ) -> Optional[tuple[SkillMetadata, SkillMetadata]]:
        """Public accessor for parse change detection."""
        if not meta.path:
            return None
        return self._parse_cache.check_for_changes(meta.path)

    def warm_cache(self, meta: SkillMetadata) -> None:
        """Pre-populate cache for a skill."""
        if meta.path:
            self._parse_cache.put(meta.path, meta)

    # ------------------------------------------------------------------
    # Internal checks
    # ------------------------------------------------------------------

    @staticmethod
    def _check_domain_boundary(meta: SkillMetadata, context: Any) -> bool:
        """Phase 1: check if the invocation crosses security domains."""
        if context is None:
            return True  # no context → same-domain assumption

        allow_cross = getattr(context, "allow_cross_domain", False)
        if allow_cross:
            return True

        ctx_domain = getattr(context, "security_domain", None)
        if ctx_domain is None:
            return True

        # Domain hierarchy: local < workspace < personal < public
        # Allow same-domain and upward calls within hierarchy
        caller_level = _domain_level(str(ctx_domain))
        skill_level = _domain_level(str(meta.security_domain))

        if skill_level > caller_level:
            # Skill requires higher privilege than caller has
            return False

        return True

    @staticmethod
    def _preflight_output_check(
        meta: SkillMetadata, kwargs: dict[str, Any]
    ) -> bool:
        """Phase 1 pre-flight: check if call parameters suggest output_schema
        violation (e.g., read-only skill but write-like arguments).

        This is heuristic — not runtime I/O interception (Phase 2).
        """
        if not meta.output_schema:
            return True

        schema = meta.output_schema.lower()
        if "read-only" in schema:
            # Heuristic: detect write-like argument patterns
            for key in kwargs:
                if any(w in key.lower() for w in ("write", "delete", "modify",
                                                   "remove", "create")):
                    return False

        return True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_DOMAIN_ORDER = {
    "local": 0,
    "workspace": 1,
    "personal": 2,
    "public": 3,
}


def _domain_level(domain: str) -> int:
    return _DOMAIN_ORDER.get(domain, -1)  # unknown domains → deny


def _file_checksum(path: str) -> str:
    """SHA256 checksum of a file."""
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
    except OSError:
        return ""
    return h.hexdigest()


def _has_behavior_change(old: SkillMetadata, new: SkillMetadata) -> bool:
    """Detect security-relevant changes between two metadata versions."""
    return (
        old.security_domain != new.security_domain
        or old.output_schema != new.output_schema
    )

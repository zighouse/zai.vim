"""
HITL (Human-in-the-Loop) trust evolution and state persistence.

Manages progressive trust levels:
- L1 → L2 after 3 safe uses in same domain
- L2 → L3 after 20 safe uses (L2+ no security events)
- L3/L2 → L1 on security event detection
- Manual override via :ZaiSkillTrust command

State persisted to ~/.zaivim/skill-state.yaml with HMAC integrity.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import yaml

sys.path.insert(0, str(Path(__file__).parent.parent))
from paths import get_skill_state_file

from .skill_types import (
    ErrorCode,
    InvocationResult,
    SkillMetadata,
    TrustLevel,
)

logger = logging.getLogger(__name__)

_STATE_FILE = get_skill_state_file()
_HMAC_KEY_ENV = "ZAI_SKILL_STATE_HMAC_KEY"
_L2_THRESHOLD = 3   # safe uses to upgrade L1→L2
_L3_THRESHOLD = 20  # safe uses to upgrade L2→L3

# Default HMAC key — in production, set ZAI_SKILL_STATE_HMAC_KEY env var
_DEFAULT_HMAC_KEY = b"zai-skill-state-integrity-v1"


class TrustEvolution:
    """Manages trust level evolution with state persistence."""

    def __init__(self, state_file: Optional[Path] = None):
        self._state_file = state_file or _STATE_FILE
        self._state: dict[str, SkillState] = {}
        self._load_state()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_state(self, skill_name: str) -> SkillState:
        """Get or create state for a skill."""
        if skill_name not in self._state:
            self._state[skill_name] = SkillState(skill_name=skill_name)
        return self._state[skill_name]

    def record_safe_use(self, skill_name: str) -> Optional[TrustLevel]:
        """Record a safe skill use and check for trust upgrade.

        Returns the new TrustLevel if upgraded, else None.
        """
        state = self.get_state(skill_name)
        state.safe_use_count += 1
        state.last_used = datetime.now(timezone.utc).isoformat()

        old_level = state.trust_level

        if state.trust_level == TrustLevel.L1 and state.safe_use_count >= _L2_THRESHOLD:
            state.trust_level = TrustLevel.L2
            state._add_history_entry("L1", "L2", f"safe_use_count: {state.safe_use_count}")
            self._save_state()
            return TrustLevel.L2

        if state.trust_level == TrustLevel.L2 and state.safe_use_count >= _L3_THRESHOLD:
            state.trust_level = TrustLevel.L3
            state._add_history_entry("L2", "L3", f"safe_use_count: {state.safe_use_count}")
            self._save_state()
            return TrustLevel.L3

        self._save_state()
        return None

    def record_security_event(self, skill_name: str, reason: str) -> TrustLevel:
        """Record a security event and downgrade trust.

        Returns the new (downgraded) trust level.
        """
        state = self.get_state(skill_name)
        state.security_event_count += 1
        old_level = str(state.trust_level)

        if state.trust_level == TrustLevel.L3:
            state.trust_level = TrustLevel.L2
        elif state.trust_level == TrustLevel.L2:
            state.trust_level = TrustLevel.L1
        # L1 stays L1

        state._add_history_entry(old_level, str(state.trust_level), f"security_event: {reason}")
        self._save_state()
        return state.trust_level

    def manual_override(
        self, skill_name: str, level: TrustLevel
    ) -> None:
        """Manually set a skill's trust level."""
        state = self.get_state(skill_name)
        old_level = str(state.trust_level)
        state.trust_level = level
        state._add_history_entry(old_level, str(level), "manual_override")
        self._save_state()

    def needs_hitl_confirmation(
        self,
        skill_name: str,
        cross_domain: bool = False,
        is_mcp: bool = False,
        schema_changed: bool = False,
    ) -> bool:
        """Check if a skill invocation requires human confirmation.

        HITL triggers:
        - First cross-domain call (any trust level)
        - L1 skill (always requires confirmation)
        - MCP adapted skill: first call (any trust level)
        - MCP adapted skill: inputSchema changed after reconnect
        """
        state = self.get_state(skill_name)

        # Cross-domain always triggers HITL
        if cross_domain:
            return True

        # L1 always requires confirmation
        if state.trust_level == TrustLevel.L1:
            return True

        # MCP enhanced HITL: first call
        if is_mcp and state.safe_use_count == 0:
            return True

        # MCP enhanced HITL: schema changed after reconnect
        if is_mcp and schema_changed:
            return True

        return False

    def get_effective_trust(self, skill_name: str) -> TrustLevel:
        """Get the effective trust level for a skill."""
        state = self.get_state(skill_name)
        return state.trust_level

    def get_history(self, skill_name: str, limit: int = 20) -> list[dict]:
        """Get trust evolution history for a skill."""
        state = self.get_state(skill_name)
        return state.trust_history[-limit:]

    # ------------------------------------------------------------------
    # State persistence
    # ------------------------------------------------------------------

    def _load_state(self) -> None:
        """Load state from YAML file with HMAC verification."""
        if not self._state_file.exists():
            return

        try:
            raw = self._state_file.read_text(encoding="utf-8")
            data = yaml.safe_load(raw) or {}
        except (yaml.YAMLError, OSError) as exc:
            logger.warning("Failed to load skill state: %s", exc)
            return

        if not isinstance(data, dict):
            return

        stored_hmac = data.pop("_hmac", None)

        # Verify HMAC using canonical JSON (deterministic serialization)
        if stored_hmac:
            canonical = json.dumps(data, sort_keys=True, ensure_ascii=False)
            expected = self._compute_hmac(canonical)
            if not hmac.compare_digest(stored_hmac, expected):
                logger.warning(
                    "Skill state integrity check failed — resetting to L1"
                )
                # Reset all skills to L1 on tampering
                for name, state_data in data.items():
                    if isinstance(state_data, dict):
                        original_level = state_data.get("trust_level", "L1")
                        state_data["trust_level"] = "L1"
                        state_data.setdefault("trust_history", []).append({
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "from": original_level,
                            "to": "L1",
                            "reason": "state_tampering_detected",
                        })

        # Parse state entries
        for name, state_data in data.items():
            if name.startswith("_"):
                continue
            if not isinstance(state_data, dict):
                continue
            try:
                self._state[name] = SkillState.from_dict(name, state_data)
            except Exception as exc:
                logger.warning("Failed to parse state for %s: %s", name, exc)

    def _save_state(self) -> None:
        """Save state to YAML file with HMAC integrity and atomic write."""
        self._state_file.parent.mkdir(parents=True, exist_ok=True)

        data = {}
        for name, state in self._state.items():
            data[name] = state.to_dict()

        # HMAC over canonical JSON (deterministic, no YAML ordering issues)
        canonical = json.dumps(data, sort_keys=True, ensure_ascii=False)
        mac = self._compute_hmac(canonical)

        output = yaml.dump(
            {"_hmac": mac, **data},
            allow_unicode=True,
            default_flow_style=False,
        )

        # Atomic write: write to temp file, then rename
        tmp_path = self._state_file.with_suffix(".tmp")
        try:
            tmp_path.write_text(output, encoding="utf-8")
            tmp_path.chmod(0o600)
            tmp_path.replace(self._state_file)
        except OSError as exc:
            logger.error("Failed to save skill state: %s", exc)
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass

    @staticmethod
    def _compute_hmac(content: str) -> str:
        key = os.environ.get(_HMAC_KEY_ENV, "").encode()
        if not key:
            key = _DEFAULT_HMAC_KEY
        return hmac.new(key, content.encode("utf-8"), hashlib.sha256).hexdigest()


class SkillState:
    """State for a single skill's trust evolution."""

    def __init__(self, skill_name: str):
        self.skill_name = skill_name
        self.trust_level: TrustLevel = TrustLevel.L1
        self.safe_use_count: int = 0
        self.security_event_count: int = 0
        self.last_used: str = ""
        self.trust_history: list[dict] = []
        self.last_schema: str = ""  # for MCP schema change detection

    def _add_history_entry(
        self, from_level: str, to_level: str, reason: str
    ) -> None:
        self.trust_history.append({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "from": from_level,
            "to": to_level,
            "reason": reason,
        })

    def to_dict(self) -> dict[str, Any]:
        return {
            "trust_level": str(self.trust_level),
            "safe_use_count": self.safe_use_count,
            "security_event_count": self.security_event_count,
            "last_used": self.last_used,
            "trust_history": self.trust_history,
            "last_schema": self.last_schema,
        }

    @classmethod
    def from_dict(cls, name: str, data: dict) -> SkillState:
        state = cls(skill_name=name)
        state.trust_level = TrustLevel(data.get("trust_level", "L1"))
        state.safe_use_count = data.get("safe_use_count", 0)
        state.security_event_count = data.get("security_event_count", 0)
        state.last_used = data.get("last_used", "")
        state.trust_history = data.get("trust_history", [])
        state.last_schema = data.get("last_schema", "")
        return state

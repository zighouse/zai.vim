"""
Skill audit logger — JSONL append-only audit trail for skill invocations.

Records every skill call with full context: timestamp, session, skill name,
call chain, security domain, trust level, verification decision, timing,
and result summary. Compatible with existing Shell audit log format (NFR15).
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_DEFAULT_LOG_DIR = Path.home() / ".local" / "share" / "zai"
_DEFAULT_LOG_FILE = "skill-audit.jsonl"


class SkillAuditLogger:
    """Append-only JSONL audit logger for skill invocations."""

    def __init__(
        self,
        log_dir: Optional[Path] = None,
        log_file: str = _DEFAULT_LOG_FILE,
    ):
        self._log_dir = log_dir or _DEFAULT_LOG_DIR
        self._log_path = self._log_dir / log_file
        self._log_dir.mkdir(parents=True, exist_ok=True)
        # Ensure restrictive permissions (NFR7)
        if not self._log_path.exists():
            self._log_path.touch()
            self._log_path.chmod(0o600)
        else:
            try:
                self._log_path.chmod(0o600)
            except OSError:
                pass

    def log_invocation(
        self,
        *,
        skill_name: str,
        session_id: str = "",
        call_chain: Optional[list[str]] = None,
        security_domain: str = "",
        trust_level: str = "",
        verify_decision: str = "",
        execution_time_ms: int = 0,
        result_summary: str = "",
        error_code: Optional[str] = None,
        origin: str = "",
        extra: Optional[dict[str, Any]] = None,
    ) -> None:
        """Write a single JSONL audit record for a skill invocation.

        All parameters are keyword-only to prevent positional errors.
        Uses json.dumps() per MUST Rule #4.
        """
        record: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "session_id": session_id,
            "skill_name": skill_name,
            "call_chain": call_chain or [],
            "security_domain": security_domain,
            "trust_level": trust_level,
            "verify_decision": verify_decision,
            "execution_time_ms": execution_time_ms,
            "result_summary": result_summary,
        }

        if error_code:
            record["error_code"] = error_code
        if origin:
            record["origin"] = origin

        if extra:
            record.update(extra)

        line = json.dumps(record, ensure_ascii=False, default=str)
        try:
            with open(self._log_path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError as exc:
            logger.error("Failed to write audit log: %s", exc)

    def log_invocation_wrapped(
        self,
        skill_name: str,
        fn: Any,
        *,
        session_id: str = "",
        call_chain: Optional[list[str]] = None,
        security_domain: str = "",
        trust_level: str = "",
        verify_decision: str = "",
        origin: str = "",
        extra: Optional[dict[str, Any]] = None,
        **kwargs: Any,
    ) -> tuple[Any, int]:
        """Execute a callable and log the invocation with timing.

        Returns (result, execution_time_ms).
        """
        start = time.monotonic()
        result = None
        try:
            result = fn(**kwargs)
            return result, int((time.monotonic() - start) * 1000)
        finally:
            elapsed = int((time.monotonic() - start) * 1000)
            summary = ""
            err_code = None
            if result is not None and hasattr(result, "success"):
                summary = "ok" if result.success else (result.error or "failed")
                err_code = getattr(result, "error_code", None)
            elif isinstance(result, str):
                summary = result[:200]
            elif isinstance(result, dict):
                summary = json.dumps(result, ensure_ascii=False)[:200]

            self.log_invocation(
                skill_name=skill_name,
                session_id=session_id,
                call_chain=call_chain,
                security_domain=security_domain,
                trust_level=trust_level,
                verify_decision=verify_decision,
                execution_time_ms=elapsed,
                result_summary=summary,
                error_code=err_code,
                origin=origin,
                extra=extra,
            )

    @property
    def log_path(self) -> Path:
        return self._log_path

"""
Unified skill execution engine.

Provides a single entry point for invoking any registered skill with:
- Thread-based execution (non-blocking Vim UI)
- Configurable timeout (default 30s)
- L0 security fallback (deny cross-domain when verifier not ready)
- Unified InvocationResult returns for all paths
"""

from __future__ import annotations

import json
import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable, Optional

from .skill_adapter import invoke_adapted
from .skill_audit import SkillAuditLogger
from .skill_registry import SkillRegistry
from .skill_security import IntentVerifier
from .skill_types import (
    ErrorCode,
    InvocationResult,
    SkillMetadata,
    SkillOrigin,
    SkillStatus,
)

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = 30
_DEFAULT_MAX_WORKERS = 4


class SkillExecutor:
    """Unified execution engine for all skills."""

    def __init__(
        self,
        registry: SkillRegistry,
        tool_pool: Any = None,
        max_workers: int = _DEFAULT_MAX_WORKERS,
        audit_logger: Optional[SkillAuditLogger] = None,
        l0_verifier: Optional[IntentVerifier] = None,
    ):
        self._registry = registry
        self._tool_pool = tool_pool
        self._executor = ThreadPoolExecutor(max_workers=max_workers)
        self._audit = audit_logger
        self._l0_verifier = l0_verifier or IntentVerifier()

    def set_l0_verifier(self, verifier: IntentVerifier) -> None:
        """Set or replace the L0 intent verifier."""
        self._l0_verifier = verifier

    def invoke(
        self,
        name: str,
        context: Optional[Any] = None,
        timeout: int = _DEFAULT_TIMEOUT,
        **kwargs: Any,
    ) -> InvocationResult:
        """Invoke a skill by name.

        Args:
            name: Skill name (kebab-case).
            context: Optional IntentContext for L0 verification.
            timeout: Execution timeout in seconds.
            **kwargs: Arguments forwarded to the skill.

        Returns:
            InvocationResult — always, never raises.
        """
        # --- Registry lookup ---
        meta = self._registry.get(name)
        if meta is None:
            self._audit_reject(name, "not_found", ErrorCode.SKILL_NOT_FOUND)
            return InvocationResult(
                success=False,
                error=f"Skill not found: {name}",
                error_code=ErrorCode.SKILL_NOT_FOUND,
            )

        # --- Status check ---
        if meta.status == SkillStatus.DISABLED:
            self._audit_reject(name, "disabled", ErrorCode.SKILL_DISABLED,
                               meta=meta)
            return InvocationResult(
                success=False,
                error=f"Skill is disabled: {name}",
                error_code=ErrorCode.SKILL_DISABLED,
            )
        if meta.status in (SkillStatus.MISSING, SkillStatus.UNAVAILABLE):
            self._audit_reject(name, f"status_{meta.status.value}",
                               ErrorCode.SKILL_UNAVAILABLE, meta=meta)
            return InvocationResult(
                success=False,
                error=f"Skill is {meta.status.value}: {name}",
                error_code=ErrorCode.SKILL_UNAVAILABLE,
            )

        # --- Pre-thread validation ---
        if meta.origin == SkillOrigin.ADAPTED and self._tool_pool is None:
            return InvocationResult(
                success=False,
                error=f"Tool pool not configured for adapted skill: {name}",
                error_code=ErrorCode.SKILL_EXECUTION_ERROR,
            )

        # --- Timeout validation ---
        if not isinstance(timeout, (int, float)) or timeout <= 0:
            timeout = _DEFAULT_TIMEOUT

        # --- L0 security check (fallback when verifier not ready) ---
        verify_decision = "fallback_allow"
        if not self._security_check(meta, context):
            verify_decision = "denied_cross_domain"
            self._audit_log(
                meta, verify_decision=verify_decision,
                execution_time_ms=0, result_summary="cross-domain denied",
                error_code=ErrorCode.SECURITY_DOMAIN_VIOLATION,
                context=context,
            )
            return InvocationResult(
                success=False,
                error=f"Security check failed for {name}: cross-domain denied",
                error_code=ErrorCode.SECURITY_DOMAIN_VIOLATION,
                recoverable=False,
            )

        # --- Execute with timeout + audit ---
        start = time.monotonic()
        result = self._execute_with_timeout(name, meta, timeout, **kwargs)
        elapsed_ms = int((time.monotonic() - start) * 1000)

        self._audit_log(
            meta, verify_decision="allowed",
            execution_time_ms=elapsed_ms,
            result_summary="ok" if result.success else (result.error or "failed"),
            error_code=result.error_code,
            context=context,
        )

        return result

    # ------------------------------------------------------------------
    # Audit helper
    # ------------------------------------------------------------------

    def _audit_log(
        self,
        meta: SkillMetadata,
        *,
        verify_decision: str = "",
        execution_time_ms: int = 0,
        result_summary: str = "",
        error_code: Optional[str] = None,
        context: Any = None,
    ) -> None:
        if self._audit is None:
            return
        self._audit.log_invocation(
            skill_name=meta.name,
            session_id=self._extract_session_id(context),
            call_chain=self._extract_call_chain(context, meta.name),
            security_domain=str(meta.security_domain),
            trust_level=str(meta.trust_level),
            verify_decision=verify_decision,
            execution_time_ms=execution_time_ms,
            result_summary=result_summary[:500] if result_summary else "",
            error_code=error_code,
            origin=str(meta.origin),
        )

    def _audit_reject(
        self,
        name: str,
        reason: str,
        error_code: str,
        *,
        meta: Optional[SkillMetadata] = None,
        context: Any = None,
    ) -> None:
        if self._audit is None:
            return
        self._audit.log_invocation(
            skill_name=name,
            session_id=self._extract_session_id(context),
            call_chain=self._extract_call_chain(context, name),
            security_domain=str(meta.security_domain) if meta else "",
            trust_level=str(meta.trust_level) if meta else "",
            verify_decision=f"rejected:{reason}",
            execution_time_ms=0,
            result_summary=reason,
            error_code=error_code,
            origin=str(meta.origin) if meta else "",
        )

    @staticmethod
    def _extract_session_id(context: Any) -> str:
        if context is None:
            return ""
        return getattr(context, "session_id", "") or ""

    @staticmethod
    def _extract_call_chain(context: Any, skill_name: str) -> list[str]:
        if context is None:
            return [skill_name]
        chain = getattr(context, "call_chain", None) or []
        return chain + [skill_name]

    # ------------------------------------------------------------------
    # Security fallback
    # ------------------------------------------------------------------

    def _security_check(self, meta: SkillMetadata, context: Any) -> bool:
        """Run L0 verification via IntentVerifier."""
        try:
            return self._l0_verifier.verify(meta, context)
        except Exception as exc:
            logger.warning("L0 verifier error for %s: %s", meta.name, exc)
            return False  # fail-closed

    # ------------------------------------------------------------------
    # Execution with timeout
    # ------------------------------------------------------------------

    def _execute_with_timeout(
        self,
        name: str,
        meta: SkillMetadata,
        timeout: int,
        **kwargs: Any,
    ) -> InvocationResult:
        """Execute skill in a thread with timeout."""
        future: Future = self._executor.submit(self._run_skill, meta, **kwargs)

        try:
            return future.result(timeout=timeout)
        except threading.BrokenThreadPool:
            return InvocationResult(
                success=False,
                error=f"Executor pool broken for {name}",
                error_code=ErrorCode.SKILL_EXECUTION_ERROR,
            )
        except TimeoutError:
            future.cancel()
            logger.warning("Skill %s timed out after %ds", name, timeout)
            return InvocationResult(
                success=False,
                error=f"Skill timed out after {timeout}s: {name}",
                error_code=ErrorCode.SKILL_TIMEOUT,
                recoverable=True,
            )
        except Exception as exc:
            return InvocationResult(
                success=False,
                error=f"Unexpected executor error for {name}: {exc}",
                error_code=ErrorCode.SKILL_EXECUTION_ERROR,
            )

    def _run_skill(self, meta: SkillMetadata, **kwargs: Any) -> InvocationResult:
        """Actual skill invocation (runs in thread pool)."""
        try:
            if meta.origin == SkillOrigin.ADAPTED:
                return invoke_adapted(
                    self._registry, meta.name, self._tool_pool, **kwargs
                )

            # Native / external skills — placeholder for future protocol dispatch
            return self._invoke_native(meta, **kwargs)
        except Exception as exc:
            logger.exception("Skill %s execution error", meta.name)
            return InvocationResult(
                success=False,
                error=str(exc),
                error_code=ErrorCode.SKILL_EXECUTION_ERROR,
                recoverable=True,
            )

    def _invoke_native(
        self, meta: SkillMetadata, **kwargs: Any
    ) -> InvocationResult:
        """Invoke a native skill by loading its SKILL.md content.

        The skill content is returned so the LLM can read it and follow
        the instructions.  This is the fallback path when skills are
        invoked directly via SkillExecutor rather than through the
        `skill` tool (tool_skill.py).
        """
        try:
            from pathlib import Path
            skill_path = Path(meta.path) if meta.path else None
            if skill_path is None:
                return InvocationResult(
                    success=False,
                    error=f"No source path for native skill: {meta.name}",
                    error_code=ErrorCode.SKILL_UNAVAILABLE,
                )
            if not skill_path.is_file():
                # Maybe meta.path is the directory — try dir/SKILL.md
                skill_path = skill_path / "SKILL.md"
            if not skill_path.is_file():
                return InvocationResult(
                    success=False,
                    error=f"SKILL.md not found for: {meta.name}",
                    error_code=ErrorCode.SKILL_UNAVAILABLE,
                )

            content = skill_path.read_text(encoding="utf-8")

            # Append invocation args if provided
            if kwargs:
                import json
                try:
                    args_str = json.dumps(kwargs, ensure_ascii=False)
                except Exception:
                    args_str = str(kwargs)
                content = content.rstrip() + f"\n\n## Invocation Arguments\n{args_str}\n"

            return InvocationResult(
                success=True,
                data={"skill_content": content, "name": meta.name},
            )
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(
                "Native skill load failed for %s: %s", meta.name, e
            )
            return InvocationResult(
                success=False,
                error=f"Failed to load skill '{meta.name}': {e}",
                error_code=ErrorCode.SKILL_EXECUTION_ERROR,
            )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def shutdown(self, wait: bool = True) -> None:
        """Shut down the executor thread pool."""
        self._executor.shutdown(wait=wait)

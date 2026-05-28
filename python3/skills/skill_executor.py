"""
Unified skill execution engine.

Provides a single entry point for invoking any registered skill with:
- Thread-based execution (non-blocking Vim UI)
- Configurable timeout (default 30s)
- L0 security fallback (deny cross-domain when verifier not ready)
- Unified InvocationResult returns for all paths
"""

from __future__ import annotations

import logging
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable, Optional

from .skill_adapter import invoke_adapted
from .skill_registry import SkillRegistry
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
    ):
        self._registry = registry
        self._tool_pool = tool_pool
        self._executor = ThreadPoolExecutor(max_workers=max_workers)
        self._l0_verifier: Optional[Callable] = None

    def set_l0_verifier(self, verifier: Callable) -> None:
        """Set the L0 intent verifier (plugged in by Story 2.3)."""
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
            return InvocationResult(
                success=False,
                error=f"Skill not found: {name}",
                error_code=ErrorCode.SKILL_NOT_FOUND,
            )

        # --- Status check ---
        if meta.status == SkillStatus.DISABLED:
            return InvocationResult(
                success=False,
                error=f"Skill is disabled: {name}",
                error_code=ErrorCode.SKILL_DISABLED,
            )
        if meta.status in (SkillStatus.MISSING, SkillStatus.UNAVAILABLE):
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
        if not self._security_check(meta, context):
            return InvocationResult(
                success=False,
                error=f"Security check failed for {name}: cross-domain denied",
                error_code=ErrorCode.SECURITY_DOMAIN_VIOLATION,
                recoverable=False,
            )

        # --- Execute with timeout ---
        return self._execute_with_timeout(name, meta, timeout, **kwargs)

    # ------------------------------------------------------------------
    # Security fallback
    # ------------------------------------------------------------------

    def _security_check(self, meta: SkillMetadata, context: Any) -> bool:
        """Run L0 verification or fallback deny-cross-domain policy."""
        if self._l0_verifier is not None:
            try:
                return self._l0_verifier(meta, context)
            except Exception as exc:
                logger.warning("L0 verifier error for %s: %s", meta.name, exc)
                return False  # fail-closed

        # Fallback: deny cross-domain when L0 not ready
        if context is None:
            return True  # no context → same-domain assumption

        # context may be IntentContext or similar duck-typed object
        allow_cross = getattr(context, "allow_cross_domain", False)
        if allow_cross:
            return True

        ctx_domain = getattr(context, "security_domain", None)
        if ctx_domain is not None and str(ctx_domain) != str(meta.security_domain):
            return False  # deny cross-domain

        return True

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
        """Invoke a native skill (placeholder — full impl in later stories)."""
        # Native skills will be dispatched via protocol translators.
        # For now, return a not-yet-implemented result.
        return InvocationResult(
            success=False,
            error=f"Native skill execution not yet implemented: {meta.name}",
            error_code=ErrorCode.SKILL_EXECUTION_ERROR,
        )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def shutdown(self, wait: bool = True) -> None:
        """Shut down the executor thread pool."""
        self._executor.shutdown(wait=wait)

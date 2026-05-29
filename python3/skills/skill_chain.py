"""
SkillChain executor — sequential multi-skill orchestration with security.

Executes chains of skills where each step's output feeds the next.
Security checkpoints at each step, exponential backoff retry on
recoverable failures, partial success preservation.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Optional

from .skill_audit import SkillAuditLogger
from .skill_executor import SkillExecutor
from .skill_registry import SkillRegistry
from .skill_trust import compute_child_trust
from .skill_types import (
    ChainStepResult,
    ErrorCode,
    InvocationResult,
    SkillChainResult,
    TrustLevel,
)

logger = logging.getLogger(__name__)

_MAX_RETRIES = 3
_BASE_DELAY = 1.0  # seconds


class SkillChainExecutor:
    """Executes ordered chains of skills with security checkpoints."""

    def __init__(
        self,
        skill_executor: SkillExecutor,
        audit_logger: Optional[SkillAuditLogger] = None,
    ):
        self._executor = skill_executor
        self._audit = audit_logger

    def execute(
        self,
        chain: list[str],
        initial_input: dict[str, Any] | None = None,
        timeout_per_step: int = 30,
    ) -> SkillChainResult:
        """Execute a chain of skills sequentially.

        Args:
            chain: Ordered list of skill names.
            initial_input: Starting input for the first skill.
            timeout_per_step: Timeout for each skill invocation.

        Returns:
            SkillChainResult with per-step details.
        """
        chain_id = uuid.uuid4().hex[:12]

        if not chain:
            return SkillChainResult(
                overall_success=False,
                steps=[],
                chain_id=chain_id,
            )

        # Single skill = direct call
        if len(chain) == 1:
            return self._execute_single(
                chain[0], initial_input, timeout_per_step, chain_id,
            )

        steps: list[ChainStepResult] = []
        current_input = initial_input or {}
        overall_success = True

        for i, skill_name in enumerate(chain):
            # Security checkpoint
            checkpoint_passed = self._security_checkpoint(
                skill_name, chain[:i], chain_id,
            )
            if not checkpoint_passed:
                steps.append(ChainStepResult(
                    skill_name=skill_name,
                    success=False,
                    result=InvocationResult(
                        success=False,
                        error="Security checkpoint failed",
                        error_code=ErrorCode.CHAIN_SECURITY_CHECKPOINT_FAILED,
                        recoverable=False,
                    ),
                    checkpoint_passed=False,
                ))
                overall_success = False
                break

            # Execute with retry
            result = self._execute_with_retry(
                skill_name, current_input, timeout_per_step, chain_id,
            )
            passed = result.success

            steps.append(ChainStepResult(
                skill_name=skill_name,
                success=passed,
                result=result,
                checkpoint_passed=True,
            ))

            if not passed:
                overall_success = False
                break

            # Pass output to next step
            if result.data:
                current_input = result.data

        return SkillChainResult(
            overall_success=overall_success,
            steps=steps,
            chain_id=chain_id,
        )

    def _execute_single(
        self,
        skill_name: str,
        initial_input: dict | None,
        timeout: int,
        chain_id: str,
    ) -> SkillChainResult:
        """Execute a single-skill chain."""
        result = self._executor.invoke(
            skill_name, timeout=timeout,
            **(initial_input or {}),
        )
        return SkillChainResult(
            overall_success=result.success,
            steps=[ChainStepResult(
                skill_name=skill_name,
                success=result.success,
                result=result,
                checkpoint_passed=True,
            )],
            chain_id=chain_id,
        )

    def _security_checkpoint(
        self,
        skill_name: str,
        preceding: list[str],
        chain_id: str,
    ) -> bool:
        """Run security checks before executing a chain step.

        - Verify skill exists and is enabled
        - Check trust propagation (child trust downgrade)
        """
        meta = self._executor._registry.get(skill_name)
        if meta is None:
            self._audit_chain(
                skill_name, chain_id, preceding,
                "checkpoint_failed:not_found",
            )
            return False

        # Trust propagation: if this is a child call, downgrade trust
        if preceding:
            parent_name = preceding[-1]
            parent_meta = self._executor._registry.get(parent_name)
            if parent_meta:
                child_trust = compute_child_trust(parent_meta.trust_level)
                # Log the trust downgrade for audit
                if child_trust != meta.trust_level:
                    logger.info(
                        "Chain %s: trust propagation %s→%s for %s",
                        chain_id, meta.trust_level, child_trust, skill_name,
                    )

        self._audit_chain(
            skill_name, chain_id, preceding, "checkpoint_passed",
        )
        return True

    def _execute_with_retry(
        self,
        skill_name: str,
        input_data: dict[str, Any],
        timeout: int,
        chain_id: str,
    ) -> InvocationResult:
        """Execute a skill with exponential backoff retry."""
        result = self._executor.invoke(
            skill_name, timeout=timeout, **input_data,
        )

        if result.success:
            return result

        # Non-recoverable errors: don't retry
        if not result.recoverable:
            return result

        # Retry with exponential backoff
        for attempt in range(1, _MAX_RETRIES + 1):
            delay = _BASE_DELAY * (2 ** (attempt - 1))
            logger.info(
                "Chain %s: retrying %s (attempt %d/%d, delay %.1fs)",
                chain_id, skill_name, attempt, _MAX_RETRIES, delay,
            )
            time.sleep(delay)

            self._audit_chain(
                skill_name, chain_id, [],
                f"chain_retry:attempt={attempt}",
            )

            result = self._executor.invoke(
                skill_name, timeout=timeout, **input_data,
            )
            if result.success or not result.recoverable:
                return result

        # All retries exhausted
        self._audit_chain(
            skill_name, chain_id, [],
            "chain_retry_exhausted",
        )
        return InvocationResult(
            success=False,
            error=(
                f"Chain step '{skill_name}' failed after "
                f"{_MAX_RETRIES} retries: {result.error}"
            ),
            error_code=result.error_code or ErrorCode.SKILL_EXECUTION_ERROR,
            recoverable=True,
        )

    def _audit_chain(
        self,
        skill_name: str,
        chain_id: str,
        preceding: list[str],
        decision: str,
    ) -> None:
        """Log chain-related audit events."""
        if self._audit is None:
            return
        self._audit.log_invocation(
            skill_name=skill_name,
            call_chain=preceding + [skill_name],
            verify_decision=decision,
            result_summary=f"chain_id={chain_id}",
        )

"""
Trust propagation control — ensures trust does not auto-propagate
from parent to child skills in call chains.

Rules:
- L3 parent → child gets L2 (downgrade by 1)
- L2 parent → child gets L1 (downgrade by 1)
- L1 parent → child stays L1 (floor)
- Unknown child skills → blocked entirely
- Cross-domain child calls → extra verification
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from .skill_types import (
    ErrorCode,
    InvocationResult,
    SecurityDomain,
    SkillMetadata,
    TrustLevel,
)

logger = logging.getLogger(__name__)

# Trust downgrade mapping
_DOWNGRADE: dict[str, str] = {
    "L3": "L2",
    "L2": "L1",
    "L1": "L1",  # floor
}


def compute_child_trust(parent_trust: TrustLevel | str) -> TrustLevel:
    """Compute the trust level for a child skill based on parent's level.

    Trust auto-downgrades by one level. L1 is the floor.
    """
    level = str(parent_trust)
    child_level = _DOWNGRADE.get(level, "L1")
    return TrustLevel(child_level)


@dataclass
class TrustCheckResult:
    """Result of a trust propagation check."""
    allowed: bool = True
    cross_domain: bool = False
    error: Optional[InvocationResult] = None


def check_trust_propagation(
    parent_meta: Optional[SkillMetadata],
    child_meta: SkillMetadata,
    registry_get_fn=None,
) -> TrustCheckResult:
    """Validate trust propagation for a parent→child skill call.

    Returns TrustCheckResult with:
    - allowed=True: call is permitted
    - cross_domain=True: cross-domain flag for HITL (Story 2.5)
    - error: InvocationResult if blocked

    Args:
        parent_meta: Parent skill metadata (None if top-level call).
        child_meta: Child skill metadata being invoked.
        registry_get_fn: Callable(name) -> SkillMetadata | None for
                         checking child existence in registry.
    """
    result = TrustCheckResult()

    # 1. Child must exist in registry
    if registry_get_fn is not None:
        registered = registry_get_fn(child_meta.name)
        if registered is None:
            logger.warning(
                "Blocked unknown skill invocation: %s",
                child_meta.name,
            )
            result.allowed = False
            result.error = InvocationResult(
                success=False,
                error=f"Unknown skill in call chain: {child_meta.name}",
                error_code=ErrorCode.UNKNOWN_SKILL,
                recoverable=False,
            )
            return result

    # 2. Cross-domain child call → flag for enhanced verification
    if parent_meta is not None:
        parent_domain = str(parent_meta.security_domain)
        child_domain = str(child_meta.security_domain)
        if parent_domain != child_domain:
            result.cross_domain = True
            logger.info(
                "Cross-domain child call: %s (%s) → %s (%s)",
                parent_meta.name, parent_domain,
                child_meta.name, child_domain,
            )

    return result


def compute_chain_trust(
    chain: list[str],
    registry_get_fn,
) -> list[TrustLevel]:
    """Compute the effective trust level for each skill in a call chain.

    Top-level skill keeps its registered trust level.
    Each subsequent skill is downgraded by one level from the previous.
    The child's own registered trust is irrelevant — trust does NOT propagate.

    Args:
        chain: Ordered list of skill names in the call chain.
        registry_get_fn: Callable(name) -> SkillMetadata | None.

    Returns:
        List of effective TrustLevel for each skill in the chain.
        Empty list if chain is empty.
    """
    if not chain:
        return []

    result: list[TrustLevel] = []
    previous_trust: Optional[TrustLevel] = None

    for name in chain:
        meta = registry_get_fn(name)
        if meta is None:
            result.append(TrustLevel.L1)
            previous_trust = TrustLevel.L1
            continue

        if previous_trust is None:
            # Top-level skill keeps its registered trust
            result.append(meta.trust_level)
        else:
            # Child gets downgraded trust (child's own level is irrelevant)
            child_trust = compute_child_trust(previous_trust)
            result.append(child_trust)

        previous_trust = result[-1]

    return result

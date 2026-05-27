"""
Legacy tool adapter — wraps existing tool_*.py as skills.

Each existing tool (shell, file, web, grep, etc.) is registered as an
origin=adapted skill with metadata auto-constructed from the tool's
function name and docstring. No separate SKILL.md needed.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable

from .skill_registry import SkillRegistry
from .skill_types import (
    InvocationResult,
    SecurityDomain,
    SkillMetadata,
    SkillOrigin,
    SkillStatus,
    TrustLevel,
)

logger = logging.getLogger(__name__)

# Security domain mapping for known tools
_TOOL_DOMAINS: dict[str, SecurityDomain] = {
    "shell": SecurityDomain.WORKSPACE,
    "file": SecurityDomain.WORKSPACE,
    "web": SecurityDomain.PUBLIC,
    "grep": SecurityDomain.WORKSPACE,
    "shell_execute": SecurityDomain.WORKSPACE,
    "file_read": SecurityDomain.WORKSPACE,
    "file_write": SecurityDomain.WORKSPACE,
    "web_fetch": SecurityDomain.PUBLIC,
    "web_search": SecurityDomain.PUBLIC,
    "grep_search": SecurityDomain.WORKSPACE,
    "ai_generate_image": SecurityDomain.PUBLIC,
    "os_info": SecurityDomain.LOCAL,
}


def adapt_legacy_tools(registry: SkillRegistry, tool_pool) -> int:
    """Register all tools from the legacy ToolPool as adapted skills.

    Args:
        registry: The skill registry to register into.
        tool_pool: The existing ToolPool instance (from tool.py).

    Returns:
        Number of tools adapted.
    """
    adapted_count = 0

    # tool_pool.tools is a dict: { "invoke_shell_execute": { "fn": callable, ... } }
    if not hasattr(tool_pool, 'tools') or not tool_pool.tools:
        logger.warning("No legacy tools found in tool pool")
        return 0

    for func_name, tool_info in tool_pool.tools.items():
        # Derive skill name from function name
        # e.g. "invoke_shell_execute" -> "shell-execute"
        skill_name = _func_to_skill_name(func_name)
        if not skill_name:
            continue

        # Extract short name for domain lookup
        short_name = skill_name.split("-")[0] if "-" in skill_name else skill_name
        domain = _TOOL_DOMAINS.get(short_name, SecurityDomain.WORKSPACE)

        # Build description from docstring
        fn = tool_info.get("fn") if isinstance(tool_info, dict) else tool_info
        description = _extract_description(fn)

        meta = SkillMetadata(
            name=skill_name,
            description=description,
            security_domain=domain,
            origin=SkillOrigin.ADAPTED,
            trust_level=TrustLevel.L2,  # Legacy tools trusted by default
            status=SkillStatus.ENABLED,
            path="",
        )

        try:
            registry.register(meta)
            adapted_count += 1
        except Exception as e:
            logger.warning("Failed to adapt tool %s: %s", func_name, e)
            logger.warning("Failed to adapt tool %s: %s", func_name, e)

    return adapted_count


def invoke_adapted(registry: SkillRegistry, skill_name: str,
                   tool_pool, **kwargs) -> InvocationResult:
    """Invoke a legacy tool through the skill system.

    Routes the call to the original tool function with transparent pass-through.
    """
    meta = registry.get(skill_name)
    if meta is None or meta.origin != SkillOrigin.ADAPTED:
        return InvocationResult(
            success=False,
            error=f"Not an adapted skill: {skill_name}",
            error_code="SKILL_NOT_FOUND",
        )

    if meta.status == SkillStatus.DISABLED:
        return InvocationResult(
            success=False,
            error=f"Skill is disabled: {skill_name}",
            error_code="SKILL_DISABLED",
        )

    # Find the original function
    func_name = _skill_to_func_name(skill_name)
    invoker = None
    if hasattr(tool_pool, 'get_invoker'):
        invoker = tool_pool.get_invoker(func_name)
    elif hasattr(tool_pool, 'tools'):
        tool_info = tool_pool.tools.get(func_name)
        if isinstance(tool_info, dict):
            invoker = tool_info.get("fn")
        else:
            invoker = tool_info

    if invoker is None:
        return InvocationResult(
            success=False,
            error=f"Original tool function not found: {func_name}",
            error_code="SKILL_NOT_FOUND",
        )

    try:
        result = invoker(**kwargs)
        # Wrap legacy result in InvocationResult
        if isinstance(result, InvocationResult):
            return result
        if isinstance(result, dict):
            return InvocationResult(success=True, data=result)
        if isinstance(result, str):
            return InvocationResult(success=True, data={"output": result})
        return InvocationResult(success=True, data={"result": str(result)})
    except Exception as e:
        return InvocationResult(
            success=False,
            error=str(e),
            error_code="SKILL_EXECUTION_ERROR",
            recoverable=True,
        )


# ---------------------------------------------------------------------------
# Name conversion helpers
# ---------------------------------------------------------------------------

def _func_to_skill_name(func_name: str) -> str:
    """Convert invoke_shell_execute -> shell-execute."""
    if func_name.startswith("invoke_"):
        base = func_name[len("invoke_"):]
    else:
        base = func_name
    return base.replace("_", "-")


def _skill_to_func_name(skill_name: str) -> str:
    """Convert shell-execute -> invoke_shell_execute."""
    return "invoke_" + skill_name.replace("-", "_")


def _extract_description(fn) -> str:
    """Extract first line of docstring as description."""
    if fn is None:
        return "Legacy tool (adapted)"
    doc = getattr(fn, "__doc__", None)
    if not doc:
        return "Legacy tool (adapted)"
    first_line = doc.strip().split("\n")[0].strip()
    return first_line if first_line else "Legacy tool (adapted)"

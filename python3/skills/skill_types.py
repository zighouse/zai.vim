"""
Skill system core type definitions.

All modules communicate via these dataclasses — no raw dict passing.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import Any

if sys.version_info >= (3, 11):
    from enum import StrEnum
else:
    from enum import Enum

    class StrEnum(str, Enum):
        """StrEnum backport for Python < 3.11."""
        def __new__(cls, value: str) -> StrEnum:
            obj = super().__new__(cls, value)
            return obj

        def __str__(self) -> str:
            return self.value


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class SecurityDomain(StrEnum):
    """Permission scope, ordered from most restrictive to least."""
    LOCAL = "local"
    WORKSPACE = "workspace"
    PERSONAL = "personal"
    PUBLIC = "public"


class SkillOrigin(StrEnum):
    """How the skill was introduced to the system."""
    NATIVE = "native"
    ADAPTED = "adapted"
    EXTERNAL = "external"
    DEPRECATED_ADAPTED = "deprecated_adapted"


class TrustLevel(StrEnum):
    """Progressive trust levels for HITL confirmation."""
    L1 = "L1"
    L2 = "L2"
    L3 = "L3"


class SkillStatus(StrEnum):
    """Lifecycle status of a skill in the registry."""
    ENABLED = "enabled"
    DISABLED = "disabled"
    MISSING = "missing"
    SHADOWED = "shadowed"
    UNAVAILABLE = "unavailable"


class SkillVisibility(StrEnum):
    """Four-level visibility control for skills (CC skillOverrides)."""
    ON = "on"
    NAME_ONLY = "name-only"
    USER_INVOCABLE_ONLY = "user-invocable-only"
    OFF = "off"


# ---------------------------------------------------------------------------
# Error codes (constants)
# ---------------------------------------------------------------------------

class ErrorCode:
    """Centralized error code registry for consistent naming."""
    SKILL_TIMEOUT = "SKILL_TIMEOUT"
    SKILL_DISABLED = "SKILL_DISABLED"
    SKILL_NOT_FOUND = "SKILL_NOT_FOUND"
    SKILL_EXECUTION_ERROR = "SKILL_EXECUTION_ERROR"
    SKILL_UNAVAILABLE = "SKILL_UNAVAILABLE"
    SKILL_DOWNLOAD_ERROR = "SKILL_DOWNLOAD_ERROR"
    SECURITY_DOMAIN_VIOLATION = "SECURITY_DOMAIN_VIOLATION"
    CHAIN_SECURITY_CHECKPOINT_FAILED = "CHAIN_SECURITY_CHECKPOINT_FAILED"
    CHAIN_RETRY_EXHAUSTED = "CHAIN_RETRY_EXHAUSTED"
    EMPTY_CHAIN = "EMPTY_CHAIN"
    MCP_TOOL_ERROR = "MCP_TOOL_ERROR"
    UNKNOWN_SKILL = "UNKNOWN_SKILL"


# ---------------------------------------------------------------------------
# Core data structures
# ---------------------------------------------------------------------------

@dataclass
class SkillMetadata:
    """Structured representation of a SKILL.md definition."""
    name: str
    description: str
    security_domain: SecurityDomain = SecurityDomain.WORKSPACE
    origin: SkillOrigin = SkillOrigin.NATIVE
    version: str = "0.1.0"
    dependencies: dict[str, Any] = field(default_factory=dict)
    trust_level: TrustLevel = TrustLevel.L1
    output_schema: str = ""
    path: str | None = None  # stored as str for JSON serialization
    status: SkillStatus = SkillStatus.ENABLED
    visibility: str = "on"  # SkillVisibility value for skillOverrides
    # Skill discovery fields
    when_to_use: str = ""  # hints for LLM-driven skill matching
    paths: list[str] = field(default_factory=list)  # file patterns for conditional activation
    disable_model_invocation: bool = False  # hide from LLM listing
    user_invocable: bool = True  # whether user can invoke via /skillname
    localized_descriptions: dict[str, str] = field(default_factory=dict)  # lang -> description
    tags: list[str] = field(default_factory=list)  # auto-extracted category tags
    # Claude Code compatibility fields
    arguments: list[str] = field(default_factory=list)  # named positional args ($name mapping)
    argument_hint: str = ""  # displayed during autocompletion
    allowed_tools: list[str] = field(default_factory=list)  # tools allowed without confirmation
    disallowed_tools: list[str] = field(default_factory=list)  # tools removed during skill
    # CC reserved fields (tolerated but not implemented)
    context: str = ""  # e.g. "fork" for sub-agent execution
    agent: str = ""  # sub-agent type when context: fork
    model: str = ""  # model override
    effort: str = ""  # effort level override
    hooks: dict[str, Any] = field(default_factory=dict)  # skill-scoped hooks
    shell: str = ""  # bash or powershell
    # Catch-all for unrecognized frontmatter fields
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class InvocationResult:
    """Uniform return type for all skill invocations."""
    success: bool
    data: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    error_code: str | None = None
    recoverable: bool = True


@dataclass
class IntentContext:
    """Context passed to L0 verification layer."""
    user_intent: str
    security_domain: SecurityDomain
    call_chain: list[str] = field(default_factory=list)
    trust_level: TrustLevel = TrustLevel.L1
    allow_cross_domain: bool = False


@dataclass
class ChainStepResult:
    """Result of a single step within a SkillChain."""
    skill_name: str
    success: bool
    result: InvocationResult = field(default_factory=lambda: InvocationResult(success=False))
    checkpoint_passed: bool = False


@dataclass
class SkillChainResult:
    """Result of a SkillChain execution."""
    overall_success: bool
    steps: list[ChainStepResult] = field(default_factory=list)
    chain_id: str = ""


# ---------------------------------------------------------------------------
# Error hierarchy
# ---------------------------------------------------------------------------

class SkillError(Exception):
    """Base error for the skill system."""


class SkillParseError(SkillError):
    """Error parsing SKILL.md."""


class SkillRegistryError(SkillError):
    """Error in skill registry operations."""


class SkillExecutionError(SkillError):
    """Error during skill execution."""


class SkillSecurityError(SkillError):
    """Error from L0 security verification."""


class SkillTimeoutError(SkillError):
    """Error when skill execution exceeds timeout."""

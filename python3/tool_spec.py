#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
Unified tool specification types.

Defines the core data types for the new tool system:
  - ToolSpec: unified tool interface
  - CategorySummary: LLM-compiled category metadata with caching
  - ToolResult: structured tool return value
  - ToolTier: first_class | second_class citizen levels
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

# ---------------------------------------------------------------------------
# Tool citizen tiers
# ---------------------------------------------------------------------------
ToolTier = Literal["first", "second"]

# First-class citizen tools: directly exposed with full schema
DEFAULT_FIRST_CLASS_TOOLS = {
    "read_file",       # file
    "write_file",      # file
    "substitute_file", # file (Edit replacement)
    "ls",              # file
    "search_in_file",  # file
    "grep",            # grep
    "shell_execute",   # shell (direct host execution)
    "shell_abort",     # shell (abort running command)
    "web_search",      # web
    "web_get_content", # web
    "skill",           # skill invocation
}


# ---------------------------------------------------------------------------
# Core dataclasses
# ---------------------------------------------------------------------------

@dataclass
class ToolSpec:
    """Unified tool interface.

    Each tool_*.py module exposes one or more ToolSpec instances.
    Replaces the old tool_*.json + invoke_{name} convention.
    """

    name: str
    description: str
    parameters: Dict[str, Any]          # JSON Schema for input
    output_schema: Optional[Dict[str, Any]] = None  # JSON Schema for output
    prompt: str = ""                     # tells AI when to use this tool

    # Categorisation & tiering
    category: str = "general"           # category key for grouping
    tier: ToolTier = "second"           # initial citizen level

    # Execution declarations
    is_read_only: bool = True
    is_concurrency_safe: bool = True
    user_only: bool = False              # excluded from LLM tool list
    max_result_size: int = 8000          # chars before truncation

    # Runtime statistics (persisted only in memory, not in cache)
    call_count: int = field(default=0, compare=False, repr=False)
    total_errors: int = field(default=0, compare=False, repr=False)
    total_result_chars: int = field(default=0, compare=False, repr=False)

    # ------------------------------------------------------------------
    # OpenAI function-calling format
    # ------------------------------------------------------------------
    def to_openai_tool(self) -> Dict[str, Any]:
        """Convert to an OpenAI-compatible tool definition."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    def to_openai_tool_with_prompt(self) -> Dict[str, Any]:
        """Like to_openai_tool but appends prompt to description."""
        tool_def = self.to_openai_tool()
        if self.prompt:
            tool_def["function"]["description"] = (
                f"{self.description}\n\n{self.prompt}"
            )
        return tool_def

    # ------------------------------------------------------------------
    # Tier lifecycle
    # ------------------------------------------------------------------
    def record_call(self, result_chars: int = 0, is_error: bool = False):
        """Update runtime statistics after a tool invocation."""
        self.call_count += 1
        self.total_result_chars += result_chars
        if is_error:
            self.total_errors += 1

    def should_promote(self, threshold: int) -> bool:
        """Check whether this tool qualifies for tier promotion."""
        return self.tier == "second" and self.call_count >= threshold

    def promote(self):
        """Promote this tool to first-class citizen."""
        self.tier = "first"


@dataclass
class CategorySummary:
    """LLM-compiled summary for a tool category.

    Generated once at registration time, cached on disk keyed by tools_hash.
    """

    category: str
    summary: str               # LLM-generated one-paragraph description
    tool_names: List[str]      # ordered list of tool names in this category
    tools_hash: str            # hash of all tool definitions → cache invalidation

    # ------------------------------------------------------------------
    # Serialisation
    # ------------------------------------------------------------------
    def to_dict(self) -> Dict[str, Any]:
        return {
            "category": self.category,
            "summary": self.summary,
            "tool_names": self.tool_names,
            "tools_hash": self.tools_hash,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "CategorySummary":
        return cls(
            category=d["category"],
            summary=d["summary"],
            tool_names=d["tool_names"],
            tools_hash=d["tools_hash"],
        )


@dataclass
class CategoryAgentSpec:
    """Exposed as a pseudo-tool for second-class category dispatch.

    When the AI calls `agent://<category>`, a lightweight sub-agent is spawned
    with the full tool list for that category.
    """

    category: str
    summary: CategorySummary

    def to_openai_tool(self) -> Dict[str, Any]:
        """Expose as a tool that the LLM can call."""
        return {
            "type": "function",
            "function": {
                "name": f"agent_{self.category}",
                "description": (
                    f"调用 {self.category} 分类下的工具。"
                    f"该分类包含 {len(self.summary.tool_names)} 个工具。\n"
                    f"{self.summary.summary}\n\n"
                    f"可用工具: {', '.join(self.summary.tool_names)}\n"
                    f"请描述你需要完成的具体操作，代理将选择合适的工具执行。"
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": {
                            "type": "string",
                            "description": "对该分类下工具的具体调用需求描述",
                        }
                    },
                    "required": ["task"],
                },
            },
        }


# ---------------------------------------------------------------------------
# Tool result types
# ---------------------------------------------------------------------------

@dataclass
class ToolResult:
    """Structured return from a tool invocation."""

    success: bool
    content: str                       # the serialised / compressed result
    truncated: bool = False            # True when content exceeded max_result_size
    file_path: Optional[str] = None    # path if large output was written to disk
    output_scale: Literal["small", "medium", "large"] = "small"
    execution_time_ms: int = 0         # wall-clock time for the invocation

    # Sub-agent context (only populated for CategoryAgent calls)
    sub_agent_used: bool = False
    sub_agent_tool_calls: int = 0      # how many tool calls the sub-agent made


def classify_output_scale(chars: int) -> str:
    """Classify output size into scale buckets."""
    if chars <= 2000:
        return "small"
    elif chars <= 20000:
        return "medium"
    return "large"

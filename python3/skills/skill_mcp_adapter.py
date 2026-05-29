"""
MCP skill adapter — translates between skill invocation and MCP protocol.

Maps MCP tool inputSchema to skill capability descriptions and translates
skill invocations into MCP tools/call messages. Integrates with
SkillExecutor so MCP tools are callable like native skills.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from .skill_mcp import MCPConnectionManager, make_skill_name
from .skill_types import (
    ErrorCode,
    InvocationResult,
)

logger = logging.getLogger(__name__)


class MCPSkillAdapter:
    """Bridges skill invocations to MCP tool calls."""

    def __init__(self, connection_manager: MCPConnectionManager):
        self._manager = connection_manager

    def invoke(
        self,
        skill_name: str,
        arguments: dict[str, Any] | None = None,
    ) -> InvocationResult:
        """Invoke an MCP-backed skill by translating to MCP tool call.

        Args:
            skill_name: Skill name in format "mcp-<server>-<tool>".
            arguments: Arguments to pass to the MCP tool.

        Returns:
            InvocationResult from the MCP tool call.
        """
        server_name, tool_name = self._parse_skill_name(skill_name)
        if server_name is None:
            return InvocationResult(
                success=False,
                error=f"Not an MCP skill: {skill_name}",
                error_code=ErrorCode.SKILL_EXECUTION_ERROR,
                recoverable=False,
            )

        conn = self._manager.get_connection(server_name)
        if conn is None:
            return InvocationResult(
                success=False,
                error=f"MCP server '{server_name}' not configured",
                error_code=ErrorCode.SKILL_UNAVAILABLE,
                recoverable=True,
            )

        if not conn.connected:
            return InvocationResult(
                success=False,
                error=f"MCP server '{server_name}' not connected",
                error_code=ErrorCode.SKILL_UNAVAILABLE,
                recoverable=True,
            )

        return self._manager.call_tool_sync(
            server_name, tool_name, arguments
        )

    def is_mcp_skill(self, skill_name: str) -> bool:
        """Check if a skill name is an MCP-backed skill."""
        server, _ = self._parse_skill_name(skill_name)
        return server is not None

    def get_server_for_skill(self, skill_name: str) -> str | None:
        """Return the MCP server name for a skill, or None."""
        server, _ = self._parse_skill_name(skill_name)
        return server

    @staticmethod
    def _parse_skill_name(
        skill_name: str,
    ) -> tuple[str | None, str]:
        """Parse 'mcp-<server>-<tool>' into (server, tool).

        Returns (None, skill_name) if not an MCP skill.
        """
        if not skill_name.startswith("mcp-"):
            return None, skill_name
        # Remove 'mcp-' prefix, split into server and tool
        remainder = skill_name[4:]
        # The server name is everything up to the last '-' segment
        # Format: mcp-<server-name>-<tool-name>
        # We need to match against known servers
        # Simple approach: split on '-' and try combinations
        parts = remainder.split("-")
        if len(parts) < 2:
            return None, skill_name
        # Tool name is the last segment(s), server is the rest
        # But we can't know the split without server list
        # Convention: server-name is everything except last segment
        server = "-".join(parts[:-1])
        tool = parts[-1]
        return server, tool

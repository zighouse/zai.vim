"""
MCP connection manager — connect to MCP servers and discover tools.

Manages stdio and streamable HTTP connections to MCP servers, discovers
tools via tools/list, and registers them as skills in the unified registry.
Each operation (discover, call) opens its own session to avoid stale
connection issues with async context managers across asyncio.run() calls.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, Optional

from .skill_registry import SkillRegistry
from .skill_types import (
    ErrorCode,
    InvocationResult,
    SecurityDomain,
    SkillMetadata,
    SkillOrigin,
    SkillStatus,
    TrustLevel,
)
from .skill_evolution import TrustEvolution

logger = logging.getLogger(__name__)

_SANITIZED_RE = re.compile(r"[^a-z0-9-]")
_MULTI_DASH_RE = re.compile(r"-{2,}")


def sanitize_name(name: str) -> str:
    """Sanitize a tool/server name to kebab-case for skill registration."""
    sanitized = name.lower().replace("_", "-").replace(" ", "-")
    sanitized = _SANITIZED_RE.sub("-", sanitized)
    sanitized = _MULTI_DASH_RE.sub("-", sanitized)
    sanitized = sanitized.strip("-")
    return sanitized or "unknown-tool"


def make_skill_name(server_name: str, tool_name: str) -> str:
    """Create skill name from server and tool name: mcp-<server>-<tool>."""
    return f"mcp-{sanitize_name(server_name)}-{sanitize_name(tool_name)}"


class MCPServerConnection:
    """Manages configuration and cached state for one MCP server."""

    def __init__(self, server_name: str, config: dict):
        self.name = server_name
        self.config = config
        self.transport = config.get("transport", "stdio")
        self._connected = False
        self._tools_cache: dict[str, dict] = {}  # tool_name -> inputSchema

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def tools(self) -> dict[str, dict]:
        return dict(self._tools_cache)

    async def discover_tools(self) -> list[dict]:
        """Open a session, discover tools, cache them, then close.

        Returns list of tool dicts: {"name": ..., "inputSchema": ...}
        """
        try:
            if self.transport == "stdio":
                return await self._discover_stdio()
            elif self.transport in ("streamable_http", "http"):
                return await self._discover_http()
            else:
                raise ValueError(f"Unsupported transport: {self.transport}")
        except Exception as e:
            logger.warning(
                "MCP server %s discovery failed: %s", self.name, e
            )
            self._connected = False
            return []

    async def _discover_stdio(self) -> list[dict]:
        from mcp.client.stdio import stdio_client, StdioServerParameters
        from mcp import ClientSession

        command = self.config.get("command", "")
        args = self.config.get("args", [])
        env = self.config.get("env", {})

        server_params = StdioServerParameters(
            command=command, args=args, env=env or None,
        )

        async with stdio_client(server_params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.list_tools()
                self._connected = True
                return self._cache_tools(result.tools)

    async def _discover_http(self) -> list[dict]:
        from mcp.client.streamable_http import streamablehttp_client
        from mcp import ClientSession

        url = self.config.get("url", "")
        if not url:
            raise ValueError("HTTP transport requires 'url' in config")

        async with streamablehttp_client(url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.list_tools()
                self._connected = True
                return self._cache_tools(result.tools)

    async def call_tool(
        self, tool_name: str, arguments: dict[str, Any] | None = None,
    ) -> Any:
        """Open a session, call a tool, then close."""
        if self.transport == "stdio":
            return await self._call_stdio(tool_name, arguments)
        elif self.transport in ("streamable_http", "http"):
            return await self._call_http(tool_name, arguments)
        raise ValueError(f"Unsupported transport: {self.transport}")

    async def _call_stdio(self, tool_name: str, arguments: dict | None):
        from mcp.client.stdio import stdio_client, StdioServerParameters
        from mcp import ClientSession

        command = self.config.get("command", "")
        args = self.config.get("args", [])
        env = self.config.get("env", {})
        server_params = StdioServerParameters(
            command=command, args=args, env=env or None,
        )

        async with stdio_client(server_params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return await session.call_tool(tool_name, arguments)

    async def _call_http(self, tool_name: str, arguments: dict | None):
        from mcp.client.streamable_http import streamablehttp_client
        from mcp import ClientSession

        url = self.config.get("url", "")
        async with streamablehttp_client(url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return await session.call_tool(tool_name, arguments)

    def _cache_tools(self, tools) -> list[dict]:
        """Cache tool definitions and return as dicts."""
        result = []
        self._tools_cache.clear()
        for tool in tools:
            schema = {}
            if hasattr(tool, "inputSchema") and tool.inputSchema:
                schema = (
                    tool.inputSchema
                    if isinstance(tool.inputSchema, dict) else {}
                )
            self._tools_cache[tool.name] = schema
            result.append({
                "name": tool.name,
                "description": getattr(tool, "description", "") or "",
                "inputSchema": schema,
            })
        return result

    def mark_disconnected(self):
        """Mark connection as disconnected."""
        self._connected = False


class MCPConnectionManager:
    """Manages all MCP server connections and tool registration."""

    def __init__(self, registry: SkillRegistry):
        self._registry = registry
        self._servers: dict[str, MCPServerConnection] = {}

    def load_config(self, config: dict) -> None:
        """Load MCP server configurations.

        Config format:
        {
            "mcp_servers": [
                {
                    "name": "server-name",
                    "transport": "stdio",
                    "command": "python",
                    "args": ["-m", "my_mcp_server"]
                },
                ...
            ]
        }
        """
        servers = config.get("mcp_servers", [])
        for server_conf in servers:
            name = server_conf.get("name", "")
            if not name:
                logger.warning("MCP config: server missing 'name', skipping")
                continue
            self._servers[name] = MCPServerConnection(
                server_name=name, config=server_conf
            )

    def connect_all(self) -> dict[str, list[dict]]:
        """Connect to all configured MCP servers synchronously.

        Returns {server_name: [tool_dicts]} for each successfully
        connected server.
        """
        results: dict[str, list[dict]] = {}
        for name, conn in self._servers.items():
            try:
                tools = asyncio.run(conn.discover_tools())
                if tools:
                    self._register_tools(name, tools)
                    results[name] = tools
                    logger.info(
                        "MCP server %s: %d tools discovered",
                        name, len(tools),
                    )
            except Exception as e:
                logger.warning(
                    "MCP server %s connection failed: %s", name, e
                )
        return results

    def _register_tools(self, server_name: str, tools: list[dict]) -> None:
        """Register discovered MCP tools as skills."""
        for tool in tools:
            skill_name = make_skill_name(server_name, tool["name"])
            description = tool.get("description", "")
            input_schema = tool.get("inputSchema", {})
            domain = self._infer_domain(input_schema)

            meta = SkillMetadata(
                name=skill_name,
                description=(
                    f"[MCP:{server_name}] {description}"
                    if description
                    else f"MCP tool from {server_name}"
                ),
                security_domain=domain,
                origin=SkillOrigin.ADAPTED,
                trust_level=TrustLevel.L1,
                output_schema=json.dumps(input_schema, sort_keys=True)
                if input_schema else "",
            )

            existing = self._registry.get(skill_name)
            if existing is not None:
                meta.trust_level = existing.trust_level
                meta.status = existing.status
            self._registry.register(meta)

    @staticmethod
    def _infer_domain(input_schema: dict) -> SecurityDomain:
        """Infer security domain from tool's input schema."""
        schema_str = str(input_schema).lower()
        if any(kw in schema_str for kw in ("url", "http", "fetch", "network")):
            return SecurityDomain.PUBLIC
        if any(kw in schema_str for kw in ("path", "file", "directory")):
            return SecurityDomain.WORKSPACE
        return SecurityDomain.WORKSPACE

    def get_connection(self, server_name: str) -> MCPServerConnection | None:
        """Get a server connection by name."""
        return self._servers.get(server_name)

    def call_tool_sync(
        self,
        server_name: str,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
    ) -> InvocationResult:
        """Call a tool on an MCP server synchronously."""
        conn = self._servers.get(server_name)
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
        try:
            result = asyncio.run(conn.call_tool(tool_name, arguments))
            content = []
            if hasattr(result, "content"):
                for item in result.content:
                    if hasattr(item, "text"):
                        content.append(item.text)
            is_error = getattr(result, "isError", False)
            if is_error:
                return InvocationResult(
                    success=False,
                    error="; ".join(content) if content else "MCP tool error",
                    error_code="MCP_TOOL_ERROR",
                    recoverable=True,
                )
            return InvocationResult(
                success=True,
                data={"content": content},
            )
        except Exception as e:
            return InvocationResult(
                success=False,
                error=f"MCP tool call failed: {e}",
                error_code="MCP_TOOL_ERROR",
                recoverable=True,
            )

    def mark_unavailable(self, server_name: str) -> None:
        """Mark all tools from a server as unavailable."""
        conn = self._servers.get(server_name)
        if conn is None:
            return
        conn.mark_disconnected()
        for tool_name in conn.tools:
            skill_name = make_skill_name(server_name, tool_name)
            meta = self._registry.get(skill_name)
            if meta:
                meta.status = SkillStatus.UNAVAILABLE

    def reconnect(
        self,
        server_name: str,
        trust_evolution: Optional[TrustEvolution] = None,
    ) -> InvocationResult:
        """Reconnect to a disconnected MCP server.

        Compares new tool schemas with cached ones. Schema changes
        trigger trust downgrade to L1.
        """
        conn = self._servers.get(server_name)
        if conn is None:
            return InvocationResult(
                success=False,
                error=f"MCP server '{server_name}' not configured",
                error_code=ErrorCode.SKILL_NOT_FOUND,
                recoverable=False,
            )

        old_schemas = dict(conn.tools)

        try:
            tools = asyncio.run(conn.discover_tools())
        except Exception as e:
            self.mark_unavailable(server_name)
            return InvocationResult(
                success=False,
                error=f"Reconnect failed: {e}",
                error_code=ErrorCode.SKILL_UNAVAILABLE,
                recoverable=True,
            )

        if not tools:
            return InvocationResult(
                success=False,
                error="Reconnect succeeded but no tools found",
                error_code=ErrorCode.SKILL_UNAVAILABLE,
                recoverable=True,
            )

        # Compare schemas and update trust
        schema_changes = []
        for tool in tools:
            tool_name = tool["name"]
            new_schema = tool.get("inputSchema", {})
            old_schema = old_schemas.get(tool_name)
            skill_name = make_skill_name(server_name, tool_name)

            if old_schema is not None and old_schema != new_schema:
                meta = self._registry.get(skill_name)
                if meta:
                    meta.trust_level = TrustLevel.L1
                if trust_evolution:
                    state = trust_evolution.get_state(skill_name)
                    state.last_schema = json.dumps(
                        new_schema, sort_keys=True
                    )
                schema_changes.append(tool_name)
            elif trust_evolution:
                state = trust_evolution.get_state(skill_name)
                state.last_schema = json.dumps(new_schema, sort_keys=True)

        self._register_tools(server_name, tools)

        # Mark removed tools as unavailable
        new_tool_names = {t["name"] for t in tools}
        for old_tool in old_schemas:
            if old_tool not in new_tool_names:
                skill_name = make_skill_name(server_name, old_tool)
                meta = self._registry.get(skill_name)
                if meta:
                    meta.status = SkillStatus.UNAVAILABLE

        return InvocationResult(
            success=True,
            data={
                "server": server_name,
                "tools_discovered": len(tools),
                "schema_changes": schema_changes,
            },
        )

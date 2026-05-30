#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
ToolPool: auto-registered tool management with tier-aware discovery.

Replaces the old ToolManager.  Tools are auto-discovered from tool_*.json
+ tool_*.py at startup — no manual use_tool() needed.
"""

import json
import sys
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


class ToolHookBlocked(Exception):
    """Raised when a pre-tool hook blocks execution."""
    def __init__(self, reason: str):
        super().__init__(f"[HOOK_BLOCKED] {reason}")


class ToolNotFound(Exception):
    """Raised when the requested tool function is not registered."""
    def __init__(self, name: str):
        super().__init__(f"[TOOL_NOT_FOUND] unknown tool function `{name}`")

from hooks import HookManager
from tool_spec import (
    ToolResult,
    ToolSpec,
    classify_output_scale,
)
from tool_registry import ToolRegistry, get_registry, init_registry
from tool_sub_agent import ToolSubAgent
from toolcommon import set_sandbox_home, sandbox_home

# Agent prefix for second-class category dispatch
_AGENT_PREFIX = "agent_"
_AGENT_MAX_RECURSION_DEPTH = 2

# Thread-local to prevent unbounded recursive agent_agent nesting
_agent_recursion = threading.local()


def _get_agent_depth() -> int:
    """Get current agent call depth for this thread."""
    return getattr(_agent_recursion, "depth", 0)


def _inc_agent_depth() -> int:
    """Increment agent call depth, return new depth."""
    depth = getattr(_agent_recursion, "depth", 0) + 1
    _agent_recursion.depth = depth
    return depth


def _dec_agent_depth():
    """Decrement agent call depth."""
    depth = getattr(_agent_recursion, "depth", 1) - 1
    _agent_recursion.depth = max(depth, 0)


class ToolPool:
    """Auto-discovered tool pool with tier-aware exposure.

    On construction, tools are auto-scanned and organised.  The pool exposes
    first-class tools directly and second-class tools through category agents.
    """

    def __init__(self, tools_dir: Optional[str] = None):
        self._registry: Optional[ToolRegistry] = None
        self._tools_dir = tools_dir
        self._hook_manager: Optional[HookManager] = None
        self._llm_fn: Optional[Callable] = None
        self._initialised = False

    # ------------------------------------------------------------------
    # Initialisation
    # ------------------------------------------------------------------

    def _ensure_initialised(self):
        """Lazy init: scan + cache on first use."""
        if self._initialised:
            return
        self._registry = get_registry(tools_dir=self._tools_dir)
        if self._registry.tool_count == 0:
            self._registry.scan()
            self._registry.load_from_cache()
        self._initialised = True

    def compile_categories(self, llm_fn: Callable):
        """Compile LLM category summaries (call after LLM is available)."""
        self._ensure_initialised()
        self._registry.compile_categories(llm_fn)

    # ------------------------------------------------------------------
    # Tool exposure (replaces old get_tools / use_tool)
    # ------------------------------------------------------------------

    def get_tools(self, excludes=None) -> List[Dict[str, Any]]:
        """Return tools to include in the API request.

        First-class tools (full schema) + category agents (for second-class).
        """
        self._ensure_initialised()
        tools = self._registry.get_all_api_tools()
        if not excludes:
            return tools
        exclude_names = set()
        for ex in excludes:
            fn = ex.get("function", {})
            if fn.get("name"):
                exclude_names.add(fn["name"])
        return [t for t in tools
                if t.get("function", {}).get("name") not in exclude_names]

    def get_category_tools(self, category: str) -> List[Dict[str, Any]]:
        """Get all tool definitions for a category (used by sub-agents)."""
        self._ensure_initialised()
        return self._registry.get_category_tools(category)

    def get_category_invokers(self, category: str) -> List:
        """Get (ToolSpec, callable) pairs for all tools in a category."""
        self._ensure_initialised()
        return self._registry.get_category_invokers(category)

    # ------------------------------------------------------------------
    # Tool execution
    # ------------------------------------------------------------------

    def call_tool(self, function_name: str, arguments: dict) -> Any:
        """Execute a tool by name with hook support and result handling.

        Supports pre/post hooks, result size management, and call tracking.
        Agent-prefixed calls (agent_*) are routed to ToolSubAgent.
        """
        self._ensure_initialised()

        # ---- Agent dispatch: route agent_* calls to sub-agents ----
        if function_name.startswith(_AGENT_PREFIX):
            return self._dispatch_agent(function_name, arguments)

        # ---- Normal tool dispatch ----

        # Run pre-tool hooks
        if self._hook_manager and self._hook_manager.has_hooks(
            HookManager.PRE_TOOL_USE
        ):
            continue_exec, stop_reason, updated_input = (
                self._hook_manager.run_pre_tool_hooks(function_name, arguments)
            )
            if not continue_exec:
                raise ToolHookBlocked(stop_reason)
            if updated_input is not None:
                arguments = updated_input

        invoker = self._registry.get_invoker(function_name)
        if invoker is None:
            raise ToolNotFound(function_name)

        try:
            result = invoker(**arguments)
        except Exception as ex:
            # Post-tool-failure hooks
            if self._hook_manager and self._hook_manager.has_hooks(
                HookManager.POST_TOOL_USE_FAILURE
            ):
                self._hook_manager.run_post_tool_failure_hooks(
                    function_name, arguments, str(ex)
                )
            self._registry.record_call(function_name, is_error=True)
            raise

        # Serialise & measure
        if isinstance(result, str):
            serialized = result
        else:
            serialized = json.dumps(result, indent=2, ensure_ascii=False)

        result_chars = len(serialized)

        # Large result handling: write to file if over threshold
        spec = self._registry.get_tool(function_name)
        truncated = False
        file_path = None
        if spec and spec.max_result_size > 0 and result_chars > spec.max_result_size:
            truncated = True
            # Write the full content to a temp file
            file_path = self._write_large_result(function_name, serialized)
            # Build a helpful truncation notice with pagination hint
            continuation_hint = ""
            if function_name == "read_file":
                continuation_hint = " 使用 offset 参数继续读取后续内容。"
            serialized = (
                f"{serialized[: spec.max_result_size]}\n\n"
                f"[截断: 仅显示了 {spec.max_result_size} 字符。"
                f"{continuation_hint}]"
            )

        # Post-tool hooks
        if self._hook_manager and self._hook_manager.has_hooks(
            HookManager.POST_TOOL_USE
        ):
            continue_exec, extra = self._hook_manager.run_post_tool_hooks(
                function_name, arguments, serialized
            )
            if extra:
                serialized = f"{serialized}\n[hook] {extra}"

        # Track call statistics
        self._registry.record_call(function_name, result_chars)

        return serialized

    def _write_large_result(self, function_name: str, content: str) -> str:
        """Write oversized tool output to a temp file, return the path."""
        sandbox_root = sandbox_home()
        out_dir = sandbox_root / ".tool_outputs"
        out_dir.mkdir(parents=True, exist_ok=True)
        # Evict oldest files if over limit
        self._evict_old_results(out_dir, max_files=50)
        import time
        ts = int(time.time() * 1000)
        fname = f"{function_name}_{ts}.txt"
        fpath = out_dir / fname
        fpath.write_text(content, encoding="utf-8")
        return str(fpath)

    @staticmethod
    def _evict_old_results(out_dir: Path, max_files: int = 50):
        """Remove oldest .txt files exceeding max_files."""
        files = sorted(out_dir.glob("*.txt"), key=lambda p: p.stat().st_mtime)
        if len(files) > max_files:
            for old in files[:len(files) - max_files]:
                try:
                    old.unlink()
                except OSError:
                    pass

    # ------------------------------------------------------------------
    # Sub-agent dispatch
    # ------------------------------------------------------------------

    def _dispatch_agent(self, function_name: str, arguments: dict) -> str:
        """Route an agent_{category} call to a ToolSubAgent.

        Includes recursion guard: agent_agent calls beyond the configured
        depth are rejected to prevent unbounded nesting.
        """
        category = function_name[len(_AGENT_PREFIX):]
        task = arguments.get("task", "")

        if not task:
            return f"[{function_name}] ERROR: missing 'task' argument"

        if self._llm_fn is None:
            return f"[{function_name}] ERROR: LLM function not configured"

        # Recursion guard
        depth = _inc_agent_depth()
        try:
            if depth > _AGENT_MAX_RECURSION_DEPTH:
                return (
                    f"[{function_name}] ERROR: max recursion depth "
                    f"({_AGENT_MAX_RECURSION_DEPTH}) exceeded. "
                    f"The agent_{category} tool cannot spawn nested agents."
                )

            tools = self.get_category_tools(category)
            invokers = self.get_category_invokers(category)

            if not tools:
                return (
                    f"[{function_name}] ERROR: category "
                    f"'{category}' has no tools"
                )

            agent = ToolSubAgent(
                category=category,
                category_tools=tools,
                category_invokers=invokers,
                llm_fn=self._llm_fn,
            )

            result = agent.run(task)
            print(f"[agent:{category}] {agent._tool_calls_made} tool call(s), "
                  f"{agent._errors} error(s)", file=sys.stderr)
            return result
        finally:
            _dec_agent_depth()

    def set_llm_fn(self, llm_fn: Callable):
        """Set the LLM function used for sub-agent dispatch."""
        self._llm_fn = llm_fn

    # ------------------------------------------------------------------
    # Display / introspection
    # ------------------------------------------------------------------

    def show_tools(self):
        """Display all tools grouped by category and tier."""
        self._ensure_initialised()
        categories = self._registry.build_categories()
        stats = self._registry.stats()

        print(f"\n总工具数: {stats['total_tools']} "
              f"({stats['first_class']} 一等, {stats['second_class']} 二等)\n")

        for cat_name, tool_names in sorted(categories.items()):
            print(f"  {cat_name}:")
            for name in tool_names:
                spec = self._registry.get_tool(name)
                if spec is None:
                    continue
                tier_mark = "★" if spec.tier == "first" else " "
                read_mark = "R" if spec.is_read_only else "W"
                print(f"    [{tier_mark}] [{read_mark}] {name}")
                if spec.prompt:
                    # Show first line of prompt as hint
                    first_line = spec.prompt.split("\n")[0][:80]
                    print(f"          {first_line}")

    def show_list(self):
        """List all tool categories."""
        self._ensure_initialised()
        cats = self._registry.build_categories()
        if not cats:
            print("No tools found.")
            return
        for cat_name, names in sorted(cats.items()):
            first_count = sum(
                1 for n in names
                if self._registry.get_tool(n)
                and self._registry.get_tool(n).tier == "first"
            )
            print(f"  {cat_name}: {len(names)} tools ({first_count} first-class)")

    def show_toolset(self, toolset_name: Optional[str] = None):
        """Show details for a category or all tools."""
        self._ensure_initialised()

        if toolset_name is None:
            # Show all categories
            self.show_list()
            return

        # Show specific category tools
        tools = self._registry.get_category_tools(toolset_name, include_first_class=True)
        if not tools:
            print(f"Category `{toolset_name}` not found.")
            return

        print(f"\n{toolset_name}:")
        for t in tools:
            fn = t.get("function", {})
            name = fn.get("name", "?")
            desc = fn.get("description", "").split("\n")[0][:100]
            spec = self._registry.get_tool(name)
            tier = spec.tier if spec else "?"
            print(f"  [{tier}] {name}: {desc}")

    def show_sandbox_home(self):
        print(f"sandbox home:\n  {sandbox_home()}")

    def set_sandbox_home(self, new_path: str):
        try:
            new_path = set_sandbox_home(new_path)
            print(f"set sandbox home succeed, new sandbox home:\n  {new_path}")
        except Exception as e:
            print(f"ERROR failed set sandbox home, error:{e}")

    # ------------------------------------------------------------------
    # Hook management
    # ------------------------------------------------------------------

    def set_hook_manager(self, hook_manager: HookManager):
        self._hook_manager = hook_manager

    def get_hook_manager(self) -> Optional[HookManager]:
        return self._hook_manager

    def load_hooks(self, config: dict, llm_fn=None):
        if self._hook_manager is None:
            self._hook_manager = HookManager(llm_fn=llm_fn)
        if llm_fn and self._hook_manager:
            from hooks import HookRunner
            self._hook_manager._runner._llm_fn = llm_fn
        self._hook_manager.load_from_dict(config)

    def show_hooks(self):
        if self._hook_manager:
            print(self._hook_manager.summary())
        else:
            print("  (no hooks configured)")

    # ------------------------------------------------------------------
    # Registry access
    # ------------------------------------------------------------------

    @property
    def registry(self) -> ToolRegistry:
        self._ensure_initialised()
        return self._registry

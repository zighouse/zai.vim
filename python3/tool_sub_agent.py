#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
Lightweight sub-agent for second-class tool dispatch.

When the main AI calls an agent_{category} tool, a ToolSubAgent is spawned
with the full tool list for that category.  It executes the requested
operation and returns a compressed result to the caller.

Key properties:
  - Only responsible for tool calling, not general conversation
  - Runs a bounded LLM loop (max 3 turns by default)
  - Compresses oversized results before returning
  - Reports failure status clearly
"""

import json
import sys
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_MAX_TURNS = 3
MAX_RESULT_CHARS = 6000   # compress results exceeding this
SUB_AGENT_SYSTEM_PROMPT = """\
You are a tool-calling agent. Your task is to select and call the appropriate tools
from the available list to fulfil the user's request.

Rules:
1. Only call tools from the list below — no other operations
2. After calling a tool, evaluate the result to decide if another call is needed
3. If one call completes the task, summarise and return
4. If a tool call fails, report the failure factually
5. Return only the key information needed, strip redundant content
6. Do not engage in conversation beyond tool calling"""


class ToolSubAgent:
    """Lightweight sub-agent that dispatches second-class tools.

    Created per-call by ToolPool when the main AI invokes an agent_{category}
    pseudo-tool.
    """

    def __init__(
        self,
        category: str,
        category_tools: List[Dict[str, Any]],       # OpenAI tool definitions
        category_invokers: List[Tuple[Any, Callable]],  # (ToolSpec, callable)
        llm_fn: Callable,                             # LLM completion function
        max_turns: int = DEFAULT_MAX_TURNS,
    ):
        self._category = category
        self._tools = category_tools
        self._invokers = {
            spec.name: invoker for spec, invoker in category_invokers
        }
        self._llm_fn = llm_fn
        self._max_turns = max_turns

        # Per-invocation stats
        self._tool_calls_made = 0
        self._errors = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def run(self, task: str) -> str:
        """Execute a task using the category's tools.

        Args:
            task: Natural-language description of what to do.

        Returns:
            Compressed result string (success or failure report).
        """
        messages = [
            {"role": "system", "content": SUB_AGENT_SYSTEM_PROMPT},
            {"role": "user", "content": (
                f"分类 [{self._category}] 下有以下工具可用:\n"
                + self._format_tool_list()
                + f"\n\n用户需求: {task}\n\n"
                + "请选择合适的工具并调用它来完成任务。"
            )},
        ]

        final_output = ""
        for turn in range(self._max_turns):
            try:
                response = self._llm_fn(
                    messages=messages,
                    tools=self._tools,
                    tool_choice="auto",
                )
            except Exception as exc:
                return f"[agent_{self._category}] LLM call failed: {exc}"

            # Process response
            choice = response.get("choices", [{}])[0] if isinstance(response, dict) else None
            if choice is None:
                return f"[agent_{self._category}] no valid response received"

            msg = choice.get("message", {})
            content = msg.get("content", "")
            tool_calls = msg.get("tool_calls") or []

            if tool_calls:
                # Execute tool calls
                results = self._execute_tool_calls(tool_calls)
                # Feedback to LLM
                messages.append(msg)
                for r in results:
                    messages.append(r)
                if content:
                    final_output = content
            else:
                # No tool calls — the LLM decided it doesn't need one,
                # or it's providing a response
                if content:
                    final_output = content
                break

        # Compress if needed
        if len(final_output) > MAX_RESULT_CHARS:
            final_output = (
                final_output[:MAX_RESULT_CHARS]
                + f"\n\n[result compressed: {len(final_output)} → {MAX_RESULT_CHARS} chars]"
            )

        if not final_output:
            ok = "ok" if self._errors == 0 else f"{self._errors} errors"
            final_output = (
                f"[agent_{self._category}] completed. "
                f"{self._tool_calls_made} tool call(s), {ok}"
            )

        return final_output

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _format_tool_list(self) -> str:
        """Format the category's tool list for the sub-agent prompt."""
        lines = []
        for t in self._tools:
            fn = t.get("function", {})
            name = fn.get("name", "?")
            desc = fn.get("description", "").split("\n")[0][:120]
            lines.append(f"  - {name}: {desc}")
        return "\n".join(lines)

    def _execute_tool_calls(self, tool_calls: List[Dict]) -> List[Dict]:
        """Execute one or more tool calls and return result messages."""
        results = []
        for tc in tool_calls:
            fn = tc.get("function", {})
            name = fn.get("name", "")
            args_str = fn.get("arguments", "{}")

            try:
                args = json.loads(args_str) if isinstance(args_str, str) else args_str
            except json.JSONDecodeError:
                args = {}

            self._tool_calls_made += 1

            invoker = self._invokers.get(name)
            if invoker is None:
                self._errors += 1
                results.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "name": name,
                    "content": f"[ERROR] tool '{name}' not found in this category",
                })
                continue

            try:
                result = invoker(**args)
            except Exception as exc:
                self._errors += 1
                results.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "name": name,
                    "content": f"[ERROR] tool call failed: {exc}",
                })
                continue

            serialized = (
                result if isinstance(result, str)
                else json.dumps(result, indent=2, ensure_ascii=False)
            )

            # Truncate individual tool results to avoid overwhelming the sub-agent LLM
            if len(serialized) > MAX_RESULT_CHARS:
                serialized = (
                    serialized[:MAX_RESULT_CHARS]
                    + f"\n\n[truncated: full output was {len(serialized)} chars]"
                )

            results.append({
                "role": "tool",
                "tool_call_id": tc.get("id", ""),
                "name": name,
                "content": serialized,
            })

        return results


# ---------------------------------------------------------------------------
# Factory for ToolPool integration
# ---------------------------------------------------------------------------

def create_sub_agent(
    category: str,
    get_category_tools_fn: Callable[[str], List[Dict[str, Any]]],
    get_category_invokers_fn: Callable,
    llm_fn: Callable,
    max_turns: int = DEFAULT_MAX_TURNS,
) -> ToolSubAgent:
    """Create a sub-agent with the tools/invokers for a given category."""
    tools = get_category_tools_fn(category)
    invokers = get_category_invokers_fn(category)
    return ToolSubAgent(
        category=category,
        category_tools=tools,
        category_invokers=invokers,
        llm_fn=llm_fn,
        max_turns=max_turns,
    )

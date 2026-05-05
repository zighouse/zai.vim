#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
Sub-agent system for zai.vim.

Allows the main LLM to spawn autonomous sub-agents that run their own
LLM loop with tool access. Inspired by Claude Code's AgentTool.

Design:
  - SubAgent runs a bounded LLM loop (max_turns)
  - Shares parent's ToolManager instance (synchronous, no concurrency issues)
  - Parent references injected via module-level init()
  - Results returned as string to the parent LLM's tool call
"""

import json
import os
import sys
import time
import random
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from openai import OpenAI, BadRequestError, APIError, APIConnectionError, RateLimitError

# ---------------------------------------------------------------------------
# Module-level state (set by init())
# ---------------------------------------------------------------------------
_parent_config: Dict[str, Any] = {}
_parent_llm_getter: Optional[Callable[[], OpenAI]] = None
_parent_tool = None  # ToolManager instance
_parent_count_tokens_fn: Optional[Callable[[str], int]] = None

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_AGENT_TOOL_RESULT_LIMIT = 8000   # max chars for a tool result in sub-agent
_MAX_TURN_HARD_LIMIT = 20         # hard upper bound on max_turns


def init(config: Dict[str, Any],
         llm_getter: Callable[[], Optional[OpenAI]],
         tool,
         count_tokens_fn: Callable[[str], int]) -> None:
    """Initialize module-level references from the parent AIChat instance.

    Must be called once during AIChat.__init__.
    """
    global _parent_config, _parent_llm_getter, _parent_tool, _parent_count_tokens_fn
    _parent_config = config
    _parent_llm_getter = llm_getter
    _parent_tool = tool
    _parent_count_tokens_fn = count_tokens_fn


# ---------------------------------------------------------------------------
# System prompt builders
# ---------------------------------------------------------------------------

def _get_date_string() -> str:
    """Return current date string for system prompt."""
    return datetime.now().strftime("%Y-%m-%d")


def _build_system_prompt(agent_type: str) -> str:
    """Build a system prompt for the given agent type."""
    date_str = _get_date_string()
    is_zh = 'zh' in os.getenv('LANG', '') or 'zh' in os.getenv('LANGUAGE', '')

    if agent_type == "explore":
        if is_zh:
            return (
                "你是一个代码探索代理。你的任务是搜索、阅读和分析代码/文件来回答问题。\n"
                "你可以使用 ls, read_file, search_in_file, grep, web_search, web_get_content 等只读工具。\n"
                "不要修改任何文件。快速定位相关信息并清晰呈现。\n"
                f"当前日期: {date_str}"
            )
        return (
            "You are an exploration agent. Your job is to search, read, and analyze code/files "
            "to answer questions. You may use read-only tools (ls, read_file, search_in_file, grep, "
            "web_search, web_get_content) to gather information.\n"
            "Do NOT modify any files. Focus on finding relevant information quickly and presenting it clearly.\n"
            f"Current date: {date_str}"
        )

    if agent_type == "plan":
        if is_zh:
            return (
                "你是一个规划代理。分析任务并产出详细的实施计划。\n"
                "你可以使用只读工具来理解代码库。你的输出应该是结构化的计划，\n"
                "包含清晰的步骤、依赖关系和潜在挑战。\n"
                "不要修改任何文件。\n"
                f"当前日期: {date_str}"
            )
        return (
            "You are a planning agent. Analyze the task and produce a detailed implementation plan. "
            "You may use read-only tools to understand the codebase. Your output should be a "
            "structured plan with clear steps, dependencies, and potential challenges.\n"
            "Do NOT modify any files.\n"
            f"Current date: {date_str}"
        )

    # Default: general-purpose
    if is_zh:
        return (
            "你是一个自主 AI 助手，正在执行一个子任务。你可以使用所有可用的工具。\n"
            "请系统性地完成工作：\n"
            "1. 将任务分解为步骤\n"
            "2. 使用工具收集信息和执行操作\n"
            "3. 将发现综合成清晰、简洁的答案\n"
            "完成任务后，提供你的最终答案。\n"
            f"当前日期: {date_str}"
        )
    return (
        "You are an autonomous AI assistant executing a sub-task. You have access to tools "
        "and should use them as needed to complete the task. Work systematically:\n"
        "1. Break down the task into steps\n"
        "2. Use tools to gather information and perform actions\n"
        "3. Synthesize findings into a clear, concise answer\n\n"
        "When you have completed the task, provide your final answer. Be thorough but concise.\n"
        f"Current date: {date_str}"
    )


# ---------------------------------------------------------------------------
# SubAgent class
# ---------------------------------------------------------------------------

class SubAgent:
    """An autonomous sub-agent that runs a bounded LLM loop with tool access.

    Usage:
        agent = SubAgent(task="Find all TODO comments in src/", agent_type="explore")
        result = agent.run()
    """

    def __init__(self, task: str, agent_type: str = "general", max_turns: int = 10):
        self._task = task
        self._agent_type = agent_type
        self._max_turns = min(max(1, max_turns), _MAX_TURN_HARD_LIMIT)
        self._messages: List[Dict[str, Any]] = []
        self._turn_count = 0
        self._tool_use_count = 0
        self._final_answer = ""

    def run(self) -> str:
        """Run the sub-agent and return the final answer as a string."""
        if not _parent_llm_getter:
            return "[Agent Error] Agent module not initialized. Call agent.init() first."

        llm = _parent_llm_getter()
        if not llm:
            return "[Agent Error] LLM client not available."

        # Build initial messages
        system_prompt = _build_system_prompt(self._agent_type)
        self._messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": self._task},
        ]

        # Progress banner
        task_preview = self._task[:80] + ("..." if len(self._task) > 80 else "")
        print(f"[agent] Starting {self._agent_type} agent (max {self._max_turns} turns)", file=sys.stderr)
        print(f"[agent] Task: {task_preview}", file=sys.stderr)

        try:
            result = self._run_loop(llm)
        except Exception as e:
            result = self._final_answer or ""
            if result:
                result += f"\n\n[Agent Error] Unexpected error: {type(e).__name__}: {e}"
            else:
                result = f"[Agent Error] {type(e).__name__}: {e}"

        # Completion summary
        print(f"[agent] Completed in {self._turn_count} turns, {self._tool_use_count} tool calls",
              file=sys.stderr)
        return result

    def _run_loop(self, llm: OpenAI) -> str:
        """Core bounded LLM loop with tool call support."""
        # Get tools from parent, but exclude the agent tool itself (prevent recursion)
        tools = self._get_filtered_tools()

        for turn in range(self._max_turns):
            self._turn_count = turn + 1
            print(f"[agent turn {self._turn_count}/{self._max_turns}]", file=sys.stderr)

            # Build LLM params
            params = {
                'model': _parent_config.get('model', {}).get('name', ''),
                'messages': self._messages,
                'stream': True,
            }
            # Apply safe model params
            safe_opts = {'temperature', 'top_p', 'presence_penalty', 'frequency_penalty'}
            model_params = _parent_config.get('model', {}).get('params', {})
            params.update({k: v for k, v in model_params.items() if k in safe_opts})

            if tools:
                params['tools'] = tools

            # --- Streaming response ---
            full_response = {
                "role": "assistant",
                "content": "",
                "tool_calls": [],
            }
            full_content_parts = []
            reasoning_content = []

            try:
                stream = llm.chat.completions.create(**params)
            except (BadRequestError, APIError, APIConnectionError, RateLimitError) as e:
                print(f"[agent] LLM error on turn {self._turn_count}: {e}", file=sys.stderr)
                if self._final_answer:
                    return self._final_answer + f"\n\n[Agent Error] LLM call failed: {e}"
                return f"[Agent Error] LLM call failed: {e}"

            for chunk in stream:
                chunk_message = chunk.choices[0].delta

                # Reasoning content
                if hasattr(chunk_message, 'reasoning_content') and chunk_message.reasoning_content:
                    think = chunk_message.reasoning_content
                    if not reasoning_content and think.strip():
                        print('🤔', end='', flush=True)
                    if reasoning_content or think.strip():
                        print(think, end='', flush=True)
                        reasoning_content.append(think)
                    time.sleep(random.uniform(0.01, 0.03))

                # Tool calls (streaming accumulation)
                if hasattr(chunk_message, 'tool_calls') and chunk_message.tool_calls:
                    for tc in chunk_message.tool_calls:
                        idx = tc.index
                        while len(full_response['tool_calls']) <= idx:
                            full_response['tool_calls'].append({
                                'id': None, 'type': 'function',
                                'function': {'name': None, 'arguments': []}
                            })
                        entry = full_response['tool_calls'][idx]
                        if tc.id:
                            entry['id'] = tc.id
                        if tc.function:
                            if tc.function.name:
                                entry['function']['name'] = tc.function.name
                            if tc.function.arguments:
                                entry['function']['arguments'].append(tc.function.arguments)

                # Text content
                if chunk_message.content:
                    if not full_content_parts and reasoning_content:
                        print('\n\n---\n', end='', flush=True)
                    print(chunk_message.content, end='', flush=True)
                    full_content_parts.append(chunk_message.content)
                    time.sleep(random.uniform(0.01, 0.03))

            # Assemble final response
            if reasoning_content:
                print()  # newline after reasoning
            full_response['content'] = ''.join(full_content_parts)

            # Finalize tool_calls: join argument fragments
            if full_response['tool_calls']:
                for tc in full_response['tool_calls']:
                    tc['function']['arguments'] = ''.join(tc['function']['arguments'])

            # Add assistant message to history
            history_msg = {"role": "assistant", "content": full_response['content']}
            if full_response['tool_calls']:
                history_msg['tool_calls'] = full_response['tool_calls']
            self._messages.append(history_msg)

            # --- Process tool calls ---
            if full_response['tool_calls']:
                tool_returns = self._execute_tool_calls(full_response['tool_calls'])
                self._messages.extend(tool_returns)
                # Continue loop for next turn
            else:
                # No tool calls — this is the final answer
                self._final_answer = full_response['content']
                print()  # trailing newline
                break
        else:
            # Loop exhausted max_turns
            if not self._final_answer and full_response:
                self._final_answer = full_response.get('content', '')
            note = f"\n\n[Agent] Reached maximum turns ({self._max_turns}). Answer may be incomplete."
            self._final_answer = (self._final_answer or "") + note

        return self._final_answer

    def _get_filtered_tools(self) -> List[Dict[str, Any]]:
        """Get tools from parent, excluding the agent tool to prevent recursion."""
        if not _parent_tool:
            return []
        all_tools = _parent_tool.get_tools()
        return [t for t in all_tools
                if t.get('function', {}).get('name') != 'agent']

    def _execute_tool_calls(self, tool_calls: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Execute tool calls via the parent's ToolManager."""
        tool_returns = []
        for tc in tool_calls:
            fn_name = tc['function']['name']
            fn_args_str = tc['function'].get('arguments', '{}')
            print(f"[agent] calling: {fn_name}", file=sys.stderr)

            tool_response = {
                "tool_call_id": tc.get('id', ''),
                "role": "tool",
                "name": fn_name,
                "content": "ERROR: calling tool failed.",
            }
            try:
                fn_args = json.loads(fn_args_str) if fn_args_str else {}
                raw_result = _parent_tool.call_tool(fn_name, fn_args)
                tool_response["content"] = self._truncate_result(str(raw_result))
                self._tool_use_count += 1
            except Exception as e:
                print(f"[agent] tool_call `{fn_name}` error: {e}", file=sys.stderr)
                tool_response["content"] = f"[ERROR] {e}"
            finally:
                tool_returns.append(tool_response)
        return tool_returns

    @staticmethod
    def _truncate_result(result: str) -> str:
        """Truncate large tool results to prevent context bloat."""
        if not result or len(result) <= _AGENT_TOOL_RESULT_LIMIT:
            return result
        half = _AGENT_TOOL_RESULT_LIMIT // 2
        marker = f"...[truncated: {len(result)} chars total]..."
        return result[:half] + "\n" + marker + "\n" + result[-half:]

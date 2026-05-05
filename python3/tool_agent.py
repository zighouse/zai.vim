#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
Agent tool for zai.vim.

Provides invoke_agent() which spawns a SubAgent to autonomously complete
a task. Follows the standard tool pattern (invoke_{name}).
"""

import json
from typing import Any, Dict
from agent import SubAgent


def invoke_agent(task: str, agent_type: str = "general",
                 max_turns: int = 10) -> str:
    """
    Spawn a sub-agent to autonomously complete a task.

    The sub-agent runs its own LLM loop with access to currently-loaded tools.
    It can search files, read code, execute shell commands, etc.
    The sub-agent returns its final answer as a string.

    Args:
        task: The task description for the sub-agent
        agent_type: Type of agent - "general" (full autonomy),
                    "explore" (read-only investigation), or
                    "plan" (analysis and planning only)
        max_turns: Maximum number of LLM turns (default 10, max 20)

    Returns:
        The sub-agent's final answer as a string
    """
    max_turns = min(max(1, max_turns), 20)

    try:
        agent = SubAgent(task=task, agent_type=agent_type, max_turns=max_turns)
        result = agent.run()
        if not result:
            return "[Agent] Completed but produced no output."
        return result
    except Exception as e:
        return f"[Agent Error] {type(e).__name__}: {e}"

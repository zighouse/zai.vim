#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
Tool Hook System for zai.vim

Provides pre/post tool execution hooks with:
- Event types: PreToolUse, PostToolUse, PostToolUseFailure
- Hook types: command (shell), prompt (LLM), python (callable)
- Matcher-based filtering by tool name patterns
- Timeout and blocking semantics
- Configuration via YAML/JSON

Adapted from Claude Code's hook architecture for zai.vim's Python backend.
"""

import fnmatch
import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

try:
    import yaml
    HAVE_YAML = True
except ImportError:
    HAVE_YAML = False


# ---------------------------------------------------------------------------
# Hook data classes
# ---------------------------------------------------------------------------

class HookResult:
    """Result from a single hook execution."""
    def __init__(
        self,
        hook_name: str = "",
        continue_execution: bool = True,
        stop_reason: str = "",
        updated_input: Optional[dict] = None,
        additional_context: str = "",
        error: str = "",
    ):
        self.hook_name = hook_name
        self.continue_execution = continue_execution
        self.stop_reason = stop_reason
        self.updated_input = updated_input
        self.additional_context = additional_context
        self.error = error

    def __repr__(self):
        status = "OK" if self.continue_execution else "BLOCKED"
        return f"HookResult({self.hook_name}: {status})"


class HookContext:
    """Context data passed to hook runners."""
    def __init__(
        self,
        event: str,
        tool_name: str = "",
        tool_input: Optional[dict] = None,
        tool_output: Any = None,
        tool_error: str = "",
    ):
        self.event = event
        self.tool_name = tool_name
        self.tool_input = tool_input or {}
        self.tool_output = tool_output
        self.tool_error = tool_error

    def to_env_dict(self) -> Dict[str, str]:
        """Convert to environment variable dict for command hooks."""
        env = {
            "ZAI_HOOK_EVENT": self.event,
            "ZAI_TOOL_NAME": self.tool_name,
        }
        if self.tool_input:
            env["ZAI_TOOL_INPUT"] = json.dumps(self.tool_input, ensure_ascii=False)
        if self.tool_output is not None:
            output_str = self.tool_output if isinstance(self.tool_output, str) else json.dumps(self.tool_output, ensure_ascii=False)
            env["ZAI_TOOL_OUTPUT"] = output_str
        if self.tool_error:
            env["ZAI_TOOL_ERROR"] = self.tool_error
        return env


# ---------------------------------------------------------------------------
# Hook definition
# ---------------------------------------------------------------------------

class HookDef:
    """A single hook definition from configuration."""
    def __init__(
        self,
        hook_type: str,          # "command" | "prompt" | "python"
        command: str = "",
        prompt: str = "",
        python_callable: Optional[str] = "",  # "module.function"
        timeout: int = 30,
        status_message: str = "",
        condition: str = "",      # matcher pattern for conditional execution
        blocking: bool = True,    # whether to block on failure
    ):
        self.hook_type = hook_type
        self.command = command
        self.prompt = prompt
        self.python_callable = python_callable
        self.timeout = timeout
        self.status_message = status_message
        self.condition = condition
        self.blocking = blocking

    @classmethod
    def from_dict(cls, d: dict) -> "HookDef":
        return cls(
            hook_type=d.get("type", "command"),
            command=d.get("command", ""),
            prompt=d.get("prompt", ""),
            python_callable=d.get("python", ""),
            timeout=d.get("timeout", 30),
            status_message=d.get("status_message", ""),
            condition=d.get("if", ""),
            blocking=d.get("blocking", True),
        )


class HookGroup:
    """A group of hooks matched to a tool name pattern."""
    def __init__(self, matcher: str, hooks: List[HookDef]):
        self.matcher = matcher
        self.hooks = hooks

    def matches(self, tool_name: str) -> bool:
        """Check if this group applies to the given tool name."""
        if self.matcher == "*":
            return True
        return fnmatch.fnmatch(tool_name, self.matcher)


# ---------------------------------------------------------------------------
# Hook runner
# ---------------------------------------------------------------------------

class HookRunner:
    """Executes hooks for a given event and context."""

    def __init__(self, llm_fn: Optional[Callable] = None):
        """
        Args:
            llm_fn: Optional callable for prompt-type hooks.
                    Signature: (prompt: str) -> str
        """
        self._llm_fn = llm_fn

    def run_command_hook(self, hook: HookDef, ctx: HookContext) -> HookResult:
        """Execute a shell command hook."""
        result = HookResult(hook_name=hook.command)

        # Build command with variable substitution
        cmd = hook.command
        env = ctx.to_env_dict()
        # Substitute $ZAI_TOOL_NAME, $ZAI_TOOL_INPUT, etc.
        for key, val in env.items():
            cmd = cmd.replace(f"${key}", val)
        # Also substitute $ARGUMENTS with full JSON context
        arguments_json = json.dumps(env, ensure_ascii=False)
        cmd = cmd.replace("$ARGUMENTS", arguments_json)

        # Merge environment
        run_env = dict(os.environ)
        run_env.update(env)

        try:
            if hook.status_message:
                print(f"[hook] {hook.status_message}", file=sys.stderr)

            proc = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=hook.timeout,
                env=run_env,
            )

            if proc.returncode == 2:
                # Exit code 2 = blocking error
                result.continue_execution = False
                result.stop_reason = proc.stderr.strip() or f"Hook blocked (exit code 2)"
                result.error = proc.stderr.strip()
            elif proc.returncode != 0:
                # Other non-zero = warning but continue
                result.error = proc.stderr.strip()
                if hook.blocking:
                    result.continue_execution = False
                    result.stop_reason = f"Hook failed (exit code {proc.returncode}): {proc.stderr.strip()}"
            else:
                # Success — capture stdout as additional context
                if proc.stdout.strip():
                    result.additional_context = proc.stdout.strip()

        except subprocess.TimeoutExpired:
            result.continue_execution = False
            result.stop_reason = f"Hook timed out after {hook.timeout}s"
            result.error = result.stop_reason
        except Exception as ex:
            result.continue_execution = False
            result.stop_reason = f"Hook error: {ex}"
            result.error = str(ex)

        return result

    def run_prompt_hook(self, hook: HookDef, ctx: HookContext) -> HookResult:
        """Execute a prompt-type hook (query LLM)."""
        result = HookResult(hook_name="prompt")

        if not self._llm_fn:
            result.error = "No LLM function available for prompt hooks"
            result.continue_execution = False
            return result

        try:
            # Build prompt with context substitution
            prompt_text = hook.prompt
            env = ctx.to_env_dict()
            for key, val in env.items():
                prompt_text = prompt_text.replace(f"${key}", val)

            response = self._llm_fn(prompt_text)
            if response:
                result.additional_context = response
        except Exception as ex:
            result.continue_execution = False
            result.stop_reason = f"Prompt hook error: {ex}"
            result.error = str(ex)

        return result

    def run_python_hook(self, hook: HookDef, ctx: HookContext) -> HookResult:
        """Execute a Python callable hook."""
        result = HookResult(hook_name=hook.python_callable)

        if not hook.python_callable:
            result.error = "No python callable specified"
            result.continue_execution = False
            return result

        try:
            # Parse "module.function" format
            parts = hook.python_callable.rsplit(".", 1)
            if len(parts) != 2:
                raise ValueError(f"Invalid python callable: {hook.python_callable}")

            mod_name, fn_name = parts
            import importlib
            mod = importlib.import_module(mod_name)
            fn = getattr(mod, fn_name)

            # Call with context dict
            ret = fn(ctx.__dict__)

            if isinstance(ret, dict):
                result.continue_execution = ret.get("continue", True)
                result.stop_reason = ret.get("stop_reason", "")
                result.updated_input = ret.get("updated_input")
                result.additional_context = ret.get("additional_context", "")
            elif isinstance(ret, bool):
                result.continue_execution = ret
            elif isinstance(ret, str):
                result.additional_context = ret

        except Exception as ex:
            result.continue_execution = False
            result.stop_reason = f"Python hook error: {ex}"
            result.error = str(ex)

        return result

    def run_hook(self, hook: HookDef, ctx: HookContext) -> HookResult:
        """Run a single hook based on its type."""
        # Check condition
        if hook.condition:
            if not fnmatch.fnmatch(ctx.tool_name, hook.condition):
                return HookResult(hook_name="skipped")

        if hook.hook_type == "command":
            return self.run_command_hook(hook, ctx)
        elif hook.hook_type == "prompt":
            return self.run_prompt_hook(hook, ctx)
        elif hook.hook_type == "python":
            return self.run_python_hook(hook, ctx)
        else:
            return HookResult(
                hook_name=f"unknown:{hook.hook_type}",
                error=f"Unknown hook type: {hook.hook_type}",
                continue_execution=True,
            )


# ---------------------------------------------------------------------------
# Hook manager
# ---------------------------------------------------------------------------

class HookManager:
    """Manages hook configuration and dispatches hook execution."""

    # Supported events
    PRE_TOOL_USE = "PreToolUse"
    POST_TOOL_USE = "PostToolUse"
    POST_TOOL_USE_FAILURE = "PostToolUseFailure"

    def __init__(self, llm_fn: Optional[Callable] = None):
        self._groups: Dict[str, List[HookGroup]] = {}
        self._runner = HookRunner(llm_fn=llm_fn)

    @classmethod
    def supported_events(cls) -> List[str]:
        return [cls.PRE_TOOL_USE, cls.POST_TOOL_USE, cls.POST_TOOL_USE_FAILURE]

    # ---- Configuration loading ----

    def load_from_dict(self, config: dict):
        """Load hook configuration from a dictionary.

        Expected format:
        {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Bash",   # or "*" for all
                        "hooks": [
                            {
                                "type": "command",
                                "command": "echo 'about to run $ZAI_TOOL_NAME'",
                                "timeout": 10
                            }
                        ]
                    }
                ],
                "PostToolUse": [...]
            }
        }
        """
        hooks_config = config.get("hooks", {})
        for event_name in self.supported_events():
            event_hooks = hooks_config.get(event_name, [])
            groups = []
            for item in event_hooks:
                matcher = item.get("matcher", "*")
                hook_defs = [
                    HookDef.from_dict(h) for h in item.get("hooks", [])
                ]
                if hook_defs:
                    groups.append(HookGroup(matcher=matcher, hooks=hook_defs))
            self._groups[event_name] = groups

    def load_from_file(self, filepath: str) -> bool:
        """Load hook configuration from a YAML or JSON file."""
        path = Path(filepath)
        if not path.exists():
            return False

        try:
            text = path.read_text(encoding="utf-8")
            if path.suffix in (".yaml", ".yml"):
                if not HAVE_YAML:
                    print("[WARN] PyYAML not installed, cannot load YAML hooks", file=sys.stderr)
                    return False
                config = yaml.safe_load(text)
            else:
                config = json.loads(text)

            if isinstance(config, dict):
                self.load_from_dict(config)
                return True
        except Exception as ex:
            print(f"[WARN] Failed to load hooks from {filepath}: {ex}", file=sys.stderr)

        return False

    def load_from_project_config(self, project_config: dict):
        """Load hooks from project configuration dict (zai_project.yaml)."""
        self.load_from_dict(project_config)

    # ---- Hook execution ----

    def get_matching_hooks(self, event: str, tool_name: str) -> List[HookDef]:
        """Get all hooks that match the given event and tool name."""
        result = []
        for group in self._groups.get(event, []):
            if group.matches(tool_name):
                result.extend(group.hooks)
        return result

    def run_pre_tool_hooks(
        self, tool_name: str, tool_input: dict
    ) -> Tuple[bool, str, Optional[dict]]:
        """Run pre-tool hooks.

        Returns:
            (continue_execution, stop_reason, updated_input)
        """
        ctx = HookContext(
            event=self.PRE_TOOL_USE,
            tool_name=tool_name,
            tool_input=tool_input,
        )

        updated_input = None
        for hook_def in self.get_matching_hooks(self.PRE_TOOL_USE, tool_name):
            result = self._runner.run_hook(hook_def, ctx)
            if not result.continue_execution:
                return False, result.stop_reason, None
            if result.updated_input:
                updated_input = result.updated_input
                ctx.tool_input = updated_input
            if result.additional_context:
                print(f"[hook] {result.additional_context}", file=sys.stderr)

        return True, "", updated_input

    def run_post_tool_hooks(
        self, tool_name: str, tool_input: dict, tool_output: Any
    ) -> Tuple[bool, str]:
        """Run post-tool hooks.

        Returns:
            (continue_execution, additional_context)
        """
        ctx = HookContext(
            event=self.POST_TOOL_USE,
            tool_name=tool_name,
            tool_input=tool_input,
            tool_output=tool_output,
        )

        additional = []
        for hook_def in self.get_matching_hooks(self.POST_TOOL_USE, tool_name):
            result = self._runner.run_hook(hook_def, ctx)
            if not result.continue_execution:
                return False, result.stop_reason
            if result.additional_context:
                additional.append(result.additional_context)

        return True, "\n".join(additional)

    def run_post_tool_failure_hooks(
        self, tool_name: str, tool_input: dict, error: str
    ) -> Tuple[bool, str]:
        """Run post-tool-failure hooks.

        Returns:
            (continue_execution, additional_context)
        """
        ctx = HookContext(
            event=self.POST_TOOL_USE_FAILURE,
            tool_name=tool_name,
            tool_input=tool_input,
            tool_error=error,
        )

        additional = []
        for hook_def in self.get_matching_hooks(self.POST_TOOL_USE_FAILURE, tool_name):
            result = self._runner.run_hook(hook_def, ctx)
            if result.additional_context:
                additional.append(result.additional_context)

        return True, "\n".join(additional)

    # ---- Status ----

    def has_hooks(self, event: Optional[str] = None) -> bool:
        """Check if any hooks are registered."""
        if event:
            return bool(self._groups.get(event, []))
        return any(bool(g) for g in self._groups.values())

    def summary(self) -> str:
        """Return a human-readable summary of configured hooks."""
        lines = []
        for event in self.supported_events():
            groups = self._groups.get(event, [])
            if not groups:
                continue
            lines.append(f"  {event}:")
            for group in groups:
                lines.append(f"    matcher: {group.matcher}")
                for h in group.hooks:
                    desc = h.command or h.prompt or h.python_callable or h.hook_type
                    lines.append(f"      - {h.hook_type}: {desc}")
        return "\n".join(lines) if lines else "  (no hooks configured)"

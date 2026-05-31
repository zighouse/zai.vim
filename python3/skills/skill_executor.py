"""
Unified skill execution engine.

Provides a single entry point for invoking any registered skill with:
- Thread-based execution (non-blocking Vim UI)
- Configurable timeout (default 30s)
- L0 security fallback (deny cross-domain when verifier not ready)
- Unified InvocationResult returns for all paths
"""

from __future__ import annotations

import json
import logging
import re
import shlex
import subprocess
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Optional

from .skill_adapter import invoke_adapted
from .skill_audit import SkillAuditLogger
from .skill_registry import SkillRegistry
from .skill_security import IntentVerifier
from .skill_types import (
    ErrorCode,
    InvocationResult,
    SkillMetadata,
    SkillOrigin,
    SkillStatus,
)

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = 30
_DEFAULT_MAX_WORKERS = 4

# ---------------------------------------------------------------------------
# Dynamic context injection (!`cmd` and ```! ... ```)
# ---------------------------------------------------------------------------

# Inline: !`command` at line start or after whitespace
_INLINE_INJECT_RE = re.compile(r"(^|\s)!`([^`]+)`", re.MULTILINE)
# Block: ```!\n...\n```
_BLOCK_INJECT_RE = re.compile(r"```!\n(.*?)\n```", re.DOTALL)

_INJECT_TIMEOUT = 30  # seconds


def inject_dynamic_context(
    content: str,
    meta: SkillMetadata,
    *,
    disabled: bool = False,
) -> str:
    """Execute shell commands in !`cmd` and ```! ... ``` blocks.

    Replaces placeholders with command output (once, no recursive scan).
    If *disabled* is True (disableSkillShellExecution), replaces with
    a policy-disabled message instead.
    """
    if disabled:
        _disabled_msg = "[shell command execution disabled by policy]"

        def _replace_disabled_inline(m: re.Match) -> str:
            return f"{m.group(1)}{_disabled_msg}"

        content = _INLINE_INJECT_RE.sub(_replace_disabled_inline, content)
        content = _BLOCK_INJECT_RE.sub(_disabled_msg, content)
        return content

    allowed = _is_injection_allowed(meta)
    if not allowed:
        _blocked_msg = "[shell command execution blocked: security policy]"

        def _replace_blocked_inline(m: re.Match) -> str:
            return f"{m.group(1)}{_blocked_msg}"

        content = _INLINE_INJECT_RE.sub(_replace_blocked_inline, content)
        content = _BLOCK_INJECT_RE.sub(_blocked_msg, content)
        return content

    skill_name = meta.name

    # Inline: !`command`
    def _replace_inline(m: re.Match) -> str:
        prefix = m.group(1)
        cmd = m.group(2)
        output = _run_inject_command(cmd, skill_name)
        return f"{prefix}{output}"

    content = _INLINE_INJECT_RE.sub(_replace_inline, content)

    # Block: ```!\n...\n```
    def _replace_block(m: re.Match) -> str:
        cmds = m.group(1)
        output = _run_inject_command(cmds, skill_name)
        return output

    content = _BLOCK_INJECT_RE.sub(_replace_block, content)
    return content


def _is_injection_allowed(meta: SkillMetadata) -> bool:
    """Check whether dynamic shell injection is allowed for this skill.

    public/personal domains: allowed (user-level or community skills)
    workspace: allowed only for native origin (project's own skills)
    local, external origin: blocked (untrusted third-party skills)
    """
    domain = str(meta.security_domain)
    if domain in ("public", "personal"):
        return True
    if domain == "workspace" and str(meta.origin) not in ("external",
                                                           "deprecated_adapted"):
        return True
    return False


def _get_skill_shell_config(skill_name: str = "") -> str:
    """Read skillShellExecution from settings.json.

    Supports two formats:
      - String: "sandbox" | "host" | "docker" (applies to all skills)
      - List of rules: [{"pattern": "regex", "mode": "sandbox|host|docker"}, ...]
        First matching rule wins. Default "sandbox" if no match.

    Args:
        skill_name: Name of the skill being invoked, used for rule matching.
    """
    try:
        from paths import get_user_dir
        settings_path = get_user_dir() / "settings.json"
        if settings_path.is_file():
            settings = json.loads(settings_path.read_text(encoding="utf-8"))
            value = settings.get("skillShellExecution", "sandbox")

            # Simple string format (backward compatible)
            if isinstance(value, str):
                if value in ("sandbox", "host", "docker"):
                    return value
                return "sandbox"

            # List of rules format: [{"pattern": "regex", "mode": "..."}, ...]
            if isinstance(value, list):
                for rule in value:
                    if not isinstance(rule, dict):
                        continue
                    pattern = rule.get("pattern", "")
                    mode = rule.get("mode", "sandbox")
                    if not pattern or mode not in ("sandbox", "host", "docker"):
                        continue
                    try:
                        if re.match(pattern, skill_name):
                            return mode
                    except re.error:
                        continue
                return "sandbox"
    except Exception:
        pass
    return "sandbox"


def _run_inject_command(cmd: str, skill_name: str = "") -> str:
    """Execute a shell command for dynamic injection, return output.

    Respects skillShellExecution setting (per-skill rule matching):
      - 'sandbox' (default): bwrap sandbox, fail-closed if unavailable
      - 'host': direct host execution
      - 'docker': not yet implemented, falls back to sandbox
    """
    config = _get_skill_shell_config(skill_name)

    if config == "host":
        return _run_inject_command_host(cmd)

    if config == "docker":
        # Docker mode not yet implemented — fall back to sandbox
        pass

    return _run_inject_command_sandbox(cmd)


def _run_inject_command_sandbox(cmd: str) -> str:
    """Execute command inside bwrap sandbox (same security model as tool_shell)."""
    try:
        from shell.sandbox import SandboxBuilder
        from paths import get_project_root

        available, _ = SandboxBuilder.available()
        if not available:
            return "[command execution blocked: sandbox unavailable]"

        project_root = str(get_project_root())
        config, build_err = SandboxBuilder.build(
            allow_network=False,
            working_dir=project_root,
        )

        if config is None or not config.bwrap_args:
            reason = build_err.message if build_err else "unknown"
            return f"[command execution blocked: sandbox build failed ({reason})]"

        # Validate bwrap binary (defense-in-depth)
        bwrap_bin = config.bwrap_args[0]
        if bwrap_bin not in ('bwrap', '/usr/bin/bwrap', '/usr/local/bin/bwrap'):
            return "[command execution blocked: invalid sandbox configuration]"

        bwrap_args_safe = list(config.bwrap_args)
        bwrap_cmd = bwrap_args_safe + ['/bin/sh', '-c', cmd]

        result = subprocess.run(
            bwrap_cmd,
            capture_output=True,
            text=True,
            timeout=_INJECT_TIMEOUT,
            cwd=project_root,
        )
        output = result.stdout.strip()
        if result.returncode != 0 and not output:
            return f"[command failed: exit code {result.returncode}]"
        return output
    except subprocess.TimeoutExpired:
        return f"[command timed out after {_INJECT_TIMEOUT}s]"
    except Exception as e:
        return f"[command failed: {e}]"


def _run_inject_command_host(cmd: str) -> str:
    """Execute command directly on host (legacy mode, opt-in only)."""
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=_INJECT_TIMEOUT,
        )
        output = result.stdout.strip()
        if result.returncode != 0 and not output:
            return f"[command failed: exit code {result.returncode}]"
        return output
    except subprocess.TimeoutExpired:
        return f"[command timed out after {_INJECT_TIMEOUT}s]"
    except Exception as e:
        return f"[command failed: {e}]"

# ---------------------------------------------------------------------------
# Variable expansion
# ---------------------------------------------------------------------------

# Regex for $ARGUMENTS[N] / $N (positional args)
_POS_ARG_RE = re.compile(r"\$ARGUMENTS\[(\d+)\]|\$(\d+)")
# Regex for ${VAR} style variables
_BRACE_VAR_RE = re.compile(r"\$\{([^}]+)\}")
# Regex for @{project-root}
_PROJECT_ROOT_RE = re.compile(r"@\{project-root\}")
# Regex for $ARGUMENTS (full — but NOT $ARGUMENTS[N] or $name)
_FULL_ARGS_RE = re.compile(r"\$ARGUMENTS(?!\[)(?!\w)")


def expand_variables(
    content: str,
    meta: SkillMetadata,
    args: str = "",
    session_id: str = "",
    effort: str = "",
) -> str:
    """Expand skill variables in *content* at invocation time.

    Supported:
      - @{project-root} → project root directory
      - ${CLAUDE_SESSION_ID} / ${ZAI_SESSION_ID} → session_id
      - ${CLAUDE_EFFORT} / ${ZAI_EFFORT} → effort
      - ${CLAUDE_SKILL_DIR} / ${ZAI_SKILL_DIR} → skill directory
      - ${CLAUDE_PROJECT_ROOT} / ${ZAI_PROJECT_ROOT} → project root
      - $ARGUMENTS → full argument string
      - $ARGUMENTS[N] / $N → positional argument
      - $name → named argument from meta.arguments
    """
    from paths import get_project_root
    project_root = str(get_project_root())

    # Skill directory (parent of SKILL.md path)
    skill_dir = ""
    if meta.path:
        p = Path(meta.path)
        skill_dir = str(p.parent if p.is_file() else p)

    # Parse positional arguments
    pos_args: list[str] = []
    if args:
        try:
            pos_args = shlex.split(args)
        except ValueError:
            pos_args = args.split()

    # --- @{project-root} ---
    content = _PROJECT_ROOT_RE.sub(project_root, content)

    # --- ${VAR} style ---
    def _replace_brace_var(m: re.Match) -> str:
        var = m.group(1)
        mapping = {
            "CLAUDE_SESSION_ID": session_id,
            "ZAI_SESSION_ID": session_id,
            "CLAUDE_EFFORT": effort,
            "ZAI_EFFORT": effort,
            "CLAUDE_SKILL_DIR": skill_dir,
            "ZAI_SKILL_DIR": skill_dir,
            "CLAUDE_PROJECT_ROOT": project_root,
            "ZAI_PROJECT_ROOT": project_root,
        }
        return mapping.get(var, m.group(0))

    content = _BRACE_VAR_RE.sub(_replace_brace_var, content)

    # --- $name (named args from meta.arguments) — before positional/$ARGUMENTS ---
    if meta.arguments and pos_args:
        for i, arg_name in enumerate(meta.arguments):
            if i < len(pos_args):
                # Use regex with word-boundary-like check (not greedy replace)
                pat = re.compile(r'\$' + re.escape(arg_name) + r'(?!\w)')
                content = pat.sub(pos_args[i], content)

    # --- $ARGUMENTS[N] / $N (positional) ---
    def _replace_pos(m: re.Match) -> str:
        idx_str = m.group(1) or m.group(2)
        if idx_str is None:
            return m.group(0)
        idx = int(idx_str)
        if 0 <= idx < len(pos_args):
            return pos_args[idx]
        # Out of range: leave unchanged (avoids silently eating $50 in prose)
        return m.group(0)

    content = _POS_ARG_RE.sub(_replace_pos, content)

    # --- $ARGUMENTS (full) — LAST to avoid re-expansion of $0/$1 in output ---
    content = _FULL_ARGS_RE.sub(args, content)

    return content


class SkillExecutor:
    """Unified execution engine for all skills."""

    def __init__(
        self,
        registry: SkillRegistry,
        tool_pool: Any = None,
        max_workers: int = _DEFAULT_MAX_WORKERS,
        audit_logger: Optional[SkillAuditLogger] = None,
        l0_verifier: Optional[IntentVerifier] = None,
    ):
        self._registry = registry
        self._tool_pool = tool_pool
        self._executor = ThreadPoolExecutor(max_workers=max_workers)
        self._audit = audit_logger
        self._l0_verifier = l0_verifier or IntentVerifier()

    def set_l0_verifier(self, verifier: IntentVerifier) -> None:
        """Set or replace the L0 intent verifier."""
        self._l0_verifier = verifier

    def invoke(
        self,
        name: str,
        context: Optional[Any] = None,
        timeout: int = _DEFAULT_TIMEOUT,
        **kwargs: Any,
    ) -> InvocationResult:
        """Invoke a skill by name.

        Args:
            name: Skill name (kebab-case).
            context: Optional IntentContext for L0 verification.
            timeout: Execution timeout in seconds.
            **kwargs: Arguments forwarded to the skill.

        Returns:
            InvocationResult — always, never raises.
        """
        # --- Registry lookup ---
        meta = self._registry.get(name)
        if meta is None:
            self._audit_reject(name, "not_found", ErrorCode.SKILL_NOT_FOUND)
            return InvocationResult(
                success=False,
                error=f"Skill not found: {name}",
                error_code=ErrorCode.SKILL_NOT_FOUND,
            )

        # --- Status check ---
        if meta.status == SkillStatus.DISABLED:
            self._audit_reject(name, "disabled", ErrorCode.SKILL_DISABLED,
                               meta=meta)
            return InvocationResult(
                success=False,
                error=f"Skill is disabled: {name}",
                error_code=ErrorCode.SKILL_DISABLED,
            )
        if meta.status in (SkillStatus.MISSING, SkillStatus.UNAVAILABLE):
            self._audit_reject(name, f"status_{meta.status.value}",
                               ErrorCode.SKILL_UNAVAILABLE, meta=meta)
            return InvocationResult(
                success=False,
                error=f"Skill is {meta.status.value}: {name}",
                error_code=ErrorCode.SKILL_UNAVAILABLE,
            )

        # --- Pre-thread validation ---
        if meta.origin == SkillOrigin.ADAPTED and self._tool_pool is None:
            return InvocationResult(
                success=False,
                error=f"Tool pool not configured for adapted skill: {name}",
                error_code=ErrorCode.SKILL_EXECUTION_ERROR,
            )

        # --- Timeout validation ---
        if not isinstance(timeout, (int, float)) or timeout <= 0:
            timeout = _DEFAULT_TIMEOUT

        # --- L0 security check (fallback when verifier not ready) ---
        verify_decision = "fallback_allow"
        if not self._security_check(meta, context):
            verify_decision = "denied_cross_domain"
            self._audit_log(
                meta, verify_decision=verify_decision,
                execution_time_ms=0, result_summary="cross-domain denied",
                error_code=ErrorCode.SECURITY_DOMAIN_VIOLATION,
                context=context,
            )
            return InvocationResult(
                success=False,
                error=f"Security check failed for {name}: cross-domain denied",
                error_code=ErrorCode.SECURITY_DOMAIN_VIOLATION,
                recoverable=False,
            )

        # --- Execute with timeout + audit ---
        start = time.monotonic()
        result = self._execute_with_timeout(name, meta, timeout, **kwargs)
        elapsed_ms = int((time.monotonic() - start) * 1000)

        self._audit_log(
            meta, verify_decision="allowed",
            execution_time_ms=elapsed_ms,
            result_summary="ok" if result.success else (result.error or "failed"),
            error_code=result.error_code,
            context=context,
        )

        return result

    # ------------------------------------------------------------------
    # Audit helper
    # ------------------------------------------------------------------

    def _audit_log(
        self,
        meta: SkillMetadata,
        *,
        verify_decision: str = "",
        execution_time_ms: int = 0,
        result_summary: str = "",
        error_code: Optional[str] = None,
        context: Any = None,
    ) -> None:
        if self._audit is None:
            return
        self._audit.log_invocation(
            skill_name=meta.name,
            session_id=self._extract_session_id(context),
            call_chain=self._extract_call_chain(context, meta.name),
            security_domain=str(meta.security_domain),
            trust_level=str(meta.trust_level),
            verify_decision=verify_decision,
            execution_time_ms=execution_time_ms,
            result_summary=result_summary[:500] if result_summary else "",
            error_code=error_code,
            origin=str(meta.origin),
        )

    def _audit_reject(
        self,
        name: str,
        reason: str,
        error_code: str,
        *,
        meta: Optional[SkillMetadata] = None,
        context: Any = None,
    ) -> None:
        if self._audit is None:
            return
        self._audit.log_invocation(
            skill_name=name,
            session_id=self._extract_session_id(context),
            call_chain=self._extract_call_chain(context, name),
            security_domain=str(meta.security_domain) if meta else "",
            trust_level=str(meta.trust_level) if meta else "",
            verify_decision=f"rejected:{reason}",
            execution_time_ms=0,
            result_summary=reason,
            error_code=error_code,
            origin=str(meta.origin) if meta else "",
        )

    @staticmethod
    def _extract_session_id(context: Any) -> str:
        if context is None:
            return ""
        return getattr(context, "session_id", "") or ""

    @staticmethod
    def _extract_call_chain(context: Any, skill_name: str) -> list[str]:
        if context is None:
            return [skill_name]
        chain = getattr(context, "call_chain", None) or []
        return chain + [skill_name]

    # ------------------------------------------------------------------
    # Security fallback
    # ------------------------------------------------------------------

    def _security_check(self, meta: SkillMetadata, context: Any) -> bool:
        """Run L0 verification via IntentVerifier."""
        try:
            return self._l0_verifier.verify(meta, context)
        except Exception as exc:
            logger.warning("L0 verifier error for %s: %s", meta.name, exc)
            return False  # fail-closed

    # ------------------------------------------------------------------
    # Execution with timeout
    # ------------------------------------------------------------------

    def _execute_with_timeout(
        self,
        name: str,
        meta: SkillMetadata,
        timeout: int,
        **kwargs: Any,
    ) -> InvocationResult:
        """Execute skill in a thread with timeout."""
        future: Future = self._executor.submit(self._run_skill, meta, **kwargs)

        try:
            return future.result(timeout=timeout)
        except threading.BrokenThreadPool:
            return InvocationResult(
                success=False,
                error=f"Executor pool broken for {name}",
                error_code=ErrorCode.SKILL_EXECUTION_ERROR,
            )
        except TimeoutError:
            future.cancel()
            logger.warning("Skill %s timed out after %ds", name, timeout)
            return InvocationResult(
                success=False,
                error=f"Skill timed out after {timeout}s: {name}",
                error_code=ErrorCode.SKILL_TIMEOUT,
                recoverable=True,
            )
        except Exception as exc:
            return InvocationResult(
                success=False,
                error=f"Unexpected executor error for {name}: {exc}",
                error_code=ErrorCode.SKILL_EXECUTION_ERROR,
            )

    def _run_skill(self, meta: SkillMetadata, **kwargs: Any) -> InvocationResult:
        """Actual skill invocation (runs in thread pool)."""
        try:
            if meta.origin == SkillOrigin.ADAPTED:
                return invoke_adapted(
                    self._registry, meta.name, self._tool_pool, **kwargs
                )

            # Native / external skills — placeholder for future protocol dispatch
            return self._invoke_native(meta, **kwargs)
        except Exception as exc:
            logger.exception("Skill %s execution error", meta.name)
            return InvocationResult(
                success=False,
                error=str(exc),
                error_code=ErrorCode.SKILL_EXECUTION_ERROR,
                recoverable=True,
            )

    def _invoke_native(
        self, meta: SkillMetadata, **kwargs: Any
    ) -> InvocationResult:
        """Invoke a native skill by loading its SKILL.md content.

        The skill content is returned so the LLM can read it and follow
        the instructions.  This is the fallback path when skills are
        invoked directly via SkillExecutor rather than through the
        `skill` tool (tool_skill.py).
        """
        try:
            from pathlib import Path
            skill_path = Path(meta.path) if meta.path else None
            if skill_path is None:
                return InvocationResult(
                    success=False,
                    error=f"No source path for native skill: {meta.name}",
                    error_code=ErrorCode.SKILL_UNAVAILABLE,
                )
            if not skill_path.is_file():
                # Maybe meta.path is the directory — try dir/SKILL.md
                skill_path = skill_path / "SKILL.md"
            if not skill_path.is_file():
                return InvocationResult(
                    success=False,
                    error=f"SKILL.md not found for: {meta.name}",
                    error_code=ErrorCode.SKILL_UNAVAILABLE,
                )

            content = skill_path.read_text(encoding="utf-8")

            # Strip frontmatter — we only want the body
            from .skill_parser import _split_frontmatter
            try:
                _, body = _split_frontmatter(content, str(skill_path))
                content = body
            except Exception:
                pass  # no frontmatter, use as-is

            # Expand variables ($ARGUMENTS, ${CLAUDE_*}, etc.)
            args_str = kwargs.get("args", "") or ""
            session_id = kwargs.get("session_id", "") or ""
            effort = kwargs.get("effort", "") or ""
            content = expand_variables(content, meta, args_str, session_id, effort)

            # Dynamic context injection (!`cmd` and ```! ... ```)
            shell_disabled = _is_shell_execution_disabled()
            content = inject_dynamic_context(content, meta, disabled=shell_disabled)

            # Task 10: Inject allowed/disallowed tools hints
            content = _inject_tool_hints(content, meta)

            # Append invocation kwargs as context if present
            remaining = {k: v for k, v in kwargs.items()
                         if k not in ("args", "session_id", "effort")}
            if remaining:
                try:
                    args_json = json.dumps(remaining, ensure_ascii=False)
                except Exception:
                    args_json = str(remaining)
                content = content.rstrip() + f"\n\n## Invocation Arguments\n{args_json}\n"

            return InvocationResult(
                success=True,
                data={"skill_content": content, "name": meta.name},
            )
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(
                "Native skill load failed for %s: %s", meta.name, e
            )
            return InvocationResult(
                success=False,
                error=f"Failed to load skill '{meta.name}': {e}",
                error_code=ErrorCode.SKILL_EXECUTION_ERROR,
            )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def shutdown(self, wait: bool = True) -> None:
        """Shut down the executor thread pool."""
        self._executor.shutdown(wait=wait)


def _is_shell_execution_disabled() -> bool:
    """Check the global disableSkillShellExecution setting."""
    try:
        from paths import get_user_dir
        settings_path = get_user_dir() / "settings.json"
        if settings_path.is_file():
            import json
            settings = json.loads(settings_path.read_text(encoding="utf-8"))
            return bool(settings.get("disableSkillShellExecution", False))
    except Exception:
        pass
    return False


def _inject_tool_hints(content: str, meta: SkillMetadata) -> str:
    """Append allowed/disallowed tools hints to skill content (Task 10)."""
    hints: list[str] = []
    if meta.allowed_tools:
        tools = ", ".join(meta.allowed_tools)
        hints.append(f"## Allowed Tools\nYou may use: {tools}")
    if meta.disallowed_tools:
        tools = ", ".join(meta.disallowed_tools)
        hints.append(f"## Disallowed Tools\nYou must NOT use: {tools}")
    if hints:
        content = content.rstrip() + "\n\n" + "\n\n".join(hints) + "\n"
    return content

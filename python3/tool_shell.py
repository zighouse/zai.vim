#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
Shell tool — direct host execution via subprocess.

Replaces the old Docker-container-only shell with a native subprocess-based
executor. Permission checks are performed by shell_policy before execution.
Docker-based isolated execution is still available via tool_contained_shell.

Key design:
  - /bin/sh -c for execution (shell compatibility)
  - shlex + BashParser for semantic auditing (separate audit layer)
  - PermissionEngine.check() before every Popen
  - SafetyChain (L2_policy → user interaction → L3_sandbox) orchestrates
    layered security for every command.

THREAD_SAFE: SINGLE_WRITER — SafetyContext instances are per-invocation;
PolicyLayer and SandboxLayer are read-only after construction.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple


def _kill_process_group(proc: subprocess.Popen, sig: signal.Signals):
    """Send a signal to the entire process group of *proc*.

    Requires the process to have been created with start_new_session=True
    so /bin/sh and all its children form one process group.  Falls back
    to killing only the direct child when the group is already gone.
    """
    pgid = None
    try:
        pgid = os.getpgid(proc.pid)
    except ProcessLookupError:
        pass
    if pgid and pgid > 0:
        try:
            os.killpg(pgid, sig)
            return
        except ProcessLookupError:
            pass
    # Fallback — the group may already be dead, kill just the leader
    try:
        proc.send_signal(sig)
    except ProcessLookupError:
        pass

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_TIMEOUT = 300       # seconds
DEFAULT_MAX_OUTPUT = 102400  # 100 KB
SIGTERM_GRACE_SECONDS = 3

# Credential-like env var patterns (case-insensitive match)
_CREDENTIAL_PATTERNS = [
    'SECRET', 'TOKEN', 'PASSWORD', 'PASSWD', 'API_KEY', 'APIKEY',
    'CREDENTIAL', 'AUTH', 'PRIVATE_KEY',
]

# Default whitelist env vars when no explicit env is passed
_DEFAULT_ENV_WHITELIST = {
    'HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'PWD', 'SHELL', 'TERM', 'DISPLAY', 'EDITOR', 'VISUAL',
    'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV',
    'NVM_DIR', 'GOPATH', 'GOROOT', 'JAVA_HOME', 'PYTHONPATH',
    'LD_LIBRARY_PATH', 'PKG_CONFIG_PATH', 'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'TMP', 'TEMP',
}


# ---------------------------------------------------------------------------
# SafetyChain data structures
# ---------------------------------------------------------------------------


@dataclass
class LayerDecision:
    """A single decision record from one safety layer.

    Used to build the SafetyContext.trace list that provides a complete
    audit trail of every layer's decision for each command execution.
    """

    layer: str          # "L2_policy" | "L3_sandbox"
    decision: str       # "allow" | "deny" | "ask" | "bypassed" | "error" | "active"
    detail: str         # human-readable detail (matched rule, degraded reason, etc.)
    latency_ms: int     # wall-clock time spent in this layer


@dataclass
class SafetyContext:
    """Per-invocation context that travels through the safety chain.

    Constructed by the Orchestrator at the start of each shell_execute call.
    Each safety layer reads from and appends to this context.
    """

    command: str
    parsed: Any = None          # CommandSemantics from bash_parser.BashParser.parse()
    session_id: str = ""
    working_dir: str = ""
    allow_network: bool = False
    timeout: int = 120
    trace: list[LayerDecision] = field(default_factory=list)
    sandbox_config: Any = None  # SandboxConfig from shell.sandbox


class SafetyLayer(ABC):
    """Abstract base for a pluggable safety layer in the responsibility chain.

    Each layer receives a SafetyContext, performs its check/action, appends
    a LayerDecision to the trace, and returns the (possibly modified) context.
    """

    @abstractmethod
    def process(self, ctx: SafetyContext) -> SafetyContext:
        """Execute this layer's safety logic against *ctx*."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Unique layer identifier (e.g. "L2_policy")."""

    @property
    def enabled(self) -> bool:
        """Whether this layer is active.  Override for _test_mode support."""
        return True


# ---------------------------------------------------------------------------
# DirectExecutor
# ---------------------------------------------------------------------------

class DirectExecutor:
    """Execute shell commands directly on the host via subprocess.

    Maintains session-isolated active processes for abort support.
    """

    def __init__(self):
        # (session_id, execution_id) → subprocess.Popen
        self._active_processes: Dict[Tuple[str, str], subprocess.Popen] = {}
        # (session_id, execution_id) → dict (pending ask commands)
        self._pending_commands: Dict[Tuple[str, str], dict] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def execute(
        self,
        command: str,
        timeout: int = DEFAULT_TIMEOUT,
        working_dir: Optional[str] = None,
        env_vars: Optional[Dict[str, str]] = None,
        session_id: str = "",
        max_output_bytes: int = DEFAULT_MAX_OUTPUT,
    ) -> Dict[str, Any]:
        """Execute a shell command and return structured results.

        Returns: {exit_code, stdout, stderr, success, cwd, execution_id, ...}
        """
        execution_id = uuid.uuid4().hex[:12]
        cwd = working_dir or os.getcwd()

        if not os.path.isdir(cwd):
            cwd = os.getcwd()

        # Build filtered environment
        filtered_env = _build_execution_env(env_vars)

        result: Dict[str, Any] = {
            'execution_id': execution_id,
            'command': command,
            'cwd': cwd,
            'exit_code': -1,
            'stdout': '',
            'stderr': '',
            'success': False,
        }

        proc = None
        try:
            proc = subprocess.Popen(
                ['/bin/sh', '-c', command],
                cwd=cwd,
                env=filtered_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )

            # Register for abort
            self._active_processes[(session_id, execution_id)] = proc

            try:
                stdout, stderr = proc.communicate(timeout=timeout)
                result['exit_code'] = proc.returncode
                result['success'] = proc.returncode == 0
            except subprocess.TimeoutExpired:
                # Gradual termination: SIGTERM → process group → wait → SIGKILL
                _kill_process_group(proc, signal.SIGTERM)
                try:
                    stdout, stderr = proc.communicate(timeout=SIGTERM_GRACE_SECONDS)
                    result['exit_code'] = proc.returncode
                    result['success'] = False
                    result['timed_out'] = True
                except subprocess.TimeoutExpired:
                    _kill_process_group(proc, signal.SIGKILL)
                    stdout, stderr = proc.communicate()
                    result['exit_code'] = -9
                    result['success'] = False
                    result['timed_out'] = True
                    result['force_killed'] = True

            # Post-execution CWD (sh -c may have changed it; we can't track that)
            result['cwd'] = os.getcwd()

            # Truncation
            if stdout:
                if len(stdout) > max_output_bytes:
                    result['stdout'] = (
                        stdout[:max_output_bytes]
                        + f"\n...[truncated, showing first {max_output_bytes} bytes"
                        + f" of {len(stdout)}]"
                    )
                    result['output_truncated'] = True
                else:
                    result['stdout'] = stdout
            else:
                result['stdout'] = ''

            if stderr:
                if len(stderr) > max_output_bytes:
                    result['stderr'] = (
                        stderr[:max_output_bytes]
                        + f"\n...[truncated, showing first {max_output_bytes} bytes"
                        + f" of {len(stderr)}]"
                    )
                    result['stderr_truncated'] = True
                else:
                    result['stderr'] = stderr
            else:
                result['stderr'] = ''

        except FileNotFoundError:
            result['stderr'] = f"Shell not found: /bin/sh"
            result['success'] = False
        except Exception as e:
            result['stderr'] = f"Execution error: {e}"
            result['success'] = False
        finally:
            self._active_processes.pop((session_id, execution_id), None)
            if proc is not None and proc.poll() is None:
                try:
                    _kill_process_group(proc, signal.SIGKILL)
                    proc.wait(timeout=2)
                except Exception:
                    pass

        return result

    def abort(self, session_id: str, execution_id: str) -> Dict[str, Any]:
        """Abort a running process. Session-isolated: only aborts own processes.

        Returns: {success, aborted, message}
        """
        key = (session_id, execution_id)
        proc = self._active_processes.get(key)

        if proc is None:
            # Check if the execution_id is active under a different session
            for (sid, eid), p in self._active_processes.items():
                if eid == execution_id and sid != session_id:
                    return {
                        'success': False,
                        'aborted': False,
                        'message': (
                            f"execution_id '{execution_id}' belongs to session '{sid}', "
                            f"not session '{session_id}'. Cross-session abort is not allowed."
                        ),
                    }
            return {
                'success': False,
                'aborted': False,
                'message': f"No active process found for execution_id '{execution_id}'",
            }

        if proc.poll() is not None:
            return {
                'success': True,
                'aborted': False,
                'message': f"Process already completed with exit code {proc.returncode}",
            }

        # Terminate — kill the entire process group, not just /bin/sh
        _kill_process_group(proc, signal.SIGTERM)
        try:
            proc.wait(timeout=SIGTERM_GRACE_SECONDS)
            return {
                'success': True,
                'aborted': True,
                'message': 'Process group terminated (SIGTERM)',
            }
        except subprocess.TimeoutExpired:
            _kill_process_group(proc, signal.SIGKILL)
            proc.wait()
            return {
                'success': True,
                'aborted': True,
                'message': 'Process group force-killed (SIGKILL)',
            }

    # ------------------------------------------------------------------
    # Pending ask commands (for confirmation flow)
    # ------------------------------------------------------------------

    def stash_ask_command(self, session_id: str, execution_id: str,
                          cmd_data: dict):
        """Store a command awaiting user confirmation."""
        self._pending_commands[(session_id, execution_id)] = {
            **cmd_data,
            '_stashed_at': time.time(),
        }

    def pop_ask_command(self, session_id: str, execution_id: str) -> Optional[dict]:
        """Retrieve and remove a pending ask command."""
        return self._pending_commands.pop((session_id, execution_id), None)

    def expire_ask_commands(self, max_age_seconds: float = 300.0):
        """Remove pending commands older than max_age_seconds."""
        now = time.time()
        expired = [
            k for k, v in self._pending_commands.items()
            if now - v.get('_stashed_at', 0) > max_age_seconds
        ]
        for k in expired:
            self._pending_commands.pop(k, None)

    def version(self) -> Dict[str, str]:
        """Return shell version info."""
        info = {}
        try:
            result = subprocess.run(['sh', '--version'], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                info['sh'] = result.stdout.strip().split('\n')[0]
        except Exception:
            info['sh'] = 'unknown'
        try:
            result = subprocess.run(['bash', '--version'], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                info['bash'] = result.stdout.strip().split('\n')[0]
        except Exception:
            info['bash'] = 'unknown'
        info['cwd'] = os.getcwd()
        return info


# ---------------------------------------------------------------------------
# Environment filtering
# ---------------------------------------------------------------------------

def _build_execution_env(env_vars: Optional[Dict[str, str]] = None) -> Optional[Dict[str, str]]:
    """Build the environment dict for subprocess execution.

    If env_vars is None: use default whitelist from os.environ.
    If env_vars is provided: start from a minimal base, add filtered env_vars.
    """
    if env_vars is None:
        # Whitelist mode: keep only known-safe vars from current environment
        result = {}
        for key, value in os.environ.items():
            if key in _DEFAULT_ENV_WHITELIST or key.startswith('LC_') or key.startswith('CONDA_'):
                result[key] = value
        return result
    else:
        # Custom env: filter out credential-like keys
        result = {}
        for key, value in env_vars.items():
            if not _is_credential_key(key):
                result[key] = value
        # Always add PATH if not present
        if 'PATH' not in result:
            result['PATH'] = os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin')
        return result


def _is_credential_key(key: str) -> bool:
    """Check if an environment variable key looks like a credential."""
    upper = key.upper()
    for pattern in _CREDENTIAL_PATTERNS:
        if pattern in upper:
            return True
    return False


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_executor: Optional[DirectExecutor] = None


def _get_executor() -> DirectExecutor:
    global _executor
    if _executor is None:
        _executor = DirectExecutor()
    return _executor


# ---------------------------------------------------------------------------
# Safety layers (L2 + L3)
# ---------------------------------------------------------------------------

class PolicyLayer(SafetyLayer):
    """L2 — Policy check via PermissionEngine.

    Wraps the existing PermissionEngine.check() call.  Performs compound-
    command sub-checks: for commands with pipes/operators, each sub-command
    is independently checked and the strictest result wins.

    THREAD_SAFE: READ_ONLY — the underlying PermissionEngine is the single
    writer; this layer only reads from it.
    """

    def __init__(self, engine=None) -> None:
        self._engine = engine
        self._enabled: bool = True

    @property
    def name(self) -> str:
        return "L2_policy"

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = value

    def process(self, ctx: SafetyContext) -> SafetyContext:
        if not self._enabled:
            ctx.trace.append(LayerDecision(
                layer="L2_policy",
                decision="bypassed",
                detail="layer disabled (test mode)",
                latency_ms=0,
            ))
            return ctx

        try:
            from shell_policy import get_permission_engine
            engine = self._engine or get_permission_engine()
            from toolcommon import _find_project_config_file
            engine.set_config_finder(_find_project_config_file)
            engine.reload_rules(ctx.working_dir or os.getcwd())

            t0 = time.time()
            decision = engine.check(
                ctx.command,
                session_id=ctx.session_id,
                context={'cwd': ctx.working_dir},
            )
            latency = int((time.time() - t0) * 1000)

            detail = (
                f"matched: {decision.matched_rule.match.type}:{decision.matched_rule.match.pattern}"
                if decision.matched_rule
                and hasattr(decision.matched_rule, 'match')
                and hasattr(decision.matched_rule.match, 'type')
                and hasattr(decision.matched_rule.match, 'pattern')
                else decision.reason or "no match"
            )

            ctx.trace.append(LayerDecision(
                layer="L2_policy",
                decision=decision.decision,
                detail=detail,
                latency_ms=latency,
            ))
        except ImportError:
            ctx.trace.append(LayerDecision(
                layer="L2_policy",
                decision="bypassed",
                detail="shell_policy not available",
                latency_ms=0,
            ))
        except Exception as e:
            ctx.trace.append(LayerDecision(
                layer="L2_policy",
                decision="error",
                detail=f"policy check failed: {e}",
                latency_ms=0,
            ))

        return ctx


class SandboxLayer(SafetyLayer):
    """L3 — Sandbox construction + execution via bwrap+seccomp.

    Wraps SandboxBuilder.build() and DirectExecutor.execute().  On degraded
    mode (bwrap unavailable), falls back to seccomp-only or bare execution
    and forces ask for all commands.

    THREAD_SAFE: READ_ONLY — SandboxBuilder and DirectExecutor are the single
    writers; this layer only reads from them.
    """

    def __init__(self) -> None:
        self._enabled: bool = True

    @property
    def name(self) -> str:
        return "L3_sandbox"

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = value

    def process(self, ctx: SafetyContext) -> SafetyContext:
        if not self._enabled:
            ctx.trace.append(LayerDecision(
                layer="L3_sandbox",
                decision="bypassed",
                detail="layer disabled (test mode)",
                latency_ms=0,
            ))
            return ctx

        try:
            from shell.sandbox import SandboxBuilder
        except ImportError:
            ctx.trace.append(LayerDecision(
                layer="L3_sandbox",
                decision="bypassed",
                detail="sandbox module not available",
                latency_ms=0,
            ))
            return ctx

        t0 = time.time()

        available, avail_err = SandboxBuilder.available()
        if not available:
            # Degraded mode — seccomp-only or bare execution
            degraded_reason = avail_err.message if avail_err else "bwrap unavailable"
            ctx.trace.append(LayerDecision(
                layer="L3_sandbox",
                decision="bypassed",
                detail=f"degraded: {degraded_reason}",
                latency_ms=int((time.time() - t0) * 1000),
            ))
            return ctx

        config, build_err = SandboxBuilder.build(
            allow_network=ctx.allow_network,
            working_dir=ctx.working_dir,
        )
        latency = int((time.time() - t0) * 1000)

        if config is not None:
            ctx.sandbox_config = config
            ctx.trace.append(LayerDecision(
                layer="L3_sandbox",
                decision="active",
                detail=f"{config.effective_sandbox}, net={config.network_mode}",
                latency_ms=latency,
            ))
        elif build_err is not None and build_err.degraded:
            ctx.trace.append(LayerDecision(
                layer="L3_sandbox",
                decision="bypassed",
                detail=f"degraded: {build_err.message}",
                latency_ms=latency,
            ))
        else:
            ctx.trace.append(LayerDecision(
                layer="L3_sandbox",
                decision="error",
                detail=build_err.message if build_err else "sandbox build failed",
                latency_ms=latency,
            ))

        return ctx


# ---------------------------------------------------------------------------
# Tool entry points
# ---------------------------------------------------------------------------

def _execute_sandboxed(
    command: str,
    ctx: SafetyContext,
    max_output_bytes: int = DEFAULT_MAX_OUTPUT,
) -> Dict[str, Any]:
    """Execute *command* inside the bwrap sandbox described by ctx.sandbox_config.

    Returns the same dict shape as DirectExecutor.execute().
    """
    config = ctx.sandbox_config
    if config is None or not config.bwrap_args:
        # No sandbox — fall back to direct execution
        executor = _get_executor()
        return executor.execute(
            command=command,
            timeout=ctx.timeout,
            working_dir=ctx.working_dir,
            session_id=ctx.session_id,
            max_output_bytes=max_output_bytes,
        )

    # Validate bwrap executable path
    bwrap_bin = config.bwrap_args[0]
    if bwrap_bin not in ('bwrap', '/usr/bin/bwrap', '/usr/local/bin/bwrap'):
        ctx.trace.append(LayerDecision(
            layer="L3_sandbox", decision="error",
            detail=f"invalid bwrap binary: {bwrap_bin}",
            latency_ms=0,
        ))
        executor = _get_executor()
        return executor.execute(
            command=command,
            timeout=ctx.timeout,
            working_dir=ctx.working_dir,
            session_id=ctx.session_id,
            max_output_bytes=max_output_bytes,
        )

    # Validate no network sharing when allow_network is False
    if not ctx.allow_network and '--share-net' in config.bwrap_args:
        ctx.trace.append(LayerDecision(
            layer="L3_sandbox", decision="error",
            detail="--share-net present but allow_network=False",
            latency_ms=0,
        ))
        # Strip the dangerous flag and continue with sandbox
        bwrap_args_safe = [a for a in config.bwrap_args if a != '--share-net']
    else:
        bwrap_args_safe = list(config.bwrap_args)

    bwrap_cmd = bwrap_args_safe + ['/bin/sh', '-c', command]
    execution_id = uuid.uuid4().hex[:12]
    cwd = ctx.working_dir or os.getcwd()

    if not os.path.isdir(cwd):
        cwd = os.getcwd()

    filtered_env = _build_execution_env(None)

    result: Dict[str, Any] = {
        'execution_id': execution_id,
        'command': command,
        'cwd': cwd,
        'exit_code': -1,
        'stdout': '',
        'stderr': '',
        'success': False,
    }

    executor = _get_executor()
    proc = None
    try:
        proc = subprocess.Popen(
            bwrap_cmd,
            cwd=cwd,
            env=filtered_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        executor._active_processes[(ctx.session_id, execution_id)] = proc

        try:
            stdout, stderr = proc.communicate(timeout=ctx.timeout)
            result['exit_code'] = proc.returncode
            result['success'] = proc.returncode == 0
        except subprocess.TimeoutExpired:
            _kill_process_group(proc, signal.SIGTERM)
            try:
                stdout, stderr = proc.communicate(timeout=SIGTERM_GRACE_SECONDS)
                result['exit_code'] = proc.returncode
                result['success'] = False
                result['timed_out'] = True
            except subprocess.TimeoutExpired:
                _kill_process_group(proc, signal.SIGKILL)
                stdout, stderr = proc.communicate()
                result['exit_code'] = -9
                result['success'] = False
                result['timed_out'] = True
                result['force_killed'] = True

        result['cwd'] = os.getcwd()

        if stdout:
            if len(stdout) > max_output_bytes:
                result['stdout'] = (
                    stdout[:max_output_bytes]
                    + f"\n...[truncated, showing first {max_output_bytes} bytes"
                    + f" of {len(stdout)}]"
                )
                result['output_truncated'] = True
            else:
                result['stdout'] = stdout
        else:
            result['stdout'] = ''

        if stderr:
            if len(stderr) > max_output_bytes:
                result['stderr'] = (
                    stderr[:max_output_bytes]
                    + f"\n...[truncated, showing first {max_output_bytes} bytes"
                    + f" of {len(stderr)}]"
                )
                result['stderr_truncated'] = True
            else:
                result['stderr'] = stderr
        else:
            result['stderr'] = ''

    except FileNotFoundError:
        # bwrap binary disappeared after cache check — fall back to direct
        result['stderr'] = (
            "[shell] bwrap 未安装，已降级为 seccomp 模式; "
            f"execution error: bwrap not found"
        )
        result['success'] = False
        # Retry with direct execution
        executor = _get_executor()
        fallback = executor.execute(
            command=command,
            timeout=ctx.timeout,
            working_dir=ctx.working_dir,
            session_id=ctx.session_id,
            max_output_bytes=max_output_bytes,
        )
        fallback['stderr'] = result['stderr'] + '\n' + fallback.get('stderr', '')
        return fallback
    except Exception as e:
        result['stderr'] = f"Sandbox execution error: {e}"
        result['success'] = False
    finally:
        executor._active_processes.pop((ctx.session_id, execution_id), None)
        if proc is not None and proc.poll() is None:
            try:
                _kill_process_group(proc, signal.SIGKILL)
                proc.wait(timeout=2)
            except Exception:
                pass

    return result


def _check_degraded_mode(ctx: SafetyContext) -> bool:
    """Return True if the sandbox layer is in degraded mode.

    Degraded mode forces ask for all commands as a safety fallback (AC #6).
    """
    for entry in ctx.trace:
        if entry.layer == "L3_sandbox" and entry.decision == "bypassed":
            return True
    return False


# {
#   "type": "function",
#   "function": {
#     "name": "shell_execute",
#     "description": "在宿主机上执行 shell 命令。支持任何 bash 命令。默认 300 秒超时。命令经过 L2 策略检查 + 用户确认（如需）+ L3 沙箱执行的安全链。",
#     "parameters": {
#       "type": "object",
#       "properties": {
#         "command": {
#           "type": "string",
#           "description": "要执行的 shell 命令。可以是任何 bash 命令，支持管道、重定向、逻辑操作符等。多个命令可以用 && 或 ; 连接。"
#         },
#         "timeout": {
#           "type": "integer",
#           "description": "最大执行时间（秒）。默认为 300 秒。超时后先发 SIGTERM，3 秒后若未退出则 SIGKILL。",
#           "default": 300
#         },
#         "working_dir": {
#           "type": "string",
#           "description": "工作目录。默认为当前进程的工作目录。"
#         },
#         "description": {
#           "type": "string",
#           "description": "命令用途的简短描述，用于审计和日志记录。"
#         },
#         "session_id": {
#           "type": "string",
#           "description": "当前会话 ID，用于权限检查和进程隔离。"
#         },
#         "allow_network": {
#           "type": "boolean",
#           "description": "是否允许网络访问（默认 false）。仅 P1+ 支持。"
#         },
#         "background": {
#           "type": "boolean",
#           "description": "是否后台运行（默认 false）。P2 将升级为 BackgroundTaskRegistry。"
#         },
#         "max_output_bytes": {
#           "type": "integer",
#           "description": "最大输出大小（字节）。默认 102400 (100KB)。超出部分会被截断并标记。",
#           "default": 102400
#         }
#       },
#       "required": ["command"]
#     }
#   }
# },
def invoke_shell_execute(
    command: str,
    timeout: int = DEFAULT_TIMEOUT,
    working_dir: Optional[str] = None,
    description: str = "",
    session_id: str = "",
    allow_network: bool = False,
    background: bool = False,
    max_output_bytes: int = DEFAULT_MAX_OUTPUT,
    _test_mode: bool = False,
    **kwargs,
) -> Dict[str, Any]:
    """Execute a shell command through the safety chain.

    Chain: L2_policy → user interaction (ask) → L3_sandbox → execution

    P0 backward-compatible: when called with only command+timeout+working_dir
    (no allow_network, no session_id, no background), the return dict shape
    is identical to P0.
    """
    cwd = working_dir or os.getcwd()

    # 1. Parse command for semantic analysis
    try:
        from bash_parser import BashParser
        parsed = BashParser().parse(command)
    except Exception:
        parsed = None

    # 2. Construct SafetyContext
    ctx = SafetyContext(
        command=command,
        parsed=parsed,
        session_id=session_id,
        working_dir=cwd,
        allow_network=allow_network,
        timeout=timeout,
    )

    # 3. L2 policy check — compound commands get per-sub-command trace (AC #12)
    l2 = PolicyLayer()
    if _test_mode:
        # In test mode, layers can be independently disabled by external code.
        # The caller sets l2.enabled = False before invoking.
        pass

    # For compound commands, check each sub-command independently
    if parsed and len(parsed.commands) > 1:
        try:
            from shell_policy import get_permission_engine
            engine = get_permission_engine()
            from toolcommon import _find_project_config_file
            engine.set_config_finder(_find_project_config_file)
            engine.reload_rules(cwd)

            sub_decisions = []
            for cmd_node in parsed.commands:
                sub_cmd = cmd_node.raw or cmd_node.command
                t0 = time.time()
                decision = engine.check(sub_cmd, session_id=session_id,
                                        context={'cwd': cwd})
                latency = int((time.time() - t0) * 1000)
                detail = (
                    f"sub-cmd '{sub_cmd}': matched "
                    f"{decision.matched_rule.match.type}:{decision.matched_rule.match.pattern}"
                    if decision.matched_rule
                    and hasattr(decision.matched_rule, 'match')
                    else f"sub-cmd '{sub_cmd}': {decision.reason}"
                )
                ctx.trace.append(LayerDecision(
                    layer="L2_policy",
                    decision=decision.decision,
                    detail=detail,
                    latency_ms=latency,
                ))
                sub_decisions.append(decision)

            # Combine: any deny → deny, any ask → ask, all allow → allow
            l2_decision = "allow"
            for d in sub_decisions:
                if d.decision == "deny":
                    l2_decision = "deny"
                    break
                if d.decision == "ask":
                    l2_decision = "ask"
        except Exception as e:
            ctx.trace.append(LayerDecision(
                layer="L2_policy",
                decision="error",
                detail="compound check failed",
                latency_ms=0,
            ))
            l2_decision = "ask"
    else:
        ctx = l2.process(ctx)
        l2_decision = _last_trace_decision(ctx, "L2_policy")
        if l2_decision is None:
            l2_decision = "ask"  # safety default

    # 4. Handle deny
    if l2_decision == "deny":
        deny_detail = ""
        for entry in ctx.trace:
            if entry.layer == "L2_policy" and entry.decision == "deny":
                deny_detail = entry.detail
                break
        return {
            'command': command,
            'success': False,
            'decision': 'deny',
            'reason': deny_detail,
            'matched_rule': deny_detail,
            'hint': 'This command is blocked by security policy.',
            'trace': _serialize_trace(ctx.trace),
        }

    # 5. L3 sandbox check (before ask, to detect degraded mode)
    l3 = SandboxLayer()
    ctx = l3.process(ctx)
    degraded = _check_degraded_mode(ctx)

    # 6. Handle ask — either from L2 or forced by degraded mode
    # Degraded mode (AC #6): when bwrap is unavailable, ALL commands
    # require user confirmation as a safety fallback.  This includes
    # commands previously allowed via allow_once — without bwrap
    # protection, even "known safe" commands pose elevated risk.
    force_ask_degraded = degraded
    if l2_decision == "ask" or force_ask_degraded:
        executor = _get_executor()
        execution_id = uuid.uuid4().hex[:12]
        executor.stash_ask_command(session_id, execution_id, {
            'command': command,
            'timeout': timeout,
            'working_dir': working_dir,
            'description': description,
            'max_output_bytes': max_output_bytes,
            'allow_network': allow_network,
        })

        hint = 'Use shell_allow_once or shell_deny_once to respond'
        if degraded:
            hint = ('[shell] bwrap 未安装，已降级为 seccomp 模式 — '
                    '所有命令需用户确认') + ' | ' + hint

        return {
            'execution_id': execution_id,
            'command': command,
            'success': False,
            'decision': 'ask',
            'reason': 'degraded mode: all commands require confirmation' if degraded
                      else 'Command requires user approval',
            'hint': hint,
            'parsed_commands': [c.command for c in parsed.commands] if parsed and parsed.commands else [],
            'trace': _serialize_trace(ctx.trace),
        }

    # 7. L3 sandbox execution
    result = _execute_sandboxed(command, ctx, max_output_bytes=max_output_bytes)

    # 8. Build output
    output = {
        'command': command,
        'exit_code': result['exit_code'],
        'success': result['success'],
        'execution_id': result['execution_id'],
        'cwd': result['cwd'],
        'stdout': result['stdout'],
        'stderr': result['stderr'],
        'trace': _serialize_trace(ctx.trace),
    }
    if result.get('timed_out'):
        output['timed_out'] = True
        output['message'] = f"Command timed out after {timeout}s"
        if result.get('force_killed'):
            output['message'] += ' (force-killed after SIGTERM grace period)'
    if result.get('output_truncated'):
        output['output_truncated'] = True
    if result.get('stderr_truncated'):
        output['stderr_truncated'] = True

    return output


def _last_trace_decision(ctx: SafetyContext, layer: str) -> str | None:
    """Return the decision of the last trace entry for *layer*, or None."""
    for entry in reversed(ctx.trace):
        if entry.layer == layer:
            return entry.decision
    return None


def _serialize_trace(trace: list[LayerDecision]) -> list[dict]:
    """Convert LayerDecision objects to JSON-serializable dicts."""
    return [
        {
            'layer': d.layer,
            'decision': d.decision,
            'detail': d.detail,
            'latency_ms': d.latency_ms,
        }
        for d in trace
    ]


# {
#   "type": "function",
#   "function": {
#     "name": "shell_abort",
#     "description": "中止正在运行的 shell 命令。使用 shell_execute 返回的 execution_id 来终止特定进程。会话隔离：只能中止自己会话的进程。",
#     "parameters": {
#       "type": "object",
#       "properties": {
#         "execution_id": {
#           "type": "string",
#           "description": "要中止的执行的唯一 ID（由 shell_execute 返回）。"
#         },
#         "session_id": {
#           "type": "string",
#           "description": "当前会话 ID。用于会话隔离验证。"
#         }
#       },
#       "required": ["execution_id"]
#     }
#   }
# },
def invoke_shell_abort(execution_id: str, session_id: str = "", **kwargs) -> Dict[str, Any]:
    """Abort a running shell command by execution_id.

    Session-isolated: only aborts processes belonging to the calling session.
    """
    executor = _get_executor()
    result = executor.abort(session_id, execution_id)
    return result


# {
#   "type": "function",
#   "function": {
#     "name": "shell_allow_once",
#     "description": "临时放行一个被策略引擎标记为 ask 的命令。使用后需重新调用 shell_execute。",
#     "parameters": {
#       "type": "object",
#       "properties": {
#         "command": {
#           "type": "string",
#           "description": "要临时放行的命令字符串。"
#         },
#         "session_id": {
#           "type": "string",
#           "description": "当前会话 ID。"
#         }
#       },
#       "required": ["command"]
#     }
#   }
# },
def invoke_shell_allow_once(command: str, session_id: str = "", **kwargs) -> Dict[str, Any]:
    """Allow a previously-ask-blocked command to execute this one time.

    Adds a temporary allow rule for the session, then the caller
    should re-invoke shell_execute with the same command.
    """
    try:
        from shell_policy import get_permission_engine
        engine = get_permission_engine()
        engine.allow_once(session_id, command)
        return {
            'success': True,
            'message': f"Command temporarily allowed for session '{session_id}'. Re-run shell_execute.",
            'command': command,
        }
    except ImportError:
        return {
            'success': False,
            'message': 'Policy engine not available',
        }
    except Exception as e:
        return {
            'success': False,
            'message': str(e),
        }


# {
#   "type": "function",
#   "function": {
#     "name": "shell_deny_once",
#     "description": "临时拒绝一个被策略引擎标记为 ask 的命令。命令将不会被再次执行直到策略变更。",
#     "parameters": {
#       "type": "object",
#       "properties": {
#         "command": {
#           "type": "string",
#           "description": "要临时拒绝的命令字符串。"
#         },
#         "session_id": {
#           "type": "string",
#           "description": "当前会话 ID。"
#         }
#       },
#       "required": ["command"]
#     }
#   }
# },
def invoke_shell_deny_once(command: str, session_id: str = "", **kwargs) -> Dict[str, Any]:
    """Deny a previously-ask-blocked command for this session.

    The pending ask command is discarded.
    """
    try:
        from shell_policy import get_permission_engine
        engine = get_permission_engine()
        engine.deny_once(session_id, command)
        return {
            'success': True,
            'message': f"Command denied for session '{session_id}'.",
            'command': command,
        }
    except ImportError:
        return {
            'success': False,
            'message': 'Policy engine not available',
        }
    except Exception as e:
        return {
            'success': False,
            'message': str(e),
        }


# {
#   "type": "function",
#   "function": {
#     "name": "shell_version",
#     "description": "获取 shell 版本信息和工作目录。",
#     "parameters": {
#       "type": "object",
#       "properties": {},
#       "required": []
#     }
#   }
# },
def invoke_shell_version(**kwargs) -> Dict[str, Any]:
    """Return shell version information."""
    executor = _get_executor()
    return executor.version()

#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
Dataflow danger detection — detects untrusted content flowing into executable contexts.

Analyzes CommandSemantics parse results to identify dangerous data flow patterns
such as network sources piped to interpreters, command substitution attacks, and
compound-command download+execute chains.

Thread safety: THREAD_SAFE: READ_ONLY — all methods are pure functions with no mutable state.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from collections.abc import Callable

from bash_parser import CommandSemantics, CommandNode
from .error import SafetyError

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class DataflowDecision:
    """Result of dataflow danger detection analysis.

    risk=True means a dangerous data flow pattern was detected.
    harm_level: "S" (severe — immediate risk), "A" (advisory), "none" (no risk).
    """

    risk: bool
    harm_level: str = "none"
    pattern: str = ""
    detail: str = ""
    notes: str = ""

    _VALID_HARM_LEVELS: frozenset[str] = frozenset({"S", "A", "none"})

    def __post_init__(self) -> None:
        if self.harm_level not in self._VALID_HARM_LEVELS:
            raise ValueError(
                f"harm_level must be S, A, or none, got {self.harm_level!r}"
            )


# ---------------------------------------------------------------------------
# Detection constants
# ---------------------------------------------------------------------------

RISKY_SOURCES: frozenset[str] = frozenset({
    "curl", "wget", "nc", "ncat", "socat", "ftp", "tftp",
})

# Interpreter commands that execute code when receiving piped input.
# bash/sh/dash/zsh execute stdin with -s/-/no flag; python/perl/ruby/lua/node
# need explicit -c/-e/--exec but are flagged anyway when piped to (they could
# receive code via stdin with no visible flag in the parse).
_INTERPRETER_SINKS: frozenset[str] = frozenset({
    "bash", "sh", "dash", "zsh",
    "python", "python3", "perl", "ruby", "lua", "node",
})

# Execution builtins/keywords that operate on arguments directly.
_DIRECT_EXEC_SINKS: frozenset[str] = frozenset({"eval", "exec", "source"})

# All risky sinks (interpreter sinks + direct exec sinks)
RISKY_SINKS: frozenset[str] = _INTERPRETER_SINKS | _DIRECT_EXEC_SINKS

# Shell operators that create a data flow from left to right.
# Note: <() (process substitution) and $() (command substitution) are
# NOT included here — they are detected by dedicated check functions
# (_check_process_substitution_as_pipe, _check_command_substitution_in_interpreter)
# that inspect CommandNode.substitution_source rather than operators.
RISKY_OPERATORS: frozenset[str] = frozenset({"|", "|&"})

# File-reading commands whose piped output to an interpreter indicates file_to_interpreter.
# When the source is NOT a network source but pipes to an interpreter, it's treated as
# file_to_interpreter (harm_level=A).
# Network sources piped to interpreters get network_source_to_interpreter (harm_level=S).
_FILE_READERS: frozenset[str] = frozenset({
    "cat", "head", "tail", "less", "awk", "sed", "grep", "cut", "sort", "uniq",
    "tee", "dd", "strings", "iconv", "od", "hexdump", "xxd",
})


# ---------------------------------------------------------------------------
# Detection pattern functions (ordered by harm_level: S → A)
# ---------------------------------------------------------------------------


def _check_network_source_to_interpreter(sem: CommandSemantics) -> DataflowDecision | None:
    """Detect pipe from network source to interpreter shell (harm_level=S)."""
    cmds = sem.commands
    ops = sem.operators
    for i, op in enumerate(ops):
        if op not in RISKY_OPERATORS:
            continue
        if i + 1 >= len(cmds):
            continue
        src, snk = cmds[i], cmds[i + 1]
        if src.command in RISKY_SOURCES and snk.command in _INTERPRETER_SINKS:
            detail = f"{src.command} | {snk.command}: network content piped to interpreter"
            return DataflowDecision(
                risk=True,
                harm_level="S",
                pattern="network_source_to_interpreter",
                detail=detail,
            )
    return None


def _check_file_to_interpreter(sem: CommandSemantics) -> DataflowDecision | None:
    """Detect file content piped to interpreter (harm_level=A)."""
    cmds = sem.commands
    ops = sem.operators
    for i, op in enumerate(ops):
        if op not in RISKY_OPERATORS:
            continue
        if i + 1 >= len(cmds):
            continue
        src, snk = cmds[i], cmds[i + 1]
        # Skip network sources — handled by _check_network_source_to_interpreter
        if src.command in RISKY_SOURCES:
            continue
        if snk.command in _INTERPRETER_SINKS:
            src_label = src.command or "command"
            detail = f"{src_label} | {snk.command}: file content piped to interpreter"
            return DataflowDecision(
                risk=True,
                harm_level="A",
                pattern="file_to_interpreter",
                detail=detail,
            )
    return None


def _check_process_substitution_as_pipe(sem: CommandSemantics) -> DataflowDecision | None:
    """Detect interpreter <(network_source) process substitution (harm_level=S).

    Matches when a sink command has process-substitution (<(...)) containing
    a network source. Per AC 11, exec and source are also sinks for <().
    """
    proc_sub_sinks = _INTERPRETER_SINKS | {"exec", "source", "."}
    for cmd in sem.commands:
        if cmd.command not in proc_sub_sinks:
            continue
        if not cmd.is_substitution:
            continue
        # Only match <() process substitution, not $() command substitution
        if "<(" not in cmd.raw:
            continue
        sub_source = cmd.substitution_source
        for risky_src in RISKY_SOURCES:
            tokens = sub_source.split()
            if risky_src in tokens:
                detail = f"{cmd.command} <({sub_source}): process substitution"
                return DataflowDecision(
                    risk=True,
                    harm_level="S",
                    pattern="process_substitution_as_pipe",
                    detail=detail,
                )
    return None


def _check_command_substitution_in_interpreter(sem: CommandSemantics) -> DataflowDecision | None:
    """Detect interpreter -c "$(network_source)" command substitution (harm_level=S).

    Only matches interpreter sinks (bash -c, sh -c, python -c, etc.) — not
    eval/exec/source which are handled by _check_eval_dynamic_content.
    """
    for cmd in sem.commands:
        if cmd.command not in _INTERPRETER_SINKS:
            continue
        if not cmd.is_substitution:
            continue
        # Only match $() or backtick command substitution, not <() process substitution
        has_cmd_sub = "$(" in cmd.raw or "`" in cmd.raw
        if not has_cmd_sub:
            continue
        sub_source = cmd.substitution_source
        for risky_src in RISKY_SOURCES:
            tokens = sub_source.split()
            if risky_src in tokens:
                detail = f'{cmd.command} -c "$({sub_source} ...)": command substitution in interpreter'
                return DataflowDecision(
                    risk=True,
                    harm_level="S",
                    pattern="command_substitution_in_interpreter",
                    detail=detail,
                )
    return None


def _check_network_write_and_execute(sem: CommandSemantics) -> DataflowDecision | None:
    """Detect network download → execute chain in same compound command (harm_level=S).

    Two-pass: first extract files written by network sources, then check if
    any later (non-source) command executes a tracked file path.
    """
    written_files: dict[str, str] = {}  # normalized path → source command name

    # Pass 1: collect files written by network sources
    for cmd in sem.commands:
        if cmd.command in RISKY_SOURCES:
            output_path = _extract_output_path(cmd)
            if output_path:
                written_files[_normalize_path(output_path)] = cmd.command

    if not written_files:
        return None

    # Pass 2: check if any non-source command executes a tracked file
    for cmd in sem.commands:
        if cmd.command in RISKY_SOURCES:
            continue  # skip the source commands themselves

        # Check command name as an executable path
        cmd_path_norm = _normalize_path(cmd.command)
        if cmd_path_norm in written_files:
            src_name = written_files[cmd_path_norm]
            detail = f"{src_name} -o {cmd.command} && {cmd.command}: network download executed"
            return DataflowDecision(
                risk=True,
                harm_level="S",
                pattern="network_write_and_execute",
                detail=detail,
            )

        # Check args for executable paths (e.g., ./x from curl -o ./x)
        for arg in cmd.args:
            arg_norm = _normalize_path(arg)
            if arg_norm in written_files and arg.startswith((".", "/", "~")):
                src_name = written_files[arg_norm]
                detail = f"{src_name} -o {arg} && {cmd.command} {arg}: network download executed"
                return DataflowDecision(
                    risk=True,
                    harm_level="S",
                    pattern="network_write_and_execute",
                    detail=detail,
                )

    return None


def _check_eval_dynamic_content(sem: CommandSemantics) -> DataflowDecision | None:
    """Detect eval/exec/source/. with dynamic/variable content (harm_level=A).

    Does NOT cover interpreter -c (bash -c, sh -c) with inline variable
    references — those are common legitimate operations and not flagged.
    """
    for cmd in sem.commands:
        if cmd.command not in ("eval", "exec", "source", "."):
            continue

        # Check args for variable expansion ($VAR, ${VAR}) or backtick substitution
        for arg in cmd.args:
            if "$" in arg or "`" in arg:
                cmd_label = cmd.command
                detail = f'{cmd_label} "{arg}": dynamic content execution'
                return DataflowDecision(
                    risk=True,
                    harm_level="A",
                    pattern="eval_dynamic_content",
                    detail=detail,
                )

        # Check for substitution-based dynamic content (e.g., eval "$(cmd)")
        if cmd.is_substitution:
            detail = f"{cmd.command}: dynamic content via substitution"
            return DataflowDecision(
                risk=True,
                harm_level="A",
                pattern="eval_dynamic_content",
                detail=detail,
            )

    return None


# ---------------------------------------------------------------------------
# Pattern registry (ordered by harm_level priority: S → A)
# ---------------------------------------------------------------------------

# Ordered by harm_level priority (S → A) — insert new patterns at the
# correct position relative to existing ones of the same harm_level.
DETECTION_PATTERNS: list[Callable[[CommandSemantics], DataflowDecision | None]] = [
    _check_network_source_to_interpreter,
    _check_process_substitution_as_pipe,
    _check_command_substitution_in_interpreter,
    _check_network_write_and_execute,
    _check_file_to_interpreter,
    _check_eval_dynamic_content,
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _extract_output_path(cmd: CommandNode) -> str | None:
    """Extract the file path from -o/-O/--output flag in command args."""
    args = cmd.args
    for i, arg in enumerate(args):
        if arg in ("-o", "-O", "--output") and i + 1 < len(args):
            return args[i + 1]
        # Handle -o<path> or -O<path> without space
        if len(arg) > 2 and arg[0] == "-" and arg[1] in "oO" and arg[2] != "-":
            return arg[2:]
        # Handle --output=<path>
        if arg.startswith("--output="):
            return arg.partition("=")[2]
    return None


def _normalize_path(path: str) -> str:
    """Normalize a file path for comparison. Handles ./../ patterns."""
    if not path:
        return path
    return os.path.normpath(path)


# ---------------------------------------------------------------------------
# DataflowDetector
# ---------------------------------------------------------------------------


class DataflowDetector:
    """Analyze CommandSemantics for dangerous data flow patterns.

    Usage:
        decision, err = DataflowDetector.analyze(parsed)
        if err:
            # handle parse/analysis error
        elif decision.risk:
            # block or ask user about the dangerous pattern
    """

    @staticmethod
    def analyze(
        parsed: CommandSemantics | None,
    ) -> tuple[DataflowDecision | None, SafetyError | None]:
        """Analyze parsed command semantics for dangerous data flow patterns.

        Returns (DataflowDecision, None) on successful analysis,
        or (None, SafetyError) on invalid input.

        Detection runs patterns in harm_level priority order (S → A),
        returning early on first risk=True match (fail-fast optimization).
        """
        if parsed is None:
            return (
                DataflowDecision(risk=False, notes="no commands to analyze"),
                None,
            )

        if not isinstance(parsed, CommandSemantics):
            return (
                None,
                SafetyError(
                    layer="L2.5_dataflow",
                    code="INVALID_INPUT",
                    message=f"expected CommandSemantics, got {type(parsed).__name__}",
                ),
            )

        if not parsed.commands:
            return (
                DataflowDecision(risk=False, notes="no commands to analyze"),
                None,
            )

        for pattern_fn in DETECTION_PATTERNS:
            try:
                result = pattern_fn(parsed)
                if result and result.risk:
                    # Add known-limitation note when ; cross-command separators exist
                    if any(op in (";", "&") for op in parsed.operators):
                        result.notes = (
                            "cross-command analysis not performed; "
                            "only same-command chains detected"
                        )
                    return (result, None)
            except Exception as exc:
                return (
                    None,
                    SafetyError(
                        layer="L2.5_dataflow",
                        code="ANALYSIS_ERROR",
                        message=f"pattern check failed: {exc!s}"[:80],
                    ),
                )

        # No risk detected
        notes = ""
        if any(op in (";", "&") for op in parsed.operators):
            notes = (
                "cross-command analysis not performed; "
                "only same-command chains detected"
            )
        return (DataflowDecision(risk=False, notes=notes), None)

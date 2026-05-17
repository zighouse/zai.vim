#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
Bash semantic parser — pure parsing, no execution.

Decomposes shell command strings into structured semantics:
command names, arguments, redirects, pipes, operators, env vars, heredocs.
Used by the permission engine for pre-execution auditing.

Key design: shlex for tokenization (audit layer), /bin/sh -c for execution (execution layer).
The two layers are intentionally separate.
"""

import re
import shlex
import shutil
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class Redirect:
    """A single I/O redirection."""
    type: str          # '>', '>>', '<', '2>', '2>&1', '&>', '>&', '2>>', '<>'
    target: str        # file path or fd number


@dataclass
class CommandNode:
    """A single command in a potentially compound command string."""
    command: str                # command name (e.g. 'git', 'echo')
    args: List[str]             # positional arguments
    env_vars: Dict[str, str]    # KEY=VALUE prefix assignments
    redirects: List[Redirect]   # I/O redirections
    is_pipe_input: bool         # receives stdin from previous pipe
    is_pipe_output: bool        # sends stdout to next pipe
    raw: str                    # original text of this command segment
    input_source: str = "none"              # "pipe" | "stdin" | "file" | "none" — stdin not set by current inference
    output_dest: str = "none"               # "pipe" | "stdout" | "file" | "none" — stdout not set by current inference
    is_substitution: bool = False           # embedded in $() or <()
    substitution_source: str = ""           # original text of the substitution

    _INPUT_SOURCES = frozenset({'pipe', 'stdin', 'file', 'none'})
    _OUTPUT_DESTS = frozenset({'pipe', 'stdout', 'file', 'none'})

    def __post_init__(self):
        if self.input_source not in self._INPUT_SOURCES:
            raise ValueError(f"input_source must be one of {self._INPUT_SOURCES}, got {self.input_source!r}")
        if self.output_dest not in self._OUTPUT_DESTS:
            raise ValueError(f"output_dest must be one of {self._OUTPUT_DESTS}, got {self.output_dest!r}")


@dataclass
class CommandSemantics:
    """Full parse result for a (possibly compound) shell command string."""
    commands: List[CommandNode]
    operators: List[str]           # '|', '|&', '&&', '||', ';', '&'
    unsupported_features: List[str]  # e.g. 'command_substitution', 'process_substitution'
    original: str                  # the input string


# Recognised shell metacharacters / operators
_SHELL_OPERATORS = {'|', '|&', '&&', '||', ';', '&'}

# Redirection patterns sorted by length (longest first to match greedily)
_REDIRECT_PATTERNS = [
    '2>>', '2>&1', '2>&2', '1>&2', '1>&1',
    '&>>', '&>', '>&', '>>', '>', '<>', '<',
    '2>', '1>',
]

# Patterns recognised but not fully supported — flagged for safety downgrade
_UNSUPPORTED_PATTERNS = [
    ('$(', 'command_substitution'),
    ('`', 'command_substitution'),
    ('${', 'variable_expansion'),
    ('<(', 'process_substitution'),
    ('>(', 'process_substitution'),
    ('(', 'subshell'),          # crude; refined in context
]

# Default dangerous redirect targets
_DANGEROUS_REDIRECT_TARGETS = {'/dev/sda', '/dev/sdb', '/dev/sdc', '/dev/sdd',
                                '/dev/hda', '/dev/hdb', '/dev/nvme0', '/dev/mmcblk0'}

# Substitution extraction patterns (best-effort, outermost only)
_CMD_SUBST_PATTERN = re.compile(r'\$\(([^)]+)\)')
_BACKTICK_PATTERN = re.compile(r'`([^`]+)`')
_PROC_SUBST_PATTERN = re.compile(r'[<>]\(([^)]+)\)')

# Safe wrappers that can be stripped to reveal the real command
SAFE_WRAPPERS = frozenset({
    'sudo', 'nice', 'nohup', 'ionice', 'chrt', 'taskset',
    'flock', 'time', 'timeout', 'stdbuf', 'unbuffer',
    'eatmydata', 'fakeroot', 'faketime', 'prlimit',
    'numactl', 'setsid', 'setpriv', 'env', 'exec',
})


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

class BashParser:
    """Parse shell command strings into structured semantics without executing."""

    def parse(self, command_string: str) -> CommandSemantics:
        """Decompose a shell command string into CommandSemantics.

        Returns a structured result even for malformed or unsupported input;
        unsupported features are flagged rather than causing errors.
        """
        original = command_string.strip()
        if not original:
            return CommandSemantics(
                commands=[], operators=[], unsupported_features=[], original=original
            )

        unsupported: List[str] = []
        # Detect unsupported syntax patterns
        for pattern, label in _UNSUPPORTED_PATTERNS:
            if pattern in original:
                if label not in unsupported:
                    unsupported.append(label)

        # Tokenize with shlex (handles quoting correctly)
        try:
            tokens = shlex.split(original, posix=True)
        except ValueError:
            # shlex failed (e.g. unbalanced quotes) — best-effort fallback
            tokens = self._fallback_split(original)

        if not tokens:
            return CommandSemantics(
                commands=[], operators=[], unsupported_features=unsupported, original=original
            )

        # Split tokens by operators into command segments
        segments, operators = self._split_by_operators(tokens)

        commands: List[CommandNode] = []
        for i, seg_tokens in enumerate(segments):
            if not seg_tokens:
                continue
            cmd = self._parse_command_segment(
                seg_tokens,
                is_pipe_input=(i > 0 and i - 1 < len(operators) and operators[i - 1] in ('|', '|&')),
                is_pipe_output=(i < len(operators) and operators[i] in ('|', '|&')),
            )
            commands.append(cmd)

        # Post-process: extract substitution metadata (Task 2)
        for cmd in commands:
            self._enrich_substitution_metadata(cmd)

        return CommandSemantics(
            commands=commands,
            operators=operators,
            unsupported_features=unsupported,
            original=original,
        )

    def parse_command_name_only(self, cmd_string: str) -> List[str]:
        """Extract only the command names from a shell command string.

        Fast path for permission checks that don't need full semantics.
        """
        result = self.parse(cmd_string)
        return [c.command for c in result.commands if c.command]

    # ------------------------------------------------------------------
    # Internal: substitution extraction
    # ------------------------------------------------------------------

    def _enrich_substitution_metadata(self, cmd: CommandNode) -> None:
        """Extract substitution metadata from command raw text."""
        raw = cmd.raw
        sources: List[str] = []
        for m in _CMD_SUBST_PATTERN.finditer(raw):
            sources.append(m.group(1).strip())
        for m in _BACKTICK_PATTERN.finditer(raw):
            sources.append(m.group(1).strip())
        for m in _PROC_SUBST_PATTERN.finditer(raw):
            sources.append(m.group(1).strip())
        if sources:
            cmd.is_substitution = True
            cmd.substitution_source = "; ".join(sources)

    # ------------------------------------------------------------------
    # Internal: token splitting
    # ------------------------------------------------------------------

    def _expand_embedded_operators(self, tokens: List[str]) -> List[str]:
        """Pre-process tokens, splitting those with embedded operators.

        shlex doesn't split on shell metacharacters without surrounding
        whitespace.  This pass catches the common cases:
        'echo hello;ls'  -> ['echo', 'hello', ';', 'ls']
        'cmd1&&cmd2'     -> ['cmd1', '&&', 'cmd2']
        'cmd1||cmd2'     -> ['cmd1', '||', 'cmd2']
        """
        result: List[str] = []
        for tok in tokens:
            result.extend(self._split_embedded_operator(tok))
        return result

    def _split_embedded_operator(self, tok: str) -> List[str]:
        """Split one token on embedded ``;``, ``&&``, ``||``."""
        if len(tok) <= 1:
            return [tok]

        parts: List[str] = []
        buf: List[str] = []
        i = 0
        while i < len(tok):
            if i + 1 < len(tok) and tok[i:i+2] in ('&&', '||'):
                if buf:
                    parts.append(''.join(buf))
                    buf = []
                parts.append(tok[i:i+2])
                i += 2
            elif tok[i] == ';':
                if buf:
                    parts.append(''.join(buf))
                    buf = []
                parts.append(tok[i])
                i += 1
            else:
                buf.append(tok[i])
                i += 1

        if buf:
            parts.append(''.join(buf))

        return parts if len(parts) > 1 else [tok]

    def _split_by_operators(self, tokens: List[str]) -> Tuple[List[List[str]], List[str]]:
        """Split token list into segments at shell operators (|, &&, ||, ;, &).

        Also handles tokens with trailing ; or & without spaces (e.g. 'a;').
        Redirect tokens (>>, 2>, >&, etc.) are kept in segments for _match_redirect().
        """
        tokens = self._expand_embedded_operators(tokens)
        segments: List[List[str]] = []
        operators: List[str] = []
        current: List[str] = []

        # Only shell list/pipe operators — NOT redirect tokens
        _SHELL_LIST_OPS = {'&&', '||', '|&'}

        # Redirect-like tokens that must NOT be split as operators
        _REDIRECT_TOKENS = frozenset({'2>', '1>', '>>', '<<', '<>', '>&', '&>', '&>>'})

        i = 0
        while i < len(tokens):
            tok = tokens[i]

            # Check 2-char shell operators first
            if tok in _SHELL_LIST_OPS:
                if current:
                    segments.append(current)
                    current = []
                operators.append(tok)
            elif tok == '|':
                if current:
                    segments.append(current)
                    current = []
                operators.append('|')
            elif tok in (';', '&'):
                if current:
                    segments.append(current)
                    current = []
                operators.append(tok)
            # Handle tokens with trailing ; or & without spaces (e.g. 'a;', 'cmd&')
            # but skip redirect tokens like >&, &> to keep them in segments
            elif len(tok) > 1 and tok[-1] in (';', '&') and tok not in _REDIRECT_TOKENS:
                if tok[-1] == '&' and len(tok) > 2 and tok[-2] == '&':
                    # 'cmd&&' → split 'cmd' + '&&'
                    current.append(tok[:-2])
                    if current:
                        segments.append(current)
                        current = []
                    operators.append('&&')
                else:
                    current.append(tok[:-1])
                    if current:
                        segments.append(current)
                        current = []
                    operators.append(tok[-1])
            else:
                current.append(tok)
            i += 1

        if current:
            segments.append(current)

        return segments, operators

    def _parse_command_segment(
        self, tokens: List[str], is_pipe_input: bool, is_pipe_output: bool
    ) -> CommandNode:
        """Parse a single command segment (between operators) into a CommandNode."""
        env_vars: Dict[str, str] = {}
        redirects: List[Redirect] = []
        args: List[str] = []
        command: str = ""

        i = 0
        while i < len(tokens):
            tok = tokens[i]

            # Check for env var assignment: KEY=VALUE (only before command)
            if not command and '=' in tok and not tok.startswith('='):
                key, _, value = tok.partition('=')
                if key and _is_valid_env_key(key):
                    env_vars[key] = value
                    i += 1
                    continue

            # Check for redirection operator
            redir = self._match_redirect(tokens, i)
            if redir:
                redirects.append(redir[0])
                i = redir[1]  # skip consumed tokens
                continue

            if not command:
                command = tok
            else:
                args.append(tok)
            i += 1

        raw = ' '.join(tokens)

        # Infer input_source (Task 3)
        input_source = "none"
        if is_pipe_input:
            input_source = "pipe"
        elif any(r.type in ('<', '<>') for r in redirects):
            input_source = "file"

        # Infer output_dest (Task 3)
        # Only stdout redirects set output_dest; stderr-only redirects (2>, 2>>) do not.
        output_dest = "none"
        _STDOUT_REDIRECTS = ('>', '>>', '&>', '&>>')
        if is_pipe_output:
            output_dest = "pipe"
        elif any(r.type in _STDOUT_REDIRECTS or r.type.startswith('1>') for r in redirects):
            output_dest = "file"

        return CommandNode(
            command=command,
            args=args,
            env_vars=env_vars,
            redirects=redirects,
            is_pipe_input=is_pipe_input,
            is_pipe_output=is_pipe_output,
            raw=raw,
            input_source=input_source,
            output_dest=output_dest,
        )

    def _match_redirect(self, tokens: List[str], idx: int) -> Optional[Tuple[Redirect, int]]:
        """Try to match a redirection pattern at position idx.

        Returns (Redirect, next_index) or None.
        """
        tok = tokens[idx]

        # Numeric fd prefix? e.g. "2>"
        fd_prefix = ""
        rest = tok
        if tok and tok[0].isdigit() and len(tok) > 1:
            for j, ch in enumerate(tok):
                if not ch.isdigit():
                    fd_prefix = tok[:j]
                    rest = tok[j:]
                    break

        for pat in _REDIRECT_PATTERNS:
            if rest == pat or (fd_prefix and rest == pat):
                full_type = fd_prefix + pat if fd_prefix else pat
                if pat in ('2>&1', '2>&2', '1>&2', '1>&1', '>&'):
                    target = ""
                    if idx + 1 < len(tokens):
                        target = tokens[idx + 1]
                    return Redirect(type=full_type, target=target), idx + 2 if target else idx + 1
                if idx + 1 < len(tokens):
                    target = tokens[idx + 1]
                    return Redirect(type=full_type, target=target), idx + 2
                return Redirect(type=full_type, target=""), idx + 1

            # Handle fd>&digit patterns (e.g. '>&1' when rest != '>&')
            if pat == '>&' and rest.startswith('>&') and len(rest) > 2:
                target = rest[2:]  # the fd number after >&
                full_type = fd_prefix + '>&' + target if fd_prefix else '>&' + target
                return Redirect(type=full_type, target=target), idx + 1

        return None

    def _fallback_split(self, text: str) -> List[str]:
        """Best-effort tokenization when shlex fails."""
        # Simple whitespace split preserving quoted segments loosely
        return text.split()


# ---------------------------------------------------------------------------
# Command normalisation
# ---------------------------------------------------------------------------

def normalize_command(command_name: str) -> Dict:
    """Normalize a command name for permission matching.

    (a) Resolve to absolute path via shutil.which()
    (b) Strip leading redirects and extra whitespace
    (c) Extract inner command from safe wrappers (sudo, nice, nohup, etc.)

    Returns: {command: str, wrapper: Optional[str], unresolved_path: bool, original: str}
    """
    original = command_name
    cmd = command_name.strip()

    # Strip common safe wrappers
    wrapper = None
    for sw in SAFE_WRAPPERS:
        if cmd == sw or cmd.startswith(sw + ' '):
            wrapper = sw
            cmd = cmd[len(sw):].strip()
            break

    # Resolve path
    resolved = shutil.which(cmd)
    unresolved_path = resolved is None
    if resolved:
        cmd = resolved

    return {
        'command': cmd,
        'wrapper': wrapper,
        'unresolved_path': unresolved_path,
        'original': original,
    }


def _is_valid_env_key(key: str) -> bool:
    """Check if a string is a valid shell environment variable name."""
    if not key:
        return False
    return all(c.isalnum() or c == '_' for c in key) and not key[0].isdigit()

#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
Shell permission policy engine.

Three-layer rule system (allow / deny / ask) with file-based policy
configuration and session-level temporary rules. Permission checking
happens before command execution — the engine is independent of the
execution layer.

Architecture:
  PermissionEngine.check() → PolicyDecision
  PolicyLoader loads rules from: built-in → user → project
  Hot-reload: detects file mtime changes, atomically replaces rules
"""

import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

from bash_parser import BashParser, SAFE_WRAPPERS

try:
    import yaml
    HAVE_YAML = True
except ImportError:
    HAVE_YAML = False

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class MatchSpec:
    """How a rule matches commands."""
    type: str      # 'exact' | 'prefix' | 'wildcard'
    pattern: str   # the pattern to match against


@dataclass
class PolicyRule:
    """A single permission rule."""
    behavior: str      # 'allow' | 'deny' | 'ask'
    match: MatchSpec
    description: str = ""   # human-readable explanation
    source: str = ""        # where this rule came from (file path or 'session')
    priority: int = 0       # higher = checked first within same behavior


@dataclass
class PolicyDecision:
    """Result of a permission check."""
    decision: str                # 'allow' | 'deny' | 'ask'
    matched_rule: Optional[PolicyRule] = None
    reason: str = ""
    parsed_commands: Optional[List[str]] = None  # extracted command names


# ---------------------------------------------------------------------------
# Default built-in deny rules (5 absolutely dangerous commands)
# ---------------------------------------------------------------------------

DEFAULT_DENY_RULES: List[PolicyRule] = [
    PolicyRule(
        behavior="deny",
        match=MatchSpec(type="wildcard", pattern="rm -rf /*"),
        description="Recursive force remove from root — irreversible data loss",
        source="built-in",
    ),
    PolicyRule(
        behavior="deny",
        match=MatchSpec(type="wildcard", pattern="rm -rf /"),
        description="Recursive force remove of root filesystem — irreversible data loss",
        source="built-in",
    ),
    PolicyRule(
        behavior="deny",
        match=MatchSpec(type="wildcard", pattern="dd if=* of=/dev/*"),
        description="Direct write to block device — can destroy disks",
        source="built-in",
    ),
    PolicyRule(
        behavior="deny",
        match=MatchSpec(type="wildcard", pattern="mkfs.*"),
        description="Filesystem creation — formats disks",
        source="built-in",
    ),
    PolicyRule(
        behavior="deny",
        match=MatchSpec(type="wildcard", pattern="*> /dev/sd*"),
        description="Redirect to block device — can overwrite disks",
        source="built-in",
    ),
    PolicyRule(
        behavior="deny",
        match=MatchSpec(type="wildcard", pattern="*:(){ :|:& };:*"),
        description="Fork bomb — can crash the system",
        source="built-in",
    ),
]


# ---------------------------------------------------------------------------
# Wildcard matching (no fnmatch dependency)
# ---------------------------------------------------------------------------

def _wildcard_match(pattern: str, text: str) -> bool:
    """Match * and ? wildcards. * crosses path separators."""
    pi = ti = 0
    star_idx = -1
    match_idx = 0

    while ti < len(text):
        if pi < len(pattern) and pattern[pi] == '*':
            star_idx = pi
            match_idx = ti
            pi += 1
        elif pi < len(pattern) and (pattern[pi] == '?' or pattern[pi] == text[ti]):
            pi += 1
            ti += 1
        elif star_idx != -1:
            pi = star_idx + 1
            match_idx += 1
            ti = match_idx
        else:
            return False

    while pi < len(pattern) and pattern[pi] == '*':
        pi += 1

    return pi == len(pattern)


def _match_rule(rule: PolicyRule, normalized_command: str) -> bool:
    """Test whether a single rule matches a normalized command string."""
    match = rule.match
    pattern = match.pattern
    cmd = normalized_command

    if match.type == 'exact':
        return cmd == pattern
    elif match.type == 'prefix':
        return cmd.startswith(pattern)
    elif match.type == 'wildcard':
        return _wildcard_match(pattern, cmd)
    return False


# ---------------------------------------------------------------------------
# Policy file loading
# ---------------------------------------------------------------------------

class PolicyLoader:
    """Load shell policy rules from files in priority order.

    Priority (highest last within same behavior):
      1. Built-in default deny rules
      2. User-level: ~/.local/share/zai/shell_policy.yaml
      3. Project-level: .zai/zai_project.yaml (shell_policy field),
         found via find_upwards from CWD
    """

    USER_POLICY_FILENAME = "shell_policy.yaml"
    PROJECT_CONFIG_KEY = "shell_policy"

    def __init__(self, user_data_dir_func: Callable[[str, str], str]):
        self._user_data_dir_func = user_data_dir_func
        self._finder = None  # set later for project config lookup

    def set_finder(self, finder: Callable):
        """Set the function to find project config files (find_upwards)."""
        self._finder = finder

    def load_all_rules(self, cwd: Optional[str] = None) -> List[PolicyRule]:
        """Load rules from all sources in priority order.

        Returns a merged list. Later rules within the same behavior have
        higher effective priority (checked earlier).
        """
        rules: List[PolicyRule] = []

        # 1. Built-in defaults
        rules.extend(DEFAULT_DENY_RULES)

        # 2. User-level policy
        user_rules = self._load_user_policy()
        if user_rules is not None:
            rules.extend(user_rules)

        # 3. Project-level policy (only if finder is available)
        project_rules = self._load_project_policy(cwd)
        if project_rules:
            rules.extend(project_rules)

        return rules

    def _load_user_policy(self) -> Optional[List[PolicyRule]]:
        """Load rules from ~/.local/share/zai/shell_policy.yaml."""
        if not HAVE_YAML:
            return None
        try:
            conf_dir = Path(self._user_data_dir_func("zai", "zighouse"))
            policy_file = conf_dir / self.USER_POLICY_FILENAME
            if not policy_file.is_file():
                return None
            return self._load_yaml_file(str(policy_file), "user")
        except Exception:
            return None

    def _load_project_policy(self, cwd: Optional[str] = None) -> Optional[List[PolicyRule]]:
        """Load rules from .zai/zai_project.yaml (shell_policy field)."""
        if not HAVE_YAML or self._finder is None:
            return None
        try:
            config_file = self._finder(cwd)
            if config_file is None:
                return None
            with open(config_file, 'r', encoding='utf-8') as f:
                content = f.read()
            data = yaml.safe_load(content)
            if not isinstance(data, dict):
                return None
            shell_policy = data.get(self.PROJECT_CONFIG_KEY)
            if not isinstance(shell_policy, dict):
                return None
            raw_rules = shell_policy.get('rules')
            if not isinstance(raw_rules, list):
                return None
            if len(raw_rules) == 0:
                # Empty rules list = warn and continue upward search
                print(f"[shell_policy] WARN: empty rules in {config_file}, "
                      "continuing upward search", file=sys.stderr)
                return None
            return self._validate_rules(raw_rules, str(config_file))
        except yaml.YAMLError as e:
            print(f"[shell_policy] WARN: YAML parse error in project config: {e}",
                  file=sys.stderr)
            return None
        except Exception:
            return None

    def _load_yaml_file(self, path: str, source_label: str) -> Optional[List[PolicyRule]]:
        """Load and validate a YAML policy file."""
        try:
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
            data = yaml.safe_load(content)
            if not isinstance(data, dict):
                print(f"[shell_policy] WARN: {path} root must be a dict", file=sys.stderr)
                return None
            raw_rules = data.get('rules', [])
            if not isinstance(raw_rules, list):
                print(f"[shell_policy] WARN: {path} 'rules' must be a list", file=sys.stderr)
                return None
            if len(raw_rules) == 0:
                print(f"[shell_policy] WARN: empty rules in {path}, skipping",
                      file=sys.stderr)
                return None
            return self._validate_rules(raw_rules, source_label)
        except yaml.YAMLError as e:
            print(f"[shell_policy] WARN: YAML parse error in {path}: {e}", file=sys.stderr)
            return None
        except Exception as e:
            print(f"[shell_policy] WARN: failed to load {path}: {e}", file=sys.stderr)
            return None

    def _validate_rules(self, raw_rules: list, source: str) -> List[PolicyRule]:
        """Validate a list of raw rule dicts, skip invalid entries, return valid PolicyRules."""
        valid: List[PolicyRule] = []
        for i, entry in enumerate(raw_rules):
            if not isinstance(entry, dict):
                print(f"[shell_policy] WARN: rule #{i} in {source} is not a dict, skipping",
                      file=sys.stderr)
                continue
            behavior = entry.get('behavior')
            if behavior not in ('allow', 'deny', 'ask'):
                print(f"[shell_policy] WARN: rule #{i} in {source} has invalid behavior "
                      f"'{behavior}', skipping", file=sys.stderr)
                continue
            match_raw = entry.get('match')
            if not isinstance(match_raw, dict):
                print(f"[shell_policy] WARN: rule #{i} in {source} missing 'match' dict, skipping",
                      file=sys.stderr)
                continue
            match_type = match_raw.get('type')
            if match_type not in ('exact', 'prefix', 'wildcard'):
                print(f"[shell_policy] WARN: rule #{i} in {source} invalid match type "
                      f"'{match_type}', skipping", file=sys.stderr)
                continue
            pattern = match_raw.get('pattern', '')
            if not pattern:
                print(f"[shell_policy] WARN: rule #{i} in {source} missing pattern, skipping",
                      file=sys.stderr)
                continue
            valid.append(PolicyRule(
                behavior=behavior,
                match=MatchSpec(type=match_type, pattern=pattern),
                description=entry.get('description', ''),
                source=source,
                priority=i,
            ))
        return valid


# ---------------------------------------------------------------------------
# Permission engine
# ---------------------------------------------------------------------------

class PermissionEngine:
    """Check shell commands against loaded policies.

    Usage::

        engine = PermissionEngine(user_data_dir_func)
        engine.set_config_finder(toolcommon._find_project_config_file)
        engine.reload_rules()

        decision = engine.check("rm -rf /tmp/test", session_id="A")
        if decision.decision == 'ask':
            # ... present to user, wait for allow_once/deny_once ...
    """

    def __init__(self, user_data_dir_func: Callable[[str, str], str]):
        self._loader = PolicyLoader(user_data_dir_func)
        self._rules: List[PolicyRule] = list(DEFAULT_DENY_RULES)

        # Last-good-rule snapshots for atomic hot-reload.
        # When a file read / YAML parse fails mid-write, we keep the previous
        # state for that source instead of dropping it (TOCTOU guard).
        self._last_good_user_rules: Optional[List[PolicyRule]] = None
        self._last_good_project_rules: Optional[List[PolicyRule]] = None

        self._parser = BashParser()

        # Session-level temporary rules: session_id → List[PolicyRule]
        self._session_rules: Dict[str, List[PolicyRule]] = {}

        # Pending ask commands: (session_id, execution_id) → dict
        self._pending_commands: Dict[Tuple[str, str], dict] = {}

        # Hot-reload tracking
        self._file_mtimes: Dict[str, float] = {}
        self._last_load_time: float = 0.0
        self._cwd: Optional[str] = None

    def set_config_finder(self, finder: Callable):
        """Set the function used to locate project config files."""
        self._loader.set_finder(finder)

    def reload_rules(self, cwd: Optional[str] = None):
        """(Re)load all rules. Call on init and when hot-reload detects changes.

        Atomic replacement: if an external source file fails to parse
        (e.g. editor mid-write), the previous successful rules for that
        source are kept rather than dropped.
        """
        built_in = list(DEFAULT_DENY_RULES)

        # Try user-level rules; fall back to last-good snapshot on failure
        user_rules = self._loader._load_user_policy()
        if user_rules is not None:
            self._last_good_user_rules = user_rules
        elif self._last_good_user_rules is not None:
            user_rules = self._last_good_user_rules

        # Try project-level rules; fall back to last-good snapshot on failure
        project_rules = self._loader._load_project_policy(cwd)
        if project_rules is not None:
            self._last_good_project_rules = project_rules
        elif self._last_good_project_rules is not None:
            project_rules = self._last_good_project_rules

        new_rules = built_in
        if user_rules is not None:
            new_rules.extend(user_rules)
        if project_rules is not None:
            new_rules.extend(project_rules)

        self._rules = new_rules
        self._cwd = cwd
        self._last_load_time = time.time()
        self._snapshot_mtimes(cwd)

    def _snapshot_mtimes(self, cwd: Optional[str] = None):
        """Record mtimes of policy source files for change detection."""
        self._file_mtimes = {}
        # User policy file
        try:
            from appdirs import user_data_dir
            conf_dir = Path(user_data_dir("zai", "zighouse"))
            user_file = conf_dir / PolicyLoader.USER_POLICY_FILENAME
            if user_file.is_file():
                self._file_mtimes[str(user_file)] = user_file.stat().st_mtime
        except Exception:
            pass
        # Project config file
        if self._loader._finder:
            try:
                config_file = self._loader._finder(cwd)
                if config_file:
                    self._file_mtimes[str(config_file)] = config_file.stat().st_mtime
            except Exception:
                pass

    def _check_hot_reload(self, cwd: Optional[str] = None):
        """Check if any policy files have changed and reload if so."""
        reload_needed = False
        for fpath, old_mtime in self._file_mtimes.items():
            try:
                new_mtime = os.stat(fpath).st_mtime
                if new_mtime != old_mtime:
                    reload_needed = True
                    break
            except OSError:
                reload_needed = True
                break
        if reload_needed:
            self.reload_rules(cwd or self._cwd)

    def check(self, command_string: str, session_id: str = "",
              context: Optional[Dict] = None) -> PolicyDecision:
        """Check a shell command against all loaded policies.

        For compound commands (pipes, &&, ||, ;), each sub-command is checked
        independently and the strictest decision is returned (deny > ask > allow).

        Session-level temporary rules are checked first (highest priority).
        """
        context = context or {}
        cwd = context.get('cwd')
        self._check_hot_reload(cwd)

        # Parse command
        semantics = self._parser.parse(command_string)
        commands = semantics.commands

        # For compound commands, check each sub-command independently
        if len(commands) > 1:
            # First, try matching the full command string against rules.
            # This allows allow_once "pwd && ls" to match the compound
            # string directly instead of being split into sub-commands
            # where the full-string wildcard pattern won't match.
            full_check = self._check_single(
                command_string, session_id, {}, command_string)
            if full_check.decision != 'ask':
                return full_check

            decisions = []
            for cmd_node in commands:
                effective_cmd = _effective_command(cmd_node)
                decisions.append(self._check_single(
                    effective_cmd, session_id, {}, cmd_node.raw))
            return self._combine_decisions(decisions,
                   [c.command for c in commands if c.command])
        elif commands and commands[0].command:
            cmd_node = commands[0]
            effective_cmd = _effective_command(cmd_node)
            return self._check_single(effective_cmd, session_id, {}, cmd_node.raw)
        else:
            # No parseable command — safety default to ask
            return PolicyDecision(
                decision="ask",
                reason="Could not parse command name; safety default to ask",
                parsed_commands=[],
            )

    def _check_single(self, normalized_command: str, session_id: str,
                      norm_info: Dict, raw_command: str = "") -> PolicyDecision:
        """Check a single command against rules.

        Matches against both the normalized command name (for prefix/exact)
        and the raw command string (for wildcard patterns with args).
        """
        effective_rules: List[PolicyRule] = []
        if session_id and session_id in self._session_rules:
            effective_rules.extend(self._session_rules[session_id])
        effective_rules.extend(self._rules)

        deny_rules = [r for r in effective_rules if r.behavior == 'deny']
        ask_rules = [r for r in effective_rules if r.behavior == 'ask']
        allow_rules = [r for r in effective_rules if r.behavior == 'allow']

        # Build match targets: try raw string, then normalized command
        match_targets = [raw_command, normalized_command] if raw_command else [normalized_command]

        # Also try raw_command with safe wrappers stripped from the front
        # This catches 'sudo rm -rf /', 'timeout 10 rm -rf /', etc.
        if raw_command:
            cmd = raw_command
            for _ in range(3):
                ps = cmd.split(None, 1)
                if len(ps) == 2 and ps[0] in SAFE_WRAPPERS:
                    cmd = ps[1]
                    if cmd not in match_targets:
                        match_targets.append(cmd)
                else:
                    break

        # Check deny
        for rule in deny_rules:
            for target in match_targets:
                if target and _match_rule(rule, target):
                    return PolicyDecision(
                        decision="deny",
                        matched_rule=rule,
                        reason=f"Matched deny rule: {rule.description or rule.match.pattern}",
                        parsed_commands=[normalized_command],
                    )

        # Check ask
        for rule in ask_rules:
            for target in match_targets:
                if target and _match_rule(rule, target):
                    return PolicyDecision(
                        decision="ask",
                        matched_rule=rule,
                        reason=f"Matched ask rule: {rule.description or rule.match.pattern}",
                        parsed_commands=[normalized_command],
                    )

        # Check allow
        for rule in allow_rules:
            for target in match_targets:
                if target and _match_rule(rule, target):
                    return PolicyDecision(
                        decision="allow",
                        matched_rule=rule,
                        reason=f"Matched allow rule: {rule.description or rule.match.pattern}",
                        parsed_commands=[normalized_command],
                    )

        # No match — ask
        return PolicyDecision(
            decision="ask",
            reason="No matching rule",
            parsed_commands=[normalized_command],
        )

    def _combine_decisions(self, decisions: List[PolicyDecision],
                           command_names: List[str]) -> PolicyDecision:
        """Combine decisions from compound command sub-checks.

        Returns the strictest: any deny → deny, any ask → ask, all allow → allow.
        """
        # Check deny
        for dec in decisions:
            if dec.decision == 'deny':
                return PolicyDecision(
                    decision="deny",
                    matched_rule=dec.matched_rule,
                    reason=f"Compound command contains denied sub-command: {dec.reason}",
                    parsed_commands=command_names,
                )
        # Check ask
        for dec in decisions:
            if dec.decision == 'ask':
                return PolicyDecision(
                    decision="ask",
                    reason=f"Compound command contains uncertain sub-command: {dec.reason}",
                    parsed_commands=command_names,
                )
        # All allow
        return PolicyDecision(
            decision="allow",
            reason="All sub-commands allowed",
            parsed_commands=command_names,
        )

    # ------------------------------------------------------------------
    # Session-level temporary rules
    # ------------------------------------------------------------------

    def allow_once(self, session_id: str, command: str):
        """Add a temporary allow rule for one session.

        Does nothing when session_id is empty — callers without a session
        cannot participate in session-level temporary rules.
        """
        if not session_id:
            return
        rule = PolicyRule(
            behavior="allow",
            match=MatchSpec(type="wildcard", pattern=command),
            description=f"Temporary allow: {command}",
            source="session",
            priority=9999,
        )
        self._session_rules.setdefault(session_id, []).insert(0, rule)

    def deny_once(self, session_id: str, command: str):
        """Add a temporary deny rule for one session.

        Does nothing when session_id is empty — callers without a session
        cannot participate in session-level temporary rules.
        """
        if not session_id:
            return
        rule = PolicyRule(
            behavior="deny",
            match=MatchSpec(type="wildcard", pattern=command),
            description=f"Temporary deny: {command}",
            source="session",
            priority=9999,
        )
        self._session_rules.setdefault(session_id, []).insert(0, rule)

    def clear_session_rules(self, session_id: str):
        """Remove all temporary rules for a session."""
        self._session_rules.pop(session_id, None)

    # ------------------------------------------------------------------
    # Pending ask commands
    # ------------------------------------------------------------------

    def stash_pending(self, session_id: str, execution_id: str, cmd_data: dict):
        """Store a pending command awaiting user confirmation."""
        self._pending_commands[(session_id, execution_id)] = {
            **cmd_data,
            '_stashed_at': time.time(),
        }

    def pop_pending(self, session_id: str, execution_id: str) -> Optional[dict]:
        """Retrieve and remove a pending command."""
        return self._pending_commands.pop((session_id, execution_id), None)

    def expire_pending(self, max_age_seconds: float = 300.0):
        """Remove pending commands older than max_age_seconds."""
        now = time.time()
        expired = [
            k for k, v in self._pending_commands.items()
            if now - v.get('_stashed_at', 0) > max_age_seconds
        ]
        for k in expired:
            self._pending_commands.pop(k, None)

    # ------------------------------------------------------------------
    # Deny message formatting and policy export (Story 4.1)
    # ------------------------------------------------------------------

    @staticmethod
    def format_deny_message(decision: 'PolicyDecision') -> str:
        """Format a human-readable deny message for user display.

        Produces a single-line message with source prefix and match info.
        Does NOT include an outer [shell] prefix — callers add it.
        Message is truncated to 80 chars for Vim echo compatibility.

        Args:
            decision: A PolicyDecision with decision="deny".

        Returns:
            A ≤ 80 char message string.
        """
        if decision.decision != "deny":
            return f"denied: unexpected decision '{decision.decision}'"

        if decision.matched_rule is None:
            return "denied: no matching allow rule (default deny)"

        rule = decision.matched_rule
        src = f"[{rule.source}] " if rule.source else ""
        info = f"{rule.match.type}:{rule.match.pattern}"
        msg = f"{src}denied: matched rule '{info}' (behavior: {rule.behavior})"

        if rule.description:
            # Truncate to fit 80-char Vim echo limit (3 for " - ", 1 for "…")
            max_desc = 80 - len(msg) - 4
            if max_desc >= 1:
                desc = rule.description if len(rule.description) <= max_desc else rule.description[:max_desc] + "…"
                msg += f" - {desc}"

        return msg

    def get_rules_count(self) -> dict[str, int]:
        """Count active policy rules by source.

        Returns:
            {"user_rules": N, "project_rules": M, "built_in_rules": B, "total": T}
        """
        user = sum(1 for r in self._rules if r.source == "user")
        project = sum(1 for r in self._rules if r.source == "project")
        built_in = sum(1 for r in self._rules if r.source == "built-in")
        return {
            "user_rules": user,
            "project_rules": project,
            "built_in_rules": built_in,
            "total": len(self._rules),
        }

    def get_rules_list(self) -> list[dict[str, str]]:
        """Return all active rules as serializable dicts.

        Returns a list of dicts with behavior, match type, match pattern,
        and source for each rule. Safe for JSON serialization.
        """
        return [
            {
                "behavior": r.behavior,
                "type": r.match.type,
                "pattern": r.match.pattern,
                "source": r.source,
            }
            for r in self._rules
        ]

    def export_policy(self) -> Tuple[Optional[str], Optional['SafetyError']]:
        """Export all active policy rules as YAML with source annotations.

        Returns (yaml_str, None) on success or (None, SafetyError)
        per MUST-1 contract.

        Returns:
            (yaml_string, None) on success; (None, SafetyError) on failure.
        """
        if not HAVE_YAML:
            from shell.error import SafetyError as _SE
            return (None, _SE(
                layer="L2_policy",
                code="YAML_UNAVAILABLE",
                message="PyYAML is required for policy export",
            ))

        def _rule_to_export_dict(rule: 'PolicyRule') -> dict:
            rd: dict = {
                'behavior': rule.behavior,
                'match': {
                    'type': rule.match.type,
                    'pattern': rule.match.pattern,
                },
            }
            if rule.description:
                rd['description'] = rule.description
            return rd

        try:
            # Group rules by source preserving order
            by_source: Dict[str, list[PolicyRule]] = {}
            for rule in self._rules:
                by_source.setdefault(rule.source, []).append(rule)

            source_order = ["built-in", "user", "project", "session"]
            seen: set[str] = set()

            # Build parallel rule list and source labels
            export_rules: list[dict] = []
            source_labels: list[str] = []

            for src in source_order:
                rules = by_source.get(src)
                if not rules:
                    continue
                seen.add(src)
                for rule in rules:
                    export_rules.append(_rule_to_export_dict(rule))
                    source_labels.append(src)

            # Remaining sources not in source_order
            for src in by_source:
                if src in seen:
                    continue
                seen.add(src)
                for rule in by_source[src]:
                    export_rules.append(_rule_to_export_dict(rule))
                    source_labels.append(src)

            data: dict = {'rules': export_rules}
            raw = yaml.dump(data, default_flow_style=False,
                            allow_unicode=True, sort_keys=False)

            # Insert source comments and header
            from datetime import datetime as _dt
            header = (
                "# Exported from zai.vim shell security policy\n"
                f"# Generated: {_dt.now().isoformat()}\n"
                "# Each rule's source is annotated inline.\n\n"
            )

            lines = raw.split('\n')
            out: list[str] = []
            ri = 0
            for line in lines:
                if line.strip().startswith('- behavior:') and ri < len(source_labels):
                    out.append(f"  # source: {source_labels[ri]}")
                    ri += 1
                out.append(line)

            return (header + '\n'.join(out), None)

        except Exception as e:
            from shell.error import SafetyError as _SE
            msg = str(e)[:60]
            return (None, _SE(
                layer="L2_policy",
                code="EXPORT_FAILED",
                message=f"Policy export failed: {msg}",
            ))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_numeric(s: str) -> bool:
    """Check if string is a valid numeric value."""
    try:
        float(s)
        return True
    except ValueError:
        return False


def _effective_command(cmd_node) -> str:
    """Get the effective command string with safe wrappers stripped.

    When the command is a known safe wrapper (e.g. sudo) and has args,
    find the actual command by skipping wrapper-internal arguments
    (timeout durations, nice values, option flags, path locks, etc.).
    Returns the remaining args joined, so deny patterns like 'rm -rf /'
    can match even when wrapped.

    Nested wrappers are stripped iteratively:
    'sudo timeout 30 rm -rf /' -> 'rm -rf /'
    """
    if cmd_node.command not in SAFE_WRAPPERS or not cmd_node.args:
        return cmd_node.command

    # Find the effective command by scanning args
    cmd_start = 0
    for i, arg in enumerate(cmd_node.args):
        if arg.startswith('-'):
            continue
        try:
            float(arg)
            continue
        except ValueError:
            pass
        cmd_start = i
        break

    result = ' '.join(cmd_node.args[cmd_start:])

    # Iteratively strip safe wrappers from the result.
    # Handles nested wrappers like 'sudo timeout 30 rm -rf /'.
    parts = result.split()
    while parts and parts[0] in SAFE_WRAPPERS:
        parts = parts[1:]
        while parts and (parts[0].startswith('-') or _is_numeric(parts[0])):
            parts = parts[1:]

    return ' '.join(parts) if parts else result


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_engine: Optional[PermissionEngine] = None


def get_permission_engine() -> PermissionEngine:
    """Get or create the singleton PermissionEngine."""
    global _engine
    if _engine is None:
        from appdirs import user_data_dir
        _engine = PermissionEngine(user_data_dir)
    return _engine

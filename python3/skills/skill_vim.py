"""
Python backend for Vim skill commands.

Provides functions called by autoload/zai/skill.vim to query and display
skill registry information.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Ensure skills package is importable
sys.path.insert(0, str(Path(__file__).parent.parent))

from skills.skill_registry import SkillRegistry
from skills.skill_types import SkillStatus


def _get_registry(project_dir: str | None = None) -> SkillRegistry:
    """Create a registry and scan."""
    proj = Path(project_dir) if project_dir else None
    # Check for .skills/ in current directory
    if proj is None:
        cwd_skills = Path.cwd() / ".skills"
        if cwd_skills.is_dir():
            proj = cwd_skills
    reg = SkillRegistry(project_dir=proj)
    reg.scan(incremental=True)
    return reg


def cmd_skill_list(filter_domain: str = "") -> str:
    """Return formatted skill list for Vim display."""
    reg = _get_registry()
    skills = reg.list_all()

    if filter_domain:
        skills = [s for s in skills if str(s.security_domain) == filter_domain]

    if not skills:
        return "No skills installed. Put skills in ~/.local/share/zai/skills/ or .skills/"

    skills.sort(key=lambda s: s.name)

    lines = []
    for s in skills:
        status_mark = ""
        if s.status == SkillStatus.MISSING:
            status_mark = "[missing] "
        elif s.status == SkillStatus.DISABLED:
            status_mark = "[disabled] "
        elif s.status == SkillStatus.SHADOWED:
            status_mark = "[shadowed] "
        elif s.status == SkillStatus.UNAVAILABLE:
            status_mark = "[unavailable] "

        line = f"  {status_mark}{s.name:30s} {str(s.security_domain):12s} {str(s.origin):12s} {str(s.trust_level):4s}"
        lines.append(line)

    header = f"  {'Name':30s} {'Domain':12s} {'Origin':12s} {'Trust'}"
    return header + "\n" + "\n".join(lines)


def cmd_skill_info(name: str) -> str:
    """Return formatted skill details for Vim display."""
    reg = _get_registry()
    meta = reg.get_full(name)

    if meta is None:
        return f"Skill not found: {name}"

    lines = [
        f"  Name:            {meta.name}",
        f"  Description:     {meta.description}",
        f"  Version:         {meta.version}",
        f"  Security Domain: {meta.security_domain}",
        f"  Origin:          {meta.origin}",
        f"  Trust Level:     {meta.trust_level}",
        f"  Status:          {meta.status}",
        f"  Path:            {meta.path or 'N/A'}",
    ]

    if meta.dependencies:
        dep_parts = []
        for k, v in meta.dependencies.items():
            dep_parts.append(f"    {k}: {v}")
        lines.append("  Dependencies:")
        lines.extend(dep_parts)

    if meta.output_schema:
        lines.append(f"  Output Schema:   {meta.output_schema}")

    return "\n".join(lines)


def cmd_skill_enable(name: str) -> str:
    """Enable a skill."""
    reg = _get_registry()
    if not reg.set_status(name, SkillStatus.ENABLED):
        return f"Skill not found: {name}"
    return f"Skill '{name}' enabled."


def cmd_skill_disable(name: str) -> str:
    """Disable a skill."""
    reg = _get_registry()
    if not reg.set_status(name, SkillStatus.DISABLED):
        return f"Skill not found: {name}"
    return f"Skill '{name}' disabled."


def cmd_skill_uninstall(name: str) -> str:
    """Uninstall a skill (with confirmation prompt handled in Vim)."""
    reg = _get_registry()
    meta = reg.get(name)
    if meta is None:
        return f"Skill not found: {name}"
    try:
        reg.unregister(name)
        return f"Skill '{name}' uninstalled."
    except Exception as e:
        return f"Uninstall failed: {e}"


# ---------------------------------------------------------------------------
# CLI entry point for system() calls from Vim
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        print("Usage: skill_vim.py <command> [args...]")
        sys.exit(1)

    cmd = sys.argv[1]
    args = sys.argv[2:]

    if cmd == "list":
        domain = args[0] if args else ""
        print(cmd_skill_list(domain))
    elif cmd == "info":
        if not args:
            print("Usage: skill_vim.py info <name>")
            sys.exit(1)
        print(cmd_skill_info(args[0]))
    elif cmd == "enable":
        if not args:
            print("Usage: skill_vim.py enable <name>")
            sys.exit(1)
        print(cmd_skill_enable(args[0]))
    elif cmd == "disable":
        if not args:
            print("Usage: skill_vim.py disable <name>")
            sys.exit(1)
        print(cmd_skill_disable(args[0]))
    elif cmd == "uninstall":
        if not args:
            print("Usage: skill_vim.py uninstall <name>")
            sys.exit(1)
        print(cmd_skill_uninstall(args[0]))
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()

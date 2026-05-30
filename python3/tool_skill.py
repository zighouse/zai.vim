#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
Skill creation tools — read spec, validate, and deploy skills.

Skill workflow:
  1. AI calls skill_read_spec() to learn the SKILL.md format
  2. AI creates .zaivim/skills/<name>/SKILL.md using write_file
  3. AI calls skill_validate(name) to verify the format
  4. User debugs the skill inside a chat session
  5. User calls skill_deploy(name) or :ZaiSkillDeploy <name> to install globally
"""

import os
import shutil
import sys
from pathlib import Path

from paths import get_project_skills_dir, get_skills_dir


def _get_cwd() -> Path:
    """Return the Vim working directory (where the user is in the project)."""
    return Path(os.getenv("ZAI_VIM_CWD") or os.getcwd())


def _plugin_root() -> Path:
    """Return the zai.vim plugin root directory (parent of python3/)."""
    return Path(__file__).resolve().parent.parent


def _read_spec_doc() -> str:
    """Read docs/skills.md from the plugin root."""
    doc_path = _plugin_root() / "docs" / "skills.md"
    if not doc_path.is_file():
        return "ERROR: docs/skills.md not found in plugin directory."
    return doc_path.read_text(encoding="utf-8")


def _find_project_skill_dir(name: str) -> Path | None:
    """Find a skill directory under the project .zaivim/skills/."""
    proj_dir = get_project_skills_dir(_get_cwd())
    candidate = proj_dir / name
    if candidate.is_dir():
        return candidate
    return None


def invoke_skill_read_spec() -> str:
    """Return the SKILL.md format specification and creation guide.

    Reads docs/skills.md from the plugin root and appends creation-specific
    instructions for the AI.
    """
    try:
        spec = _read_spec_doc()
    except Exception as e:
        return f"Failed to read skill spec: {e}"

    guide = (
        "\n\n---\n\n"
        "## Skill Creation Workflow\n\n"
        "You now have the SKILL.md format specification. To create a skill:\n\n"
        "1. Ask the user what the skill should do, then pick a kebab-case name\n"
        "2. Use write_file to create the skill at `.zaivim/skills/<name>/SKILL.md`\n"
        "3. Call skill_validate(name) to verify the format\n"
        "4. Tell the user they can test the skill and deploy with "
        "skill_deploy(name) or `:ZaiSkillDeploy <name>`\n\n"
        "The skill directory is `.zaivim/skills/<name>/` — it will already be "
        "picked up by the skill system so the user can test it immediately.\n\n"
        "IMPORTANT auth/permission requirements:\n"
        "- For skills in security_domain: personal or public → user confirmation "
        "is required before deploy\n"
        "- skill_deploy will warn if the target already exists and refuse "
        "to overwrite unless force=True\n"
        "- Newly created skills always start at trust_level: L1\n"
    )
    return spec + guide


def invoke_skill_validate(name: str) -> str:
    """Validate a project skill's SKILL.md using the parser.

    Returns a success message or a description of parse errors.
    """
    skill_dir = _find_project_skill_dir(name)
    if skill_dir is None:
        proj_dir = get_project_skills_dir(_get_cwd())
        return (
            f"Skill '{name}' not found under {proj_dir}.\n"
            f"Create .zaivim/skills/{name}/SKILL.md first."
        )

    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        return f"SKILL.md not found at {skill_md}."

    try:
        from skills.skill_parser import parse as parse_skill
        meta = parse_skill(skill_md)
        deps = []
        if meta.dependencies:
            for k, v in meta.dependencies.items():
                deps.append(f"  {k}: {v}")
        dep_lines = "\n".join(deps) if deps else "  (none)"

        return (
            f"Skill '{name}' is valid.\n\n"
            f"  Name:            {meta.name}\n"
            f"  Description:     {meta.description}\n"
            f"  Version:         {meta.version}\n"
            f"  Security Domain: {meta.security_domain}\n"
            f"  Trust Level:     {meta.trust_level}\n"
            f"  Dependencies:    \n{dep_lines}\n"
        )
    except Exception as e:
        return f"Validation FAILED for '{name}': {e}"


def invoke_skill_deploy(name: str, force: bool = False) -> str:
    """Deploy a project skill to the user-level skills directory.

    Copies .zaivim/skills/<name>/ → ~/.zaivim/skills/<name>/.
    Returns HITL confirmation prompt if target already exists and force=False.
    """
    src = _find_project_skill_dir(name)
    if src is None:
        proj_dir = get_project_skills_dir(_get_cwd())
        return (
            f"Skill '{name}' not found under {proj_dir}.\n"
            f"Nothing to deploy."
        )

    skill_md = src / "SKILL.md"
    if not skill_md.is_file():
        return f"SKILL.md not found at {skill_md}. Nothing to deploy."

    # Validate before deploying
    validation = invoke_skill_validate(name)
    if "FAILED" in validation:
        return f"Deploy blocked — validation failed:\n\n{validation}"

    dst = get_skills_dir() / name

    if dst.exists():
        if not force:
            return (
                f"[CONFIRMATION REQUIRED] Target {dst} already exists.\n"
                f"Call skill_deploy(name='{name}', force=True) to overwrite, "
                f"or use :ZaiSkillDeploy! {name} in Vim."
            )
        # Force overwrite
        try:
            shutil.rmtree(dst)
        except OSError as e:
            return f"Failed to remove existing skill at {dst}: {e}"

    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dst)
    except OSError as e:
        return f"Deploy failed: {e}"

    # Refresh registry so the new skill is picked up
    try:
        from skills.skill_registry import SkillRegistry
        reg = SkillRegistry()
        reg.scan(incremental=True)
    except Exception:
        pass  # non-fatal; user can rescan manually

    return (
        f"Skill '{name}' deployed successfully.\n"
        f"  From: {src}\n"
        f"  To:   {dst}\n"
        f"Use :ZaiSkillList to verify."
    )

"""
SKILL.md parser — extracts metadata from YAML frontmatter + Markdown body.

Text-as-Protocol: skills are defined by SKILL.md files, AI auto-extracts
structured contracts from frontmatter and uses body as capability description.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

from .skill_types import (
    SecurityDomain,
    SkillMetadata,
    SkillOrigin,
    SkillParseError,
    TrustLevel,
)

_REQUIRED_FIELDS = ("name", "description")
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_KEBAB_RE = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")


def parse(skill_md_path: str | Path) -> SkillMetadata:
    """Parse a SKILL.md file and return full SkillMetadata.

    Raises SkillParseError on invalid frontmatter or missing required fields.
    """
    path = Path(skill_md_path)
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as e:
        raise SkillParseError(f"Cannot read {path}: {e}") from e

    frontmatter, body = _split_frontmatter(content, str(path))

    try:
        raw = yaml.safe_load(frontmatter) or {}
    except yaml.YAMLError as e:
        raise SkillParseError(f"YAML parse error in {path}: {e}") from e

    if not isinstance(raw, dict):
        raise SkillParseError(
            f"Invalid frontmatter in {path}: expected mapping, got {type(raw).__name__}"
        )

    _validate_required(raw, str(path))
    _validate_name(raw["name"], str(path))
    _validate_field_types(raw, str(path))

    security_domain = _parse_enum(
        raw, "security_domain", SecurityDomain, SecurityDomain.WORKSPACE
    )
    origin = _parse_enum(raw, "origin", SkillOrigin, SkillOrigin.NATIVE)
    trust_level = _parse_enum(raw, "trust_level", TrustLevel, TrustLevel.L1)

    return SkillMetadata(
        name=raw["name"],
        description=raw["description"],
        security_domain=security_domain,
        origin=origin,
        version=raw.get("version", "0.1.0"),
        dependencies=raw.get("dependencies", {}),
        trust_level=trust_level,
        output_schema=raw.get("output_schema", ""),
        path=str(path),
        when_to_use=raw.get("when_to_use", ""),
        paths=raw.get("paths", []),
        disable_model_invocation=raw.get("disable_model_invocation", False),
        user_invocable=raw.get("user_invocable", True),
        localized_descriptions=raw.get("localized_descriptions", {}),
        tags=raw.get("tags", []),
    )


def parse_index_only(skill_md_path: str | Path) -> dict:
    """Parse only frontmatter for lightweight index.

    Returns a dict with: name, description, security_domain, origin,
    path, version, trust_level. Does NOT load the Markdown body.
    """
    path = Path(skill_md_path)
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as e:
        raise SkillParseError(f"Cannot read {path}: {e}") from e

    frontmatter, _ = _split_frontmatter(content, str(path))

    try:
        raw = yaml.safe_load(frontmatter) or {}
    except yaml.YAMLError as e:
        raise SkillParseError(f"YAML parse error in {path}: {e}") from e

    if not isinstance(raw, dict):
        raise SkillParseError(
            f"Invalid frontmatter in {path}: expected mapping, got {type(raw).__name__}"
        )

    _validate_required(raw, str(path))
    _validate_name(raw["name"], str(path))

    return {
        "name": raw["name"],
        "description": raw["description"],
        "security_domain": str(
            _parse_enum(raw, "security_domain", SecurityDomain, SecurityDomain.WORKSPACE)
        ),
        "origin": str(_parse_enum(raw, "origin", SkillOrigin, SkillOrigin.NATIVE)),
        "path": str(path),
        "version": raw.get("version", "0.1.0"),
        "trust_level": str(
            _parse_enum(raw, "trust_level", TrustLevel, TrustLevel.L1)
        ),
        "when_to_use": raw.get("when_to_use", ""),
        "paths": raw.get("paths", []),
        "disable_model_invocation": raw.get("disable_model_invocation", False),
        "user_invocable": raw.get("user_invocable", True),
        "tags": raw.get("tags", []),
    }


def serialize(skill_md_path: str | Path, updates: dict) -> None:
    """Merge *updates* into a SKILL.md's frontmatter and write back.

    Reads the file, parses frontmatter, merges the updates dict, and
    rewrites the complete file (frontmatter + body).  Checks mtime
    before writing to avoid clobbering concurrent edits.

    Args:
        skill_md_path: Path to the SKILL.md file.
        updates: Dict of frontmatter fields to add or overwrite.
    """
    path = Path(skill_md_path)
    content = path.read_text(encoding="utf-8")
    stat_before = path.stat().st_mtime

    frontmatter, body = _split_frontmatter(content, str(path))
    raw = yaml.safe_load(frontmatter) or {}
    if not isinstance(raw, dict):
        return

    # Merge updates (skip None values)
    for k, v in updates.items():
        if v is not None:
            raw[k] = v

    new_fm = yaml.dump(raw, allow_unicode=True, default_flow_style=False,
                       sort_keys=False).rstrip("\n")
    new_content = f"---\n{new_fm}\n---\n{body}"

    # Atomic-ish: check mtime hasn't changed
    if path.stat().st_mtime != stat_before:
        logger.warning("Skipping write to %s — file changed during processing", path)
        return

    path.write_text(new_content, encoding="utf-8")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _split_frontmatter(content: str, filename: str) -> tuple[str, str]:
    """Split SKILL.md into (frontmatter_str, body_str)."""
    match = _FRONTMATTER_RE.match(content)
    if not match:
        raise SkillParseError(
            f"No YAML frontmatter found in {filename}. "
            f"SKILL.md must start with '---' delimiters."
        )
    return match.group(1), content[match.end():]


def _validate_required(raw: dict, filename: str) -> None:
    """Check that all required fields are present."""
    missing = [f for f in _REQUIRED_FIELDS if f not in raw]
    if missing:
        fields = ", ".join(f"Missing required field: {m}" for m in missing)
        raise SkillParseError(f"{fields} in {filename}")


def _parse_enum(raw: dict, key: str, enum_cls: type, default):
    """Parse an enum field. Raises SkillParseError on invalid value."""
    value = raw.get(key)
    if value is None:
        return default
    try:
        return enum_cls(value)
    except ValueError:
        valid = ", ".join(e.value for e in enum_cls)
        raise SkillParseError(
            f"Invalid '{key}' value '{value}' in {raw.get('_filename', '')}. "
            f"Valid values: {valid}"
        )


def _validate_name(name: str, filename: str) -> None:
    """Enforce kebab-case skill names (MUST Rule #2)."""
    if not _KEBAB_RE.match(name):
        raise SkillParseError(
            f"Invalid skill name '{name}' in {filename}. "
            f"Name must be kebab-case (lowercase letters, digits, hyphens)."
        )


def _validate_field_types(raw: dict, filename: str) -> None:
    """Validate field types in frontmatter."""
    if not isinstance(raw["name"], str):
        raise SkillParseError(f"Field 'name' must be a string in {filename}")
    if not isinstance(raw["description"], str):
        raise SkillParseError(f"Field 'description' must be a string in {filename}")
    if "version" in raw and not isinstance(raw["version"], str):
        raise SkillParseError(f"Field 'version' must be a string in {filename}")
    if "dependencies" in raw and not isinstance(raw["dependencies"], dict):
        raise SkillParseError(f"Field 'dependencies' must be a mapping in {filename}")
    if "when_to_use" in raw and not isinstance(raw["when_to_use"], str):
        raise SkillParseError(f"Field 'when_to_use' must be a string in {filename}")
    if "paths" in raw and not isinstance(raw["paths"], list):
        raise SkillParseError(f"Field 'paths' must be a list in {filename}")
    if "disable_model_invocation" in raw and not isinstance(raw["disable_model_invocation"], bool):
        raise SkillParseError(f"Field 'disable_model_invocation' must be a boolean in {filename}")
    if "user_invocable" in raw and not isinstance(raw["user_invocable"], bool):
        raise SkillParseError(f"Field 'user_invocable' must be a boolean in {filename}")
    if "tags" in raw and not isinstance(raw["tags"], list):
        raise SkillParseError(f"Field 'tags' must be a list in {filename}")

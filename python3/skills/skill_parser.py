"""
SKILL.md parser — extracts metadata from YAML frontmatter + Markdown body.

Text-as-Protocol: skills are defined by SKILL.md files, AI auto-extracts
structured contracts from frontmatter and uses body as capability description.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)

from .skill_types import (
    SecurityDomain,
    SkillMetadata,
    SkillOrigin,
    SkillParseError,
    TrustLevel,
)

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_KEBAB_RE = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")
_HYPHEN_RE = re.compile(r"[a-z0-9]-[a-z0-9]")

# Fields that belong to SkillMetadata (underscore form after normalization).
_KNOWN_FIELDS = frozenset({
    "name", "description", "security_domain", "origin", "version",
    "dependencies", "trust_level", "output_schema", "path", "status",
    "when_to_use", "paths", "disable_model_invocation", "user_invocable",
    "localized_descriptions", "tags",
    "arguments", "argument_hint", "allowed_tools", "disallowed_tools",
    "context", "agent", "model", "effort", "hooks", "shell",
})

# Fields that accept a space-separated string OR a YAML list.
_LIST_FIELDS = frozenset({
    "arguments", "allowed_tools", "disallowed_tools", "paths", "tags",
})


def parse(skill_md_path: str | Path) -> SkillMetadata:
    """Parse a SKILL.md file and return full SkillMetadata.

    Raises SkillParseError on invalid frontmatter.
    Name and description are optional — inferred from path/body if missing.
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

    raw = _normalize_keys(raw)
    _infer_missing(raw, path, body)
    _validate_name(raw["name"], str(path))
    _validate_field_types(raw, str(path))

    return _build_metadata(raw, path)


def parse_index_only(skill_md_path: str | Path) -> dict:
    """Parse only frontmatter for lightweight index.

    Returns a dict with key metadata fields. Does NOT load the Markdown body
    for description inference (uses frontmatter only).
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

    raw = _normalize_keys(raw)
    # For index-only, infer name from path but skip body-based description
    if "name" not in raw or not raw["name"]:
        raw["name"] = path.parent.name
    if "description" not in raw:
        raw["description"] = ""

    return {
        "name": raw["name"],
        "description": raw.get("description", ""),
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
        "paths": _ensure_list(raw.get("paths")),
        "disable_model_invocation": raw.get("disable_model_invocation", False),
        "user_invocable": raw.get("user_invocable", True),
        "tags": _ensure_list(raw.get("tags")),
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

def _normalize_keys(raw: dict) -> dict:
    """Map hyphenated CC keys to underscore form (e.g. allowed-tools → allowed_tools).

    Hyphenated keys are replaced by their underscore form so they don't
    leak into extra. The hyphenated original is only kept if there is
    already an underscore key with the same name (user explicitly has both).
    """
    result = {}
    for key, value in raw.items():
        if isinstance(key, str) and _HYPHEN_RE.search(key):
            normalized = key.replace("-", "_")
            result[normalized] = value
            # Only keep the hyphenated original if underscore form
            # is already set separately in raw (rare: user writes both)
            if normalized in raw:
                result[key] = value
        else:
            result[key] = value
    return result


def _infer_missing(raw: dict, path: Path, body: str) -> None:
    """Fill in missing name/description from path and body."""
    if "name" not in raw or not raw["name"]:
        raw["name"] = path.parent.name
    if "description" not in raw or not raw["description"]:
        raw["description"] = _extract_first_paragraph(body)


def _extract_first_paragraph(body: str) -> str:
    """Extract the first non-empty paragraph from Markdown body."""
    lines = body.strip().splitlines()
    paragraphs: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            if paragraphs:
                break
            continue
        if stripped.startswith("#"):
            continue
        paragraphs.append(stripped)
    return " ".join(paragraphs)[:512] if paragraphs else ""


def _ensure_list(value) -> list:
    """Convert a space/comma-separated string or YAML list to a Python list."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        if "," in value:
            return [v.strip() for v in value.split(",") if v.strip()]
        return value.split()
    return [value]


def _build_metadata(raw: dict, path: Path) -> SkillMetadata:
    """Construct SkillMetadata from normalized raw dict."""
    security_domain = _parse_enum(
        raw, "security_domain", SecurityDomain, SecurityDomain.WORKSPACE
    )
    origin = _parse_enum(raw, "origin", SkillOrigin, SkillOrigin.NATIVE)
    trust_level = _parse_enum(raw, "trust_level", TrustLevel, TrustLevel.L1)

    extra = {k: v for k, v in raw.items()
             if k not in _KNOWN_FIELDS and k != "path"}

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
        paths=_ensure_list(raw.get("paths")),
        disable_model_invocation=raw.get("disable_model_invocation", False),
        user_invocable=raw.get("user_invocable", True),
        localized_descriptions=raw.get("localized_descriptions", {}),
        tags=_ensure_list(raw.get("tags")),
        arguments=_ensure_list(raw.get("arguments")),
        argument_hint=str(raw.get("argument_hint", "")),
        allowed_tools=_ensure_list(raw.get("allowed_tools")),
        disallowed_tools=_ensure_list(raw.get("disallowed_tools")),
        context=str(raw.get("context", "")),
        agent=str(raw.get("agent", "")),
        model=str(raw.get("model", "")),
        effort=str(raw.get("effort", "")),
        hooks=raw.get("hooks", {}),
        shell=str(raw.get("shell", "")),
        extra=extra,
    )


def _split_frontmatter(content: str, filename: str) -> tuple[str, str]:
    """Split SKILL.md into (frontmatter_str, body_str)."""
    match = _FRONTMATTER_RE.match(content)
    if not match:
        raise SkillParseError(
            f"No YAML frontmatter found in {filename}. "
            f"SKILL.md must start with '---' delimiters."
        )
    return match.group(1), content[match.end():]


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
    if "name" in raw and raw["name"] and not isinstance(raw["name"], str):
        raise SkillParseError(f"Field 'name' must be a string in {filename}")
    if "description" in raw and raw["description"] and not isinstance(raw["description"], str):
        raise SkillParseError(f"Field 'description' must be a string in {filename}")
    if "version" in raw and not isinstance(raw["version"], str):
        raise SkillParseError(f"Field 'version' must be a string in {filename}")
    if "dependencies" in raw and not isinstance(raw["dependencies"], dict):
        raise SkillParseError(f"Field 'dependencies' must be a mapping in {filename}")
    if "when_to_use" in raw and not isinstance(raw["when_to_use"], str):
        raise SkillParseError(f"Field 'when_to_use' must be a string in {filename}")
    if "disable_model_invocation" in raw and not isinstance(raw["disable_model_invocation"], bool):
        raise SkillParseError(f"Field 'disable_model_invocation' must be a boolean in {filename}")
    if "user_invocable" in raw and not isinstance(raw["user_invocable"], bool):
        raise SkillParseError(f"Field 'user_invocable' must be a boolean in {filename}")

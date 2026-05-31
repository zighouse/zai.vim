"""
Async LLM-based skill enhancement — translate descriptions, extract when_to_use,
and classify tags when the user's primary language is missing from localized_descriptions.

Uses the ClassifierClient pattern: daemon thread + agent._parent_llm_getter.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Callable, Optional

logger = logging.getLogger(__name__)

# In-memory set: skills already attempted in this session (prevent re-trigger)
_enhanced_skills: set[str] = set()
_enhanced_lock = threading.Lock()

# Module-level LLM accessor — set once during init
_llm_getter: Optional[Callable] = None
_config_getter: Optional[Callable] = None


def init(llm_getter: Callable, config_getter: Callable) -> None:
    """Initialize with LLM client getter and config getter from AIChat."""
    global _llm_getter, _config_getter
    _llm_getter = llm_getter
    _config_getter = config_getter


def enhance_if_needed(skill_name: str, skill_path: str | None) -> None:
    """Check if a skill needs enhancement for the user's primary language.

    If the localized_descriptions is missing the user's language (or
    when_to_use/tags are empty), trigger an async LLM enhancement in a
    daemon thread.  Returns immediately — does not block.
    """
    if not skill_path:
        return

    with _enhanced_lock:
        if skill_name in _enhanced_skills:
            return
        _enhanced_skills.add(skill_name)

    # Check if enhancement is actually needed
    try:
        from .skill_parser import parse
        from .skill_lang import user_primary_lang

        meta = parse(skill_path)
        primary = user_primary_lang()

        needs_translate = primary not in (meta.localized_descriptions or {})
        needs_when = not meta.when_to_use
        needs_tags = not meta.tags

        if not needs_translate and not needs_when and not needs_tags:
            return
    except Exception:
        return

    # Spawn daemon thread for async enhancement
    thread = threading.Thread(
        target=_do_enhance,
        args=(skill_name, skill_path),
        daemon=True,
    )
    thread.start()


def _do_enhance(skill_name: str, skill_path: str) -> None:
    """Daemon thread target — call LLM and write back results."""
    try:
        from .skill_parser import parse
        from .skill_lang import user_primary_lang

        llm = _llm_getter() if _llm_getter else None
        if llm is None:
            logger.debug("Skill enhancer: LLM not available, skipping %s", skill_name)
            return

        config = _config_getter() if _config_getter else {}
        model_name = _resolve_model(config)
        if not model_name:
            return

        meta = parse(skill_path)
        primary = user_primary_lang()
        body = _read_body(skill_path)

        updates: dict = {}

        # 1. Translate description if missing
        if primary not in (meta.localized_descriptions or {}):
            translated = _translate_description(
                llm, model_name, meta.description, primary
            )
            if translated:
                loc = dict(meta.localized_descriptions or {})
                loc[primary] = translated
                updates["localized_descriptions"] = loc

        # 2. Extract when_to_use if missing
        if not meta.when_to_use and body:
            when = _extract_when_to_use(llm, model_name, meta.description, body)
            if when:
                updates["when_to_use"] = when

        # 3. Classify tags if missing
        if not meta.tags and body:
            tags = _classify_tags(llm, model_name, meta.description, body)
            if tags:
                updates["tags"] = tags

        if updates:
            from .skill_parser import serialize
            serialize(skill_path, updates)
            logger.info("Skill '%s' enhanced: %s", skill_name,
                        list(updates.keys()))

    except Exception as e:
        logger.warning("Skill enhancement failed for '%s': %s", skill_name, e)


# ---------------------------------------------------------------------------
# LLM prompt builders
# ---------------------------------------------------------------------------

def _translate_description(
    llm, model_name: str, description: str, target_lang: str
) -> str:
    """Translate a skill description to the target language."""
    lang_names = {
        "zh": "Chinese", "ja": "Japanese", "ko": "Korean",
        "ar": "Arabic", "ru": "Russian", "hi": "Hindi",
        "th": "Thai", "en": "English",
    }
    lang_label = lang_names.get(target_lang, target_lang)
    prompt = (
        f"Translate the following skill description to {lang_label}. "
        f"Return ONLY the translated text, nothing else.\n\n"
        f"{description}"
    )
    return _quick_call(llm, model_name, prompt)


def _extract_when_to_use(
    llm, model_name: str, description: str, body: str
) -> str:
    """Extract a brief when_to_use hint from the skill body."""
    snippet = body[:2000] if len(body) > 2000 else body
    prompt = (
        "Based on this skill description and body, write a brief 'when to use' "
        "hint (one sentence, max 80 chars). Return ONLY the hint text.\n\n"
        f"Description: {description}\n\n"
        f"Body:\n{snippet}"
    )
    return _quick_call(llm, model_name, prompt)


def _classify_tags(
    llm, model_name: str, description: str, body: str
) -> list[str]:
    """Extract category tags from skill content."""
    snippet = body[:2000] if len(body) > 2000 else body
    prompt = (
        "Based on this skill, return 2-5 short category tags as a JSON array "
        "of strings. Example: [\"translation\", \"text\", \"localization\"]\n\n"
        f"Description: {description}\n\n"
        f"Body:\n{snippet}"
    )
    raw = _quick_call(llm, model_name, prompt)
    if not raw:
        return []
    try:
        # Extract JSON array from response
        start = raw.find("[")
        end = raw.rfind("]")
        if start >= 0 and end > start:
            tags = json.loads(raw[start:end + 1])
            if isinstance(tags, list):
                return [str(t) for t in tags if isinstance(t, (str, int))][:5]
    except (json.JSONDecodeError, ValueError):
        pass
    return []


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _quick_call(llm, model_name: str, prompt: str) -> str:
    """Single-turn LLM call, returns content string or empty on failure."""
    try:
        response = llm.chat.completions.create(
            model=model_name,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=256,
            temperature=0,
            stream=False,
            timeout=30,
        )
        content = response.choices[0].message.content or ""
        return content.strip()
    except Exception as e:
        logger.debug("Quick LLM call failed: %s", e)
        return ""


def _resolve_model(config: dict) -> str:
    """Resolve which model to use for enhancement.

    Prefers classifier model (cheapest), then current model as fallback.
    """
    # 1. Check for classifier model
    models = config.get("provider", {}).get("model", [])
    if isinstance(models, list):
        for m in models:
            if isinstance(m, dict) and m.get("shell_classifier"):
                return m.get("api_name") or m.get("name", "")

    # 2. Fallback to current model
    model = config.get("model", {})
    if isinstance(model, dict):
        return model.get("api_name") or model.get("name", "")

    return ""


def _read_body(skill_path: str) -> str:
    """Read the Markdown body (after frontmatter) from a SKILL.md."""
    try:
        content = open(skill_path, encoding="utf-8").read()
        from .skill_parser import _FRONTMATTER_RE
        match = _FRONTMATTER_RE.match(content)
        if match:
            return content[match.end():]
        return content
    except Exception:
        return ""

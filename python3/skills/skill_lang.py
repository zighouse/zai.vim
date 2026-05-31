"""
User language detection and frequency tracking for skill enhancement.

Zero-dependency Unicode block analysis covers: zh, ja, ko, ar, ru, hi, th,
and Latin-family languages.  Frequency stats persisted to ~/.zaivim/lang-stats.json.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Language detection via Unicode block analysis
# ---------------------------------------------------------------------------

# (block_name, compiled regex) — pre-compiled for hot-path performance
_COMPILED_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("cjk",        re.compile(r"[一-鿿㐀-䶿]")),
    ("hiragana",   re.compile(r"[぀-ゟ]")),
    ("katakana",   re.compile(r"[゠-ヿ]")),
    ("hangul",     re.compile(r"[가-힯ᄀ-ᇿ]")),
    ("arabic",     re.compile(r"[؀-ۿݐ-ݿ]")),
    ("cyrillic",   re.compile(r"[Ѐ-ӿԀ-ԯ]")),
    ("devanagari", re.compile(r"[ऀ-ॿ]")),
    ("thai",       re.compile(r"[฀-๿]")),
    ("latin_ext",  re.compile(r"[À-ɏ]")),
]

_BLOCK_TO_LANG: dict[str, str] = {
    "cjk": "zh",
    "hiragana": "ja",
    "katakana": "ja",
    "hangul": "ko",
    "arabic": "ar",
    "cyrillic": "ru",
    "devanagari": "hi",
    "thai": "th",
    "latin_ext": "en",
}

_ASCII_WORD_RE = re.compile(r"[a-zA-Z]+")


def detect_lang(text: str) -> str:
    """Detect the dominant language of *text* via Unicode block analysis.

    Returns a 2-letter code: zh, ja, ko, ar, ru, hi, th, en, or "unknown".
    """
    if not text or not text.strip():
        return "unknown"

    counts: dict[str, int] = {}
    for name, pattern in _COMPILED_PATTERNS:
        counts[name] = len(pattern.findall(text))

    ascii_words = len(_ASCII_WORD_RE.findall(text))

    total_unicode = sum(counts.values())
    if total_unicode == 0 and ascii_words == 0:
        return "unknown"
    if total_unicode == 0:
        return "en"

    dominant = max(counts, key=counts.get)  # type: ignore[arg-type]
    if counts[dominant] == 0:
        return "en"

    return _BLOCK_TO_LANG.get(dominant, "other")


# ---------------------------------------------------------------------------
# Frequency-based language stats with persistent storage
# ---------------------------------------------------------------------------

_DEFAULT_LANG = "en"


def _stats_path() -> Path:
    """Return the path to the persistent language stats file."""
    from paths import get_user_dir
    return get_user_dir() / "lang-stats.json"


def load_stats() -> dict[str, int]:
    """Load language frequency stats from disk. Returns empty dict on failure."""
    path = _stats_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {k: v for k, v in data.items() if isinstance(v, int)}
    except Exception:
        pass
    return {}


def save_stats(stats: dict[str, int]) -> None:
    """Persist language frequency stats to disk."""
    path = _stats_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(stats, ensure_ascii=False, indent=2),
                        encoding="utf-8")
    except Exception as e:
        logger.warning("Failed to save lang stats: %s", e)


def record_lang(text: str) -> str | None:
    """Detect language of *text*, update frequency stats, return detected lang.

    Returns None if detection yields "unknown" or "other".
    """
    lang = detect_lang(text)
    if lang in ("unknown", "other"):
        return None

    stats = load_stats()
    stats[lang] = stats.get(lang, 0) + 1
    save_stats(stats)
    return lang


def user_primary_lang() -> str:
    """Return the user's most frequently used language.

    Falls back to LANG/LANGUAGE env vars, then "en".
    """
    stats = load_stats()
    if stats:
        return max(stats, key=stats.get)  # type: ignore[arg-type]

    lang_env = os.getenv("LANG", "") + os.getenv("LANGUAGE", "")
    for code in ("zh", "ja", "ko", "ar", "ru", "hi", "th"):
        if code in lang_env:
            return code

    return _DEFAULT_LANG

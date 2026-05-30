#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
Skill matcher — local BM25 ranking for skill auto-discovery.

Pluggable architecture: BM25SkillMatcher (Phase 1), MiniLMSkillMatcher (Phase 2),
LLMSkillMatcher (fallback).  All implement the SkillMatcher interface.
"""

from __future__ import annotations

import math
import re
from abc import ABC, abstractmethod
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# Interface
# ---------------------------------------------------------------------------

class SkillMatcher(ABC):
    """Pluggable skill matcher interface."""

    @abstractmethod
    def rank(self, query: str, top_k: int = 5) -> list[str]:
        """Return skill names ranked by relevance to query."""


# ---------------------------------------------------------------------------
# BM25 implementation — zero-dependency, sub-millisecond for 1000+ skills
# ---------------------------------------------------------------------------

@dataclass
class _SkillDoc:
    name: str
    text: str  # description + when_to_use (localized if available)


class BM25SkillMatcher(SkillMatcher):
    """BM25 ranking with mixed Chinese/English tokenizer.

    Install-time LLM translation can populate localized_descriptions for
    cross-language matching.  Without it, BM25 works best when the user
    prompt and skill descriptions share a language.
    """

    def __init__(self, k1: float = 1.5, b: float = 0.75):
        self._k1 = k1
        self._b = b
        self._skills: list[_SkillDoc] = []
        self._inverted_index: dict[str, list[tuple[int, int]]] = defaultdict(list)
        self._doc_lengths: list[int] = []
        self._avgdl: float = 0.0
        self._N: int = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def index_skills(self, skills: list[dict[str, Any]],
                     lang: str | None = None) -> None:
        """Build/replace the skill index.

        Args:
            skills: list of dicts with keys: name, description, when_to_use,
                    localized_descriptions (optional).
            lang: preferred language code for localized descriptions.
        """
        self._inverted_index.clear()
        self._skills = []

        for s in skills:
            desc = s.get("description", "")
            when = s.get("when_to_use", "")
            # Prefer localized description for the user's language
            localized = s.get("localized_descriptions", {})
            if lang and lang in localized:
                desc = localized[lang]
            text = f"{desc} {when}".strip()
            self._skills.append(_SkillDoc(name=s["name"], text=text))

        self._doc_lengths = []
        for doc_id, sk in enumerate(self._skills):
            tokens = self._tokenize(sk.text)
            self._doc_lengths.append(len(tokens))
            # Build inverted index with term frequencies
            tf = defaultdict(int)
            for t in tokens:
                tf[t] += 1
            for t, freq in tf.items():
                self._inverted_index[t].append((doc_id, freq))

        self._N = len(self._skills)
        self._avgdl = (
            sum(self._doc_lengths) / max(self._N, 1)
            if self._N else 0.0
        )

    def rank(self, query: str, top_k: int = 5) -> list[str]:
        """Return top-k skill names for the given query."""
        if self._N == 0 or not query.strip():
            return [s.name for s in self._skills[:top_k]]

        q_tokens = self._tokenize(query)
        if not q_tokens:
            return []

        scores: list[tuple[str, float]] = []
        for doc_id in range(self._N):
            dl = self._doc_lengths[doc_id]
            if dl == 0:
                scores.append((self._skills[doc_id].name, 0.0))
                continue
            score = 0.0
            for t in set(q_tokens):
                postings = self._inverted_index.get(t, [])
                # Find this doc's term frequency in postings
                tf = 0
                df = 0  # document frequency
                for doc, freq in postings:
                    if doc == doc_id:
                        tf = freq
                    else:
                        df += 1
                if tf == 0:
                    continue
                # BM25 IDF
                idf = math.log(
                    (self._N - df + 0.5) / (df + 0.5) + 1.0
                )
                # BM25 score contribution
                numerator = tf * (self._k1 + 1.0)
                denominator = tf + self._k1 * (
                    1.0 - self._b + self._b * dl / self._avgdl
                )
                score += idf * numerator / denominator
            scores.append((self._skills[doc_id].name, score))

        scores.sort(key=lambda x: -x[1])
        return [name for name, _ in scores[:top_k]]

    # ------------------------------------------------------------------
    # Tokenizer — mixed Chinese bigram + English word + digit
    # ------------------------------------------------------------------

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        """Tokenize mixed English/Chinese text.

        English: split on word boundaries (lowercased).
        Chinese: character bigrams (fast, no dictionary needed).
        Digits/underscores: treated as word characters.
        """
        tokens: list[str] = []

        # Extract English/alphanumeric words
        alpha_pattern = re.compile(r'[a-zA-Z0-9_]+')
        matches = list(alpha_pattern.finditer(text))
        last_end = 0
        for m in matches:
            # Take Chinese text before this match
            chinese_chunk = text[last_end:m.start()]
            tokens.extend(_bigram(chinese_chunk))
            tokens.append(m.group().lower())
            last_end = m.end()
        # Remaining Chinese after last match
        chinese_chunk = text[last_end:]
        tokens.extend(_bigram(chinese_chunk))

        return [t for t in tokens if t.strip()]


def _bigram(text: str) -> list[str]:
    """Generate Chinese character bigrams from text."""
    # Strip ASCII-ish characters so only CJK remains
    chars = re.sub(r'[\x00-\x7f\s]+', '', text)
    if len(chars) < 2:
        return list(chars)
    return [chars[i:i + 2] for i in range(len(chars) - 1)]


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def create_matcher(strategy: str = "bm25") -> SkillMatcher:
    """Create a skill matcher by strategy name.

    Args:
        strategy: "bm25" (default), "minilm" (future), "llm" (future).

    Returns:
        A SkillMatcher instance.
    """
    if strategy == "bm25":
        return BM25SkillMatcher()
    raise ValueError(f"Unknown skill matcher strategy: {strategy}")

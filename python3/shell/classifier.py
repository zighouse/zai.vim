#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""AI-powered shell command safety classifier.

Provides ClassifierClient for async LLM-based safety classification of shell
commands and ClassificationResult for structured classification outcomes.

THREAD_SAFE: SINGLE_WRITER — _session_cache is the only mutable shared state;
ClassificationResult is frozen (immutable). Cache writes only occur in the
classify_async call path under Python's GIL.

Integration: Used by the safety chain (L1_classifier) in tool_shell.py to
augment the L2_policy decision with an AI-generated safety score and reasoning.
"""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple

from agent import _parent_config, _parent_llm_getter
from .error import SafetyError

# ---------------------------------------------------------------------------
# ClassificationResult
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ClassificationResult:
    """Immutable result from a shell command safety classification.

    THREAD_SAFE: READ_ONLY — all fields are immutable after construction.
    """

    score: float                    # 0.0 (dangerous) to 1.0 (safe)
    decision: str                   # "allow" | "deny" | "ask"
    reason: str                     # human-readable explanation
    effective_classifier: str       # "llm" | "cache" | "disabled"
    degraded: bool = False
    degraded_reason: str = ""

    def __post_init__(self) -> None:
        if not (0.0 <= self.score <= 1.0):
            raise ValueError(f"score must be 0.0-1.0, got {self.score}")
        if self.decision not in ("allow", "deny", "ask"):
            raise ValueError(
                f"decision must be 'allow', 'deny', or 'ask', got {self.decision!r}"
            )
        if self.effective_classifier not in ("llm", "cache", "disabled"):
            raise ValueError(
                f"effective_classifier must be 'llm', 'cache', or 'disabled', "
                f"got {self.effective_classifier!r}"
            )


# ---------------------------------------------------------------------------
# ClassifierClient
# ---------------------------------------------------------------------------


class ClassifierClient:
    """AI-powered shell command safety classifier.

    Public API — all methods are @classmethod (A3) enabling mock subclassing.

    Usage:
        if ClassifierClient.available():
            ClassifierClient.classify_async(command, parsed, session_id, callback)
    """

    # Session-scoped cache: {session_id: {cache_key: ClassificationResult}}
    _session_cache: dict[str, dict[str, ClassificationResult]] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @classmethod
    def available(cls) -> bool:
        """Check if the classifier is available and ready.

        Always available when the parent LLM client is reachable —
        the classifier follows the active provider and resolves its model
        from the current model or provider model list.

        Returns False only when _parent_config or _parent_llm_getter
        is unavailable (e.g., before AIChat initialization).
        """
        if not _parent_config:
            return False
        if not _parent_llm_getter:
            return False
        llm = _parent_llm_getter()
        if llm is None:
            return False
        return True

    @classmethod
    def model_name(cls) -> str:
        """Return the resolved classifier model name, or 'unknown'.

        Resolution order:
          1. Current model if it has shell_classifier: true
          2. First provider model with shell_classifier: true
          3. Current model (fallback — always available)
        """
        resolved = cls._resolve_classifier_model()
        if resolved:
            return resolved.get("name", "unknown")
        return "unknown"

    @classmethod
    def _resolve_classifier_model(cls) -> dict | None:
        """Resolve which model to use for shell command classification.

        Resolution order:
          1. If the currently active model has ``shell_classifier: true``, use it.
          2. Otherwise, scan the provider's model list for the first model
             with ``shell_classifier: true``.
          3. If no model is explicitly marked, fall back to the currently
             active model — the classifier is never disabled just because
             no model is marked.

        Returns a model dict (with at least ``name``), or None if no config
        is available.
        """
        if not _parent_config:
            return None

        current_model = _parent_config.get("model")
        provider = _parent_config.get("provider", {})

        # 1. Current model explicitly marked as classifier
        if isinstance(current_model, dict) and current_model.get("shell_classifier"):
            return current_model

        # 2. Scan provider's model list for first marked model
        provider_models = provider.get("model", [])
        if isinstance(provider_models, list):
            for m in provider_models:
                if isinstance(m, dict) and m.get("shell_classifier"):
                    return m

        # 3. Fallback: use current model (may be a dict or just a name string)
        if isinstance(current_model, dict) and current_model.get("name"):
            return current_model

        return None

    @classmethod
    def classify_async(
        cls,
        command: str,
        parsed: Any,
        session_id: str,
        callback: Callable[[ClassificationResult], None],
    ) -> None:
        """Classify a shell command asynchronously via LLM (AC #3).

        Spawns a daemon thread that calls the LLM classifier and invokes
        *callback* with the ClassificationResult. On cache hit, the callback
        is invoked synchronously from the calling thread.

        Args:
            command: The raw shell command string.
            parsed: CommandSemantics from bash_parser.BashParser.parse().
            session_id: The Vim session identifier for cache isolation.
            callback: Called with ClassificationResult on completion.
        """
        # Cache check
        cache_key = cls._cache_key(command, parsed)
        if session_id in cls._session_cache:
            cached = cls._session_cache[session_id].get(cache_key)
            if cached is not None:
                result = ClassificationResult(
                    score=cached.score,
                    decision=cached.decision,
                    reason=cached.reason,
                    effective_classifier="cache",
                    degraded=True,
                    degraded_reason="cache hit, no LLM call",
                )
                callback(result)
                return

        # Spawn daemon thread for async LLM classification
        thread = threading.Thread(
            target=cls._do_classify,
            args=(command, parsed, cache_key, session_id, callback),
            daemon=True,
        )
        thread.start()

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @classmethod
    def _cache_key(cls, command: str, parsed: Any) -> str:
        """Generate a cache key for a command (AC #6).

        Uses repr(parsed) because CommandSemantics is a plain @dataclass
        without __hash__, so hash() would raise TypeError.
        """
        command_name = command.split()[0] if command.strip() else command
        command_hash = hashlib.md5(command.encode()).hexdigest()[:8]
        return f"{command_name}:{command_hash}:{repr(parsed)}"

    @classmethod
    def _build_prompt(cls, command: str, parsed: Any) -> str:
        """Build the classification prompt for the LLM (AC #8).

        Includes the classifier role, command text, parsed structure, safety
        levels, and the expected JSON response format.
        """
        score_to_decision = (
            "score >= 0.7 → allow, score >= 0.3 and score < 0.7 → ask, score < 0.3 → deny"
        )
        safety_levels = (
            "S (critical danger: data destruction, privilege escalation, "
            "system compromise), "
            "A (high risk: file deletion, network exposure, sensitive data access), "
            "B (moderate risk: file modification, package installation), "
            "none (safe: read-only operations, version checks, help commands)"
        )
        parsed_str = repr(parsed)
        if len(parsed_str) > 500:
            parsed_str = parsed_str[:500] + " ..."
        return (
            "你是一个 Shell 命令安全分类助手。你的任务是分析给定的 Shell 命令并评估其安全风险。\n\n"
            "## 命令文本\n"
            f"```\n{command}\n```\n\n"
            "## 解析后的命令结构\n"
            f"```\n{parsed_str}\n```\n\n"
            "## 安全等级定义\n"
            f"{safety_levels}\n\n"
            "## 评分与决策映射\n"
            f"{score_to_decision}\n\n"
            "## 输出格式\n"
            "请以 JSON 格式返回分析结果：\n"
            '```json\n'
            '{"score": 0.0-1.0, "decision": "allow|deny|ask", "reason": "用中文简要解释原因"}\n'
            '```\n'
        )

    @classmethod
    def _parse_classification(
        cls,
        response: str,
    ) -> Tuple[Optional[ClassificationResult], Optional[SafetyError]]:
        """Parse LLM JSON response into ClassificationResult (AC #9).

        Returns (ClassificationResult, None) on success or
        (None, SafetyError) on parse failure.
        """
        try:
            # Extract JSON from response (may be wrapped in markdown code fences
            # or have surrounding text). Find the outermost { ... } pair.
            text = response.strip()
            start = text.find("{")
            end = text.rfind("}")
            if start >= 0 and end > start:
                text = text[start:end + 1]

            data = json.loads(text)
        except json.JSONDecodeError:
            return (None, SafetyError(
                layer="L1_classifier",
                code="PARSE_ERROR",
                message="Failed to parse LLM classification response as JSON",
                degraded=True,
            ))

        # Validate required fields
        try:
            score = float(data.get("score", -1))
            decision = str(data.get("decision", ""))
            reason = str(data.get("reason", ""))
        except (TypeError, ValueError):
            return (None, SafetyError(
                layer="L1_classifier",
                code="PARSE_ERROR",
                message="Invalid field types in classification response",
                degraded=True,
            ))

        if score < 0.0 or score > 1.0:
            return (None, SafetyError(
                layer="L1_classifier",
                code="PARSE_ERROR",
                message=f"score out of range: {score}",
                degraded=True,
            ))

        if decision not in ("allow", "deny", "ask"):
            return (None, SafetyError(
                layer="L1_classifier",
                code="PARSE_ERROR",
                message=f"unknown decision: {decision}",
                degraded=True,
            ))

        result = ClassificationResult(
            score=score,
            decision=decision,
            reason=reason,
            effective_classifier="llm",
            degraded=False,
            degraded_reason="",
        )
        return (result, None)

    @classmethod
    def _do_classify(
        cls,
        command: str,
        parsed: Any,
        cache_key: str,
        session_id: str,
        callback: Callable[[ClassificationResult], None],
    ) -> None:
        """Daemon thread target — call LLM and invoke callback (AC #4, #5, #7).

        On success: caches result and calls callback with ClassificationResult.
        On failure: calls callback with degraded result (decision="ask").
        """
        # Degraded result factory for error paths
        def degraded_result(reason: str) -> ClassificationResult:
            return ClassificationResult(
                score=0.5,
                decision="ask",
                reason=f"分类器不可用: {reason}",
                effective_classifier="disabled",
                degraded=True,
                degraded_reason=reason,
            )

        try:
            llm = _parent_llm_getter()
            if llm is None:
                callback(degraded_result("LLM client unavailable"))
                return

            # Resolve classifier model: check current model for shell_classifier
            # marker, then scan provider models, then fall back to current model.
            classifier_model = cls._resolve_classifier_model()
            if not classifier_model:
                callback(degraded_result("No model available for classification"))
                return
            model_name = classifier_model.get("api_name") or classifier_model.get("name", "")
            if not model_name:
                callback(degraded_result("No classifier model name"))
                return

            prompt = cls._build_prompt(command, parsed)

            # Single-turn, no tools, no streaming, max_tokens=200, temperature=0
            response = llm.chat.completions.create(
                model=model_name,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=200,
                temperature=0,
                stream=False,
                timeout=30,
            )

            content = response.choices[0].message.content or ""
            result, err = cls._parse_classification(content)

            if err is not None:
                # Malformed JSON → degraded result
                callback(ClassificationResult(
                    score=0.5,
                    decision="ask",
                    reason=f"分类器返回格式错误: {err.message}",
                    effective_classifier="disabled",
                    degraded=True,
                    degraded_reason="parse error",
                ))
                return

            # Cache the successful result
            cls._session_cache.setdefault(session_id, {})[cache_key] = result
            callback(result)

        except Exception as exc:
            error_type = type(exc).__name__
            # Distinguish API errors from internal bugs
            api_error_keywords = ("timeout", "ratelimit", "connection",
                                  "auth", "apiconnectionerror", "apierror")
            is_api_error = any(kw in error_type.lower() for kw in api_error_keywords)

            if is_api_error:
                if "timeout" in error_type.lower():
                    reason = "LLM API timeout"
                elif "ratelimit" in error_type:
                    reason = "LLM API rate limit"
                elif "connection" in error_type.lower():
                    reason = "LLM API network error"
                elif "auth" in error_type.lower():
                    reason = "LLM API authentication error"
                else:
                    reason = f"LLM API error: {error_type}"
            else:
                reason = f"Classifier internal error: {error_type}"
            callback(degraded_result(reason))

    @classmethod
    def clear_session_cache(cls, session_id: str) -> None:
        """Clear the classification cache for a specific session.

        Called when a Vim session ends to prevent cross-session leakage (NFR17).
        """
        cls._session_cache.pop(session_id, None)

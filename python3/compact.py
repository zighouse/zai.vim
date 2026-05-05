# Zai.Vim - Context Compression Pipeline
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
Progressive context compression pipeline for zai.vim.

Three levels, each increasingly aggressive:
  Level 1 - Truncate large tool results, reasoning_content, long responses
  Level 2 - Replace old rounds with structured summaries (no LLM)
  Level 3 - LLM-based semantic compact of accumulated history

Design principles:
  - The pipeline is a pure function of history + config -> modified history + stats
  - Level 1 and 2 are zero-cost (no LLM calls), always safe to run
  - Level 3 is gated by auto_compact and the highest threshold
  - Idempotent: repeated runs on already-compressed content are no-ops
"""

import json
from typing import Any, Callable, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Threshold defaults
# ---------------------------------------------------------------------------
_DEFAULT_TOOL_RESULT_THRESHOLD = 2000      # chars
_DEFAULT_REASONING_THRESHOLD = 1000        # chars
_DEFAULT_ASSISTANT_CONTENT_THRESHOLD = 4000 # chars

# Progressive trigger thresholds (fraction of max_context_tokens)
_LEVEL1_TRIGGER = 0.50   # at 50% usage, apply truncation
_LEVEL2_TRIGGER = 0.70   # at 70% usage, also apply summarization
_LEVEL3_TRIGGER = 0.85   # at 85% usage, also apply LLM compact

# Level 2 summary prompt line limits
_SUMMARY_QUESTION_MAX = 200   # chars for user question line
_SUMMARY_ANSWER_MAX = 200     # chars for assistant answer line

# Compact system prompt for Level 3 (LLM semantic compression)
_COMPACT_SYSTEM_PROMPT = """\
Compress the following conversation history into a structured summary.

Include:
1. **Completed work**: Tasks finished, files created/modified/deleted (with full paths)
2. **Current state**: Working directory, active configuration, open files
3. **Key decisions**: Technical choices made and their rationale
4. **Important data**: Code snippets, configuration values, error messages, tool outputs
5. **Pending items**: Unresolved questions, follow-up tasks, partial implementations

Rules:
- Preserve exact file paths and command names
- Keep code snippets verbatim when they contain key logic
- Include relevant error messages and how they were resolved
- Output in Markdown format"""

_COMPACT_SUMMARY_TAG = "<compact summary>"

_TRUNCATED_MARKER = "...[truncated: {} chars total]..."


# ---------------------------------------------------------------------------
# CompactStats
# ---------------------------------------------------------------------------
class CompactStats:
    """Tracks what the pipeline did during a run."""

    def __init__(self):
        self.level1_applied: bool = False
        self.level1_chars_saved: int = 0
        self.level2_applied: bool = False
        self.level2_rounds_summarized: int = 0
        self.level3_applied: bool = False
        self.level3_tokens_before: int = 0
        self.level3_tokens_after: int = 0
        self.tokens_before: int = 0
        self.tokens_after: int = 0

    def summary(self) -> str:
        """Human-readable one-line summary."""
        parts = []
        if self.level1_applied:
            parts.append(f"L1: saved {self.level1_chars_saved} chars")
        if self.level2_applied:
            parts.append(f"L2: {self.level2_rounds_summarized} rounds summarized")
        if self.level3_applied:
            saved = self.level3_tokens_before - self.level3_tokens_after
            parts.append(f"L3: {self.level3_tokens_before}->{self.level3_tokens_after} tokens")
        if not parts:
            return "no compression needed"
        return "; ".join(parts)


# ---------------------------------------------------------------------------
# CompactPipeline
# ---------------------------------------------------------------------------
class CompactPipeline:
    """
    Progressive context compression pipeline for zai.vim.

    Usage::

        pipeline = CompactPipeline(
            count_tokens_fn=aichat._count_tokens,
            run_sub_llm_fn=aichat._run_sub_llm_loop,
            config=aichat._config,
        )
        history, stats = pipeline.run(
            history=aichat._history,
            current_round=aichat._cur_round,
            max_context_tokens=32768,
        )
    """

    def __init__(
        self,
        count_tokens_fn: Callable[[str], int],
        run_sub_llm_fn: Callable[[List[Dict[str, Any]], str, bool, int], str],
        config: dict,
    ):
        self._count_tokens = count_tokens_fn
        self._run_sub_llm = run_sub_llm_fn
        self._config = config

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def run(
        self,
        history: List[Dict[str, Any]],
        current_round: Optional[Dict[str, Any]] = None,
        max_context_tokens: int = 32768,
        keep_last_n: Optional[int] = None,
        force_level: Optional[int] = None,
        auto_compact: bool = False,
        extra_instructions: str = "",
    ) -> Tuple[List[Dict[str, Any]], CompactStats]:
        """
        Execute the progressive compression pipeline.

        Args:
            history: The current _history list (modified in place).
            current_round: The pending request (for token estimation).
            max_context_tokens: Model context window size.
            keep_last_n: Minimum rounds to preserve intact.
            force_level: If set to 1/2/3, force that level regardless of threshold.
            auto_compact: Whether Level 3 (LLM) is permitted.
            extra_instructions: Additional instructions for Level 3 prompt.

        Returns:
            (modified_history, stats)
        """
        if keep_last_n is None:
            keep_last_n = self._config.get('history_keep_last_n', 6)
        keep_last_n = max(1, int(keep_last_n))

        stats = CompactStats()

        if not history:
            return history, stats

        # Calculate current token usage
        token_usage = self.calculate_token_usage(history, current_round)
        stats.tokens_before = token_usage

        # Determine which levels to activate
        levels = self._determine_levels(token_usage, max_context_tokens,
                                        force_level, auto_compact)

        # Execute levels in order
        if 1 in levels:
            chars_saved = self.truncate_tool_results(history)
            if chars_saved > 0:
                stats.level1_applied = True
                stats.level1_chars_saved = chars_saved

        if 2 in levels:
            rounds_summarized = self.summarize_old_rounds(history, keep_last_n)
            if rounds_summarized > 0:
                stats.level2_applied = True
                stats.level2_rounds_summarized = rounds_summarized

        if 3 in levels:
            tokens_before_l3 = self.calculate_token_usage(history, current_round)
            success = self.llm_semantic_compact(
                history, keep_last_n, extra_instructions
            )
            if success:
                tokens_after_l3 = self.calculate_token_usage(history, current_round)
                stats.level3_applied = True
                stats.level3_tokens_before = tokens_before_l3
                stats.level3_tokens_after = tokens_after_l3

        stats.tokens_after = self.calculate_token_usage(history, current_round)
        return history, stats

    def calculate_token_usage(
        self,
        history: List[Dict[str, Any]],
        current_round: Optional[Dict[str, Any]] = None,
    ) -> int:
        """Estimate total tokens across all history + current_round."""
        total = 0
        for round_obj in history:
            total += self._round_token_estimate(round_obj)
        if current_round:
            total += self._round_token_estimate(current_round)
        return total

    # ------------------------------------------------------------------
    # Level 1 - Tool Result Truncation
    # ------------------------------------------------------------------

    def truncate_tool_results(
        self,
        history: List[Dict[str, Any]],
        tool_threshold: Optional[int] = None,
        reasoning_threshold: Optional[int] = None,
        content_threshold: Optional[int] = None,
    ) -> int:
        """
        Level 1: In-place truncation of large content in history.

        Walks every round's response list and truncates:
          - tool result content
          - reasoning_content fields
          - long assistant content (without tool_calls)

        Returns: number of characters saved (approximate).
        """
        if tool_threshold is None:
            tool_threshold = self._config.get(
                'compact_tool_result_threshold', _DEFAULT_TOOL_RESULT_THRESHOLD
            )
        if reasoning_threshold is None:
            reasoning_threshold = self._config.get(
                'compact_reasoning_threshold', _DEFAULT_REASONING_THRESHOLD
            )
        if content_threshold is None:
            content_threshold = self._config.get(
                'compact_content_threshold', _DEFAULT_ASSISTANT_CONTENT_THRESHOLD
            )

        chars_saved = 0
        for round_obj in history:
            # Skip summary rounds
            if round_obj.get("summary"):
                continue

            for resp in round_obj.get("response", []):
                if not isinstance(resp, dict):
                    continue

                # Truncate tool results
                if resp.get("role") == "tool":
                    content = resp.get("content", "")
                    new_content, saved = self._truncate_text(content, tool_threshold)
                    if saved > 0:
                        resp["content"] = new_content
                        chars_saved += saved

                # Truncate reasoning_content on assistant messages
                elif resp.get("role") == "assistant":
                    rc = resp.get("reasoning_content", "")
                    if rc:
                        new_rc, saved = self._truncate_text(rc, reasoning_threshold)
                        if saved > 0:
                            resp["reasoning_content"] = new_rc
                            chars_saved += saved

                    # Truncate long assistant content (only if no tool_calls)
                    if not resp.get("tool_calls"):
                        content = resp.get("content", "")
                        new_content, saved = self._truncate_text(content, content_threshold)
                        if saved > 0:
                            resp["content"] = new_content
                            chars_saved += saved

                    # Truncate large tool_call arguments
                    for tc in resp.get("tool_calls", []):
                        func = tc.get("function", {})
                        args_str = func.get("arguments", "")
                        if isinstance(args_str, str) and args_str:
                            try:
                                args = json.loads(args_str)
                            except (json.JSONDecodeError, TypeError):
                                continue
                            args_changed = False
                            for key, val in args.items():
                                if isinstance(val, str) and len(val) > tool_threshold:
                                    new_val, saved = self._truncate_text(val, tool_threshold)
                                    if saved > 0:
                                        args[key] = new_val
                                        chars_saved += saved
                                        args_changed = True
                            if args_changed:
                                func["arguments"] = json.dumps(args, ensure_ascii=False)

        return chars_saved

    # ------------------------------------------------------------------
    # Level 2 - Round Summarization (no LLM)
    # ------------------------------------------------------------------

    def summarize_old_rounds(
        self,
        history: List[Dict[str, Any]],
        keep_last_n: int = 6,
    ) -> int:
        """
        Level 2: Replace old rounds with structured summaries.

        For each old round beyond keep_last_n, create a compact summary
        containing: user question, tools called, assistant conclusion.

        Returns: number of rounds summarized.
        """
        if not history or len(history) <= keep_last_n:
            return 0

        # Determine which rounds to summarize
        # If history[0] is already a summary, start from index 1
        start_idx = 0
        if history and history[0].get("summary"):
            start_idx = 1

        end_idx = max(start_idx, len(history) - keep_last_n)

        if start_idx >= end_idx:
            return 0

        rounds_summarized = 0
        for i in range(start_idx, end_idx):
            round_obj = history[i]
            # Skip already-summarized rounds
            if round_obj.get("summary"):
                continue

            summary_text = self._create_round_summary(round_obj)
            if summary_text:
                history[i] = {
                    "request": {
                        "role": "system",
                        "content": "[round summary]\n" + summary_text,
                    },
                    "response": [],
                    "summary": True,
                    "round_summarized": True,
                }
                rounds_summarized += 1

        return rounds_summarized

    # ------------------------------------------------------------------
    # Level 3 - LLM Semantic Compact
    # ------------------------------------------------------------------

    def llm_semantic_compact(
        self,
        history: List[Dict[str, Any]],
        keep_last_n: int = 6,
        extra_instructions: str = "",
    ) -> bool:
        """
        Level 3: LLM-based semantic compaction.

        Steps:
          1. Identify rounds to compact (before keep_last_n, excluding existing summaries)
          2. Flatten into messages for LLM
          3. Call sub-LLM for summary
          4. Create summary round, prepend, trim

        Returns: True if compact succeeded, False otherwise.
        """
        if not history or len(history) <= keep_last_n:
            return False

        # Find rounds to compact
        # Preserve any existing summary at index 0
        existing_summary = None
        compact_start = 0
        if history and history[0].get("summary"):
            existing_summary = history[0]
            compact_start = 1

        compact_end = max(compact_start, len(history) - keep_last_n)
        if compact_start >= compact_end:
            return False

        rounds_to_compact = history[compact_start:compact_end]
        if not rounds_to_compact:
            return False

        # Flatten into messages
        messages = self._flatten_for_llm(rounds_to_compact)
        if not messages:
            return False

        # Build system prompt
        system_prompt = _COMPACT_SYSTEM_PROMPT
        if extra_instructions:
            system_prompt += f"\n\nAdditional instructions: {extra_instructions}"

        # Call sub-LLM
        summary = self._run_sub_llm(messages, system_prompt=system_prompt)

        if not summary:
            # Fallback: apply Level 2 summarization instead
            self.summarize_old_rounds(history, keep_last_n)
            return False

        # Create summary round
        compact_round = {
            "request": {
                "role": "system",
                "content": _COMPACT_SUMMARY_TAG + "\n" + summary,
            },
            "response": [],
            "summary": True,
        }

        # Rebuild history: [summary] + remaining recent rounds
        recent_rounds = history[compact_end:]
        if existing_summary:
            # Merge: if there was a previous summary, include it before the new one
            # Actually, the new summary replaces everything before keep_last_n
            # So we just use the new summary
            pass

        history[:] = [compact_round] + recent_rounds
        return True

    # ------------------------------------------------------------------
    # Token Budget
    # ------------------------------------------------------------------

    def _determine_levels(
        self,
        token_usage: int,
        max_context_tokens: int,
        force_level: Optional[int] = None,
        auto_compact: bool = False,
    ) -> List[int]:
        """
        Given current token usage, determine which levels to activate.
        Returns a list of level numbers, e.g. [1], [1, 2], or [1, 2, 3].
        """
        if force_level is not None:
            levels = list(range(1, force_level + 1))
            # Gate Level 3 on auto_compact unless explicitly forced
            if 3 in levels and not auto_compact and force_level != 3:
                levels.remove(3)
            return levels

        if max_context_tokens <= 0:
            return []

        ratio = token_usage / max_context_tokens

        levels = []
        l1_trigger = self._config.get('compact_level1_trigger', _LEVEL1_TRIGGER)
        l2_trigger = self._config.get('compact_level2_trigger', _LEVEL2_TRIGGER)
        l3_trigger = self._config.get('compact_level3_trigger', _LEVEL3_TRIGGER)

        if ratio >= l1_trigger:
            levels.append(1)
        if ratio >= l2_trigger:
            levels.append(2)
        if ratio >= l3_trigger and auto_compact:
            levels.append(3)

        return levels

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _truncate_text(self, text: str, threshold: int) -> Tuple[str, int]:
        """
        Truncate text at threshold, keeping head/tail with marker.

        Returns: (truncated_text, chars_saved)
        """
        if not text or len(text) <= threshold:
            return text, 0

        # Check if already truncated
        marker_prefix = "...[truncated:"
        if marker_prefix in text:
            # Already truncated, skip
            return text, 0

        original_len = len(text)
        half = threshold // 2
        marker = _TRUNCATED_MARKER.format(original_len)
        truncated = text[:half] + "\n" + marker + "\n" + text[-half:]
        return truncated, original_len - len(truncated)

    def _create_round_summary(self, round_obj: Dict[str, Any]) -> Optional[str]:
        """Create a brief structured summary of a single round (no LLM)."""
        lines = []

        # User question
        req = round_obj.get("request", {})
        if isinstance(req, dict):
            content = req.get("content", "")
            if content:
                first_line = content.split("\n")[0].strip()
                if len(first_line) > _SUMMARY_QUESTION_MAX:
                    first_line = first_line[:_SUMMARY_QUESTION_MAX] + "..."
                lines.append(f"Q: {first_line}")

        # Tools called
        tool_names = self._extract_tool_names(round_obj.get("response", []))
        if tool_names:
            lines.append(f"Tools: {', '.join(tool_names)}")

        # File paths from tool arguments
        file_paths = self._extract_file_paths(round_obj.get("response", []))
        if file_paths:
            lines.append(f"Files: {', '.join(file_paths[:5])}")

        # Assistant conclusion
        for resp in round_obj.get("response", []):
            if not isinstance(resp, dict):
                continue
            if resp.get("role") == "assistant" and resp.get("content"):
                first_line = resp["content"].split("\n")[0].strip()
                if first_line and not first_line.startswith(""):
                    if len(first_line) > _SUMMARY_ANSWER_MAX:
                        first_line = first_line[:_SUMMARY_ANSWER_MAX] + "..."
                    lines.append(f"A: {first_line}")
                break

        return "\n".join(lines) if lines else None

    def _extract_tool_names(self, response_list: list) -> List[str]:
        """Extract unique tool names from response messages."""
        names = []
        seen = set()
        for resp in response_list:
            if not isinstance(resp, dict):
                continue
            # From tool_calls on assistant messages
            for tc in resp.get("tool_calls", []):
                func = tc.get("function", {})
                name = func.get("name", "")
                if name and name not in seen:
                    names.append(name)
                    seen.add(name)
            # From tool result messages
            if resp.get("role") == "tool":
                name = resp.get("name", "")
                if name and name not in seen:
                    names.append(name)
                    seen.add(name)
        return names

    def _extract_file_paths(self, response_list: list) -> List[str]:
        """Extract file paths from tool call arguments."""
        paths = []
        seen = set()
        for resp in response_list:
            if not isinstance(resp, dict):
                continue
            for tc in resp.get("tool_calls", []):
                func = tc.get("function", {})
                args_str = func.get("arguments", "")
                if not args_str:
                    continue
                try:
                    args = json.loads(args_str) if isinstance(args_str, str) else args_str
                except (json.JSONDecodeError, TypeError):
                    continue
                for key in ("path", "file_path", "filename", "directory"):
                    val = args.get(key, "")
                    if isinstance(val, str) and val and val not in seen:
                        paths.append(val)
                        seen.add(val)
        return paths

    def _flatten_for_llm(
        self, rounds: List[Dict[str, Any]]
    ) -> List[Dict[str, str]]:
        """
        Flatten rounds into role/content messages for sub-LLM call.

        Similar to aichat._flatten_history_to_messages but standalone.
        """
        messages = []
        for round_obj in rounds:
            # Skip summary rounds (they're already summarized)
            if round_obj.get("summary"):
                req = round_obj.get("request", {})
                if isinstance(req, dict) and req.get("content"):
                    messages.append({"role": "system", "content": req["content"]})
                continue

            req = round_obj.get("request")
            if req and isinstance(req, dict) and "content" in req:
                content = req["content"]
                if len(content) > 4000:
                    content = content[:2000] + "\n...[truncated]...\n" + content[-2000:]
                messages.append({"role": req.get("role", "user"), "content": content})

            for resp in round_obj.get("response", []):
                if not isinstance(resp, dict):
                    continue

                # Tool results
                if resp.get("role") == "tool":
                    content = resp.get("content", "")
                    if content:
                        if len(content) > 4000:
                            content = content[:2000] + "\n...[truncated]...\n" + content[-2000:]
                        tool_name = resp.get("name", "tool")
                        messages.append({
                            "role": "user",
                            "content": f"[{tool_name} result]: {content}",
                        })
                    continue

                # Assistant messages
                if "content" in resp:
                    content = resp["content"]
                    # Add tool call summary
                    if resp.get("tool_calls"):
                        tool_names = []
                        for tc in resp["tool_calls"]:
                            func = tc.get("function", {})
                            if isinstance(func, dict):
                                name = func.get("name", "")
                                if name:
                                    tool_names.append(name)
                        if tool_names:
                            content += f"\n[tool_calls: {', '.join(tool_names)}]"
                    if len(content) > 4000:
                        content = content[:2000] + "\n...[truncated]...\n" + content[-2000:]
                    messages.append({
                        "role": resp.get("role", "assistant"),
                        "content": content,
                    })

        return messages

    def _round_token_estimate(self, round_obj: Dict[str, Any]) -> int:
        """Estimate tokens for a single round."""
        total = 0
        req = round_obj.get("request")
        if req and isinstance(req, dict) and "content" in req:
            total += self._count_tokens(req["content"])
        for resp in round_obj.get("response", []):
            if isinstance(resp, dict):
                if "content" in resp:
                    total += self._count_tokens(resp["content"])
                if "reasoning_content" in resp:
                    total += self._count_tokens(resp["reasoning_content"])
        return total

    # ------------------------------------------------------------------
    # Status / Diagnostics
    # ------------------------------------------------------------------

    def get_status(
        self,
        history: List[Dict[str, Any]],
        max_context_tokens: int,
    ) -> str:
        """Return a human-readable status string for /compact status."""
        if not history:
            return "[compact status]\nHistory: empty"

        total_rounds = len(history)
        summary_rounds = sum(1 for r in history if r.get("summary"))
        full_rounds = total_rounds - summary_rounds
        token_usage = self.calculate_token_usage(history)

        l1_trigger = self._config.get('compact_level1_trigger', _LEVEL1_TRIGGER)
        l2_trigger = self._config.get('compact_level2_trigger', _LEVEL2_TRIGGER)
        l3_trigger = self._config.get('compact_level3_trigger', _LEVEL3_TRIGGER)

        ratio = token_usage / max_context_tokens if max_context_tokens > 0 else 0

        if ratio < l1_trigger:
            active = "none (below threshold)"
        elif ratio < l2_trigger:
            active = "1 (truncation)"
        elif ratio < l3_trigger:
            active = "1-2 (truncation + summarization)"
        else:
            active = "1-3 (all levels)"

        tool_thresh = self._config.get(
            'compact_tool_result_threshold', _DEFAULT_TOOL_RESULT_THRESHOLD
        )
        reasoning_thresh = self._config.get(
            'compact_reasoning_threshold', _DEFAULT_REASONING_THRESHOLD
        )
        content_thresh = self._config.get(
            'compact_content_threshold', _DEFAULT_ASSISTANT_CONTENT_THRESHOLD
        )

        return (
            f"[compact status]\n"
            f"History rounds: {total_rounds} "
            f"({summary_rounds} summarized, {full_rounds} full)\n"
            f"Token usage: ~{token_usage:,} / {max_context_tokens:,} ({ratio:.0%})\n"
            f"Active levels: {active}\n"
            f"Triggers: L1={l1_trigger:.0%}, L2={l2_trigger:.0%}, L3={l3_trigger:.0%}\n"
            f"Truncation thresholds: tool={tool_thresh}, reasoning={reasoning_thresh}, content={content_thresh}\n"
            f"Auto-compact: {'ON' if self._config.get('auto_compact', False) else 'OFF'}"
        )

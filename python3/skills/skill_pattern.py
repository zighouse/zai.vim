"""
Usage pattern recognition — detect frequent skill chains and suggest固化.

Scans audit logs for repeated chain patterns over a rolling window,
generates SKILL.md drafts for frequently used chains, and manages
suggestion suppression for rejected patterns.
"""

from __future__ import annotations

import json
import logging
import sys
from collections import Counter
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent))
from paths import get_skills_dir

from .skill_types import SecurityDomain

logger = logging.getLogger(__name__)

_DEFAULT_THRESHOLD = 5  # uses in window
_DEFAULT_WINDOW_DAYS = 7
_SKILLS_DIR = get_skills_dir()


def _domain_rank(domain: str) -> int:
    """Return priority rank for security domain (lower = more restrictive)."""
    ranks = {
        "local": 0,
        "workspace": 1,
        "personal": 2,
        "public": 3,
    }
    return ranks.get(domain, 1)


class PatternSuggester:
    """Detects frequent skill chain patterns from audit logs."""

    def __init__(
        self,
        audit_log_path: Optional[Path] = None,
        threshold: int = _DEFAULT_THRESHOLD,
        window_days: int = _DEFAULT_WINDOW_DAYS,
    ):
        self._audit_path = audit_log_path
        self._threshold = threshold
        self._window_days = window_days
        self._suppressed: set[str] = set()

    def detect_patterns(self) -> list[dict]:
        """Scan audit logs and return chains exceeding frequency threshold.

        Returns list of dicts:
        {"chain": [skill_names], "count": N, "suggested_name": str}
        """
        if self._audit_path is None or not self._audit_path.is_file():
            return []

        # Parse audit log for chain patterns
        chain_counts: Counter[str] = Counter()
        chain_names: dict[str, list[str]] = {}

        try:
            with open(self._audit_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    chain = entry.get("call_chain", [])
                    if isinstance(chain, list) and len(chain) >= 2:
                        key = " -> ".join(chain)
                        chain_counts[key] += 1
                        chain_names[key] = chain
        except OSError as e:
            logger.warning("Failed to read audit log: %s", e)
            return []

        # Filter by threshold and suppress rejected
        patterns = []
        for key, count in chain_counts.most_common(20):
            if count < self._threshold:
                break
            if key in self._suppressed:
                continue
            chain = chain_names[key]
            patterns.append({
                "chain": chain,
                "count": count,
                "suggested_name": self._suggest_name(chain),
            })

        return patterns

    def suggest固化(self, chain: list[str]) -> Optional[str]:
        """Generate a SKILL.md draft for a frequent chain.

        Returns the draft content as a string, or None if chain is empty.
        """
        if not chain:
            return None

        name = self._suggest_name(chain)
        description = (
            f"Automated chain: {' -> '.join(chain)}. "
            f"Detected as frequent pattern."
        )

        # Determine minimum security domain
        domain = "workspace"  # safe default

        draft = (
            f"---\n"
            f"name: {name}\n"
            f"description: \"{description}\"\n"
            f"security_domain: {domain}\n"
            f"version: \"0.1.0\"\n"
            f"dependencies:\n"
            f"  skill_chain: {json.dumps(chain)}\n"
            f"---\n"
            f"\n"
            f"# {name}\n"
            f"\n"
            f"Executes the following skill chain:\n"
        )
        for i, skill in enumerate(chain, 1):
            draft += f"{i}. `{skill}`\n"
        draft += (
            f"\n"
            f"Output of each step is passed as input to the next.\n"
        )

        return draft

    def suppress(self, chain_key: str) -> None:
        """Suppress a pattern suggestion for the window period."""
        self._suppressed.add(chain_key)

    @staticmethod
    def _suggest_name(chain: list[str]) -> str:
        """Generate a name for a chain pattern."""
        if len(chain) <= 3:
            return "-".join(chain)
        # For longer chains, use first + last + count
        return f"{chain[0]}-chain-{len(chain)}"

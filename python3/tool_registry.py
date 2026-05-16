#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
Tool registry: auto-discovery, LLM compilation, and cache management.

Replaces the old manual use_tool() workflow:
  1. Auto-scan tool_*.json + tool_*.py at startup
  2. Parse each tool definition into a ToolSpec
  3. Group tools by category, assign initial tiers
  4. Optionally compile category summaries via LLM (cached)
  5. Provide get_first_class_tools() / get_second_class_agents() for API calls
"""

import hashlib
import json
import os
import re
import sys
import tempfile
import threading
import time
import importlib
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from tool_spec import (
    CategoryAgentSpec,
    CategorySummary,
    ToolResult,
    ToolSpec,
    ToolTier,
    DEFAULT_FIRST_CLASS_TOOLS,
    classify_output_scale,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
CACHE_DIR_NAME = ".cache/tool_registry"
CATEGORIES_CACHE_FILE = "categories.json"
REGISTRY_CACHE_FILE = "registry.json"

# LLM compilation prompt
_CATEGORY_COMPILE_SYSTEM_PROMPT = """\
你是一个软件架构工具分类器。你会收到一个工具分类名和该分类下一组工具的定义（名称 + 描述）。

请为这个分类生成一段简洁的中文摘要（80-150字），概括该分类的工具能做什么、适用于什么场景。
输出必须是纯文本，不要包含任何格式标记。"""


# ---------------------------------------------------------------------------
# Registry singleton
# ---------------------------------------------------------------------------

class ToolRegistry:
    """Auto-discovers, validates, and organises all available tools.

    Usage::

        registry = ToolRegistry()
        registry.scan()            # discover tool_*.json + tool_*.py
        registry.load_from_cache() # try to restore cached categories
        # ... (later, optionally)
        registry.compile_categories(llm_fn)  # LLM generates category summaries
    """

    def __init__(self, tools_dir: Optional[str] = None):
        self._tools_dir = Path(tools_dir) if tools_dir else Path(__file__).parent
        self._cache_dir = self._tools_dir / CACHE_DIR_NAME

        # name → ToolSpec
        self._tools: Dict[str, ToolSpec] = {}
        # name → callable (the invoke_* function)
        self._invokers: Dict[str, Callable] = {}
        # category → CategorySummary
        self._categories: Dict[str, CategorySummary] = {}

        # Promotion threshold
        self._promotion_threshold: int = 10

        # LLM callback (set later for compilation)
        self._llm_fn: Optional[Callable] = None

    # ------------------------------------------------------------------
    # Scanning
    # ------------------------------------------------------------------

    def scan(self) -> int:
        """Discover all tool_*.json files and their corresponding .py modules.

        Returns the number of tools discovered.
        """
        self._tools.clear()
        self._invokers.clear()

        json_files = sorted(self._tools_dir.glob("tool_*.json"))
        count = 0

        for json_path in json_files:
            match = re.match(r"tool_(.+)\.json", json_path.name)
            if not match:
                continue
            toolset_name = match.group(1)

            # Parse JSON definitions
            try:
                raw_tools = json.loads(json_path.read_text(encoding="utf-8"))
            except Exception as exc:
                print(f"[registry] WARN: cannot parse {json_path.name}: {exc}",
                      file=sys.stderr)
                continue

            if not isinstance(raw_tools, list):
                raw_tools = [raw_tools]

            # Load corresponding .py module
            mod = self._load_module(toolset_name)
            if mod is None:
                print(f"[registry] WARN: no tool_{toolset_name}.py, skipping",
                      file=sys.stderr)
                continue

            for raw in raw_tools:
                fn = raw.get("function")
                if not fn:
                    continue
                name = fn.get("name")
                if not name:
                    continue

                invoker = getattr(mod, f"invoke_{name}", None)
                if invoker is None:
                    print(f"[registry] WARN: invoke_{name} not found in "
                          f"tool_{toolset_name}.py", file=sys.stderr)
                    continue

                # Build ToolSpec
                spec = ToolSpec(
                    name=name,
                    description=fn.get("description", ""),
                    parameters=fn.get("parameters", {"type": "object", "properties": {}, "required": []}),
                    output_schema=raw.get("output_schema"),
                    prompt=raw.get("prompt", ""),
                    category=raw.get("category", toolset_name),
                    tier=self._determine_initial_tier(name),
                    is_read_only=raw.get("is_read_only", True),
                    is_concurrency_safe=raw.get("is_concurrency_safe", True),
                    user_only=raw.get("user_only", False),
                    max_result_size=raw.get("max_result_size", 8000),
                )

                self._tools[name] = spec
                self._invokers[name] = invoker
                count += 1

        print(f"[registry] scanned {count} tools from {len(json_files)} files",
              file=sys.stderr)
        return count

    def _load_module(self, toolset_name: str):
        """Import tool_{name}.py, returning the module object or None.

        If the module was already imported, it is reloaded to pick up changes.
        """
        module_name = f"tool_{toolset_name}"
        try:
            if module_name in sys.modules:
                mod = importlib.reload(sys.modules[module_name])
            else:
                mod = importlib.import_module(module_name)
            return mod
        except Exception as exc:
            print(f"[registry] WARN: import {module_name} failed: {exc}",
                  file=sys.stderr)
            return None

    def _determine_initial_tier(self, name: str) -> ToolTier:
        """Determine a tool's initial citizen level."""
        return "first" if name in DEFAULT_FIRST_CLASS_TOOLS else "second"

    # ------------------------------------------------------------------
    # Category compilation
    # ------------------------------------------------------------------

    def build_categories(self) -> Dict[str, List[str]]:
        """Group tools by category, returning {category: [tool_name, ...]}."""
        groups: Dict[str, List[str]] = {}
        for name, spec in sorted(self._tools.items()):
            groups.setdefault(spec.category, []).append(name)
        return groups

    def compute_tools_hash(self, names: List[str]) -> str:
        """Compute a content hash for a list of tool definitions."""
        h = hashlib.sha256()
        for name in sorted(names):
            spec = self._tools.get(name)
            if spec is None:
                continue
            # Hash the stable fields: name, description, parameters, prompt,
            # is_read_only, max_result_size (NOT call_count etc.)
            payload = json.dumps({
                "name": spec.name,
                "description": spec.description,
                "parameters": spec.parameters,
                "prompt": spec.prompt,
                "is_read_only": spec.is_read_only,
                "max_result_size": spec.max_result_size,
            }, sort_keys=True, ensure_ascii=False)
            h.update(payload.encode("utf-8"))
        return h.hexdigest()

    def compile_categories(self, llm_fn: Callable) -> bool:
        """Use LLM to generate CategorySummary for each tool group.

        llm_fn(prompt: str) → str  (the LLM completion callback)

        Returns True if all categories were compiled successfully.
        """
        self._llm_fn = llm_fn

        try:
            from yaml import safe_load, safe_dump
        except ImportError:
            print("[registry] WARN: PyYAML not available, using simple categories",
                  file=sys.stderr)
            return self._compile_simple_categories()

        groups = self.build_categories()
        changed = False

        for cat_name, tool_names in groups.items():
            new_hash = self.compute_tools_hash(tool_names)

            # Check cache
            existing = self._categories.get(cat_name)
            if existing and existing.tools_hash == new_hash:
                # Ensure tool_names are up-to-date (new tools may have been added
                # to category even if hash matches overall set)
                if set(existing.tool_names) == set(tool_names):
                    continue

            # Compile via LLM
            summary_text = self._llm_compile_category(cat_name, tool_names)
            if summary_text is None:
                # LLM failed; use a simple fallback
                summary_text = self._fallback_summary(cat_name, tool_names)

            self._categories[cat_name] = CategorySummary(
                category=cat_name,
                summary=summary_text,
                tool_names=tool_names,
                tools_hash=new_hash,
            )
            changed = True
            print(f"[registry] compiled category '{cat_name}' "
                  f"({len(tool_names)} tools)", file=sys.stderr)

        if changed:
            self._save_cache()

        return True

    def _llm_compile_category(
        self, cat_name: str, tool_names: List[str]
    ) -> Optional[str]:
        """Ask the LLM to generate a summary for one category."""
        if self._llm_fn is None:
            return None

        # Build tool descriptions
        tool_descs = []
        for name in tool_names:
            spec = self._tools.get(name)
            if spec:
                tool_descs.append(f"- {name}: {spec.description}")

        if not tool_descs:
            return None

        prompt = (
            f"分类名: {cat_name}\n"
            f"工具数量: {len(tool_descs)}\n\n"
            f"工具列表:\n" + "\n".join(tool_descs)
        )

        try:
            result = self._llm_fn(prompt)
            # Extract just the text content (may come back as JSON or raw)
            if isinstance(result, str):
                return result.strip()
            if isinstance(result, dict):
                return str(result.get("content", "")).strip()
            return str(result).strip()
        except Exception as exc:
            print(f"[registry] LLM compile failed for '{cat_name}': {exc}",
                  file=sys.stderr)
            return None

    def _compile_simple_categories(self) -> bool:
        """Generate category summaries without LLM (pure rule-based)."""
        groups = self.build_categories()
        for cat_name, tool_names in groups.items():
            new_hash = self.compute_tools_hash(tool_names)
            existing = self._categories.get(cat_name)
            if existing and existing.tools_hash == new_hash:
                continue
            self._categories[cat_name] = CategorySummary(
                category=cat_name,
                summary=self._fallback_summary(cat_name, tool_names),
                tool_names=tool_names,
                tools_hash=new_hash,
            )
        self._save_cache()
        return True

    @staticmethod
    def _fallback_summary(cat_name: str, tool_names: List[str]) -> str:
        """Generate a simple summary without LLM."""
        return (
            f"{cat_name} 分类包含 {len(tool_names)} 个工具，"
            f"包括: {', '.join(tool_names[:5])}"
            f"{'...' if len(tool_names) > 5 else ''}。"
            f"用于 {cat_name} 相关的操作。"
        )

    # ------------------------------------------------------------------
    # Cache I/O
    # ------------------------------------------------------------------

    def _save_cache(self):
        """Persist category summaries to disk atomically."""
        self._cache_dir.mkdir(parents=True, exist_ok=True)

        data = {
            cat: cs.to_dict()
            for cat, cs in self._categories.items()
        }
        content = json.dumps(data, ensure_ascii=False, indent=2)
        cache_path = self._cache_dir / CATEGORIES_CACHE_FILE
        try:
            # Atomic write: tmp file → rename
            fd, tmp_path_str = tempfile.mkstemp(
                dir=str(self._cache_dir), suffix=".tmp"
            )
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content)
            os.replace(tmp_path_str, str(cache_path))
        except Exception as exc:
            print(f"[registry] WARN: cache write failed: {exc}", file=sys.stderr)

    def load_from_cache(self) -> bool:
        """Restore category summaries from disk cache."""
        cache_path = self._cache_dir / CATEGORIES_CACHE_FILE

        # Migrate old .yaml path → .json
        old_path = self._cache_dir / "categories.yaml"
        if old_path.exists() and not cache_path.exists():
            try:
                old_path.rename(cache_path)
                print(f"[registry] migrated cache {old_path.name} → {cache_path.name}",
                      file=sys.stderr)
            except OSError:
                pass

        if not cache_path.exists():
            return False

        try:
            raw = json.loads(cache_path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"[registry] WARN: cache read failed: {exc}", file=sys.stderr)
            return False

        loaded = 0
        for cat_name, d in raw.items():
            cs = CategorySummary.from_dict(d)
            current_hash = self.compute_tools_hash(cs.tool_names)
            if current_hash == cs.tools_hash:
                self._categories[cat_name] = cs
                loaded += 1
            else:
                print(f"[registry] cache stale for '{cat_name}', will recompile",
                      file=sys.stderr)

        if loaded:
            print(f"[registry] loaded {loaded}/{len(raw)} categories from cache",
                  file=sys.stderr)
        return loaded > 0

    # ------------------------------------------------------------------
    # Public query API
    # ------------------------------------------------------------------

    def get_tool(self, name: str) -> Optional[ToolSpec]:
        """Get a single ToolSpec by name."""
        return self._tools.get(name)

    def get_invoker(self, name: str) -> Optional[Callable]:
        """Get the callable for a tool by name."""
        return self._invokers.get(name)

    def get_first_class_tools(self) -> List[Dict[str, Any]]:
        """Return OpenAI tool definitions for all first-class tools.

        Tools marked user_only are excluded — they should never be
        visible to the LLM (e.g. shell_allow_once, shell_deny_once).
        """
        result = []
        for name, spec in sorted(self._tools.items()):
            if spec.tier == "first" and not spec.user_only:
                result.append(spec.to_openai_tool_with_prompt())
        return result

    def get_second_class_agents(self) -> List[Dict[str, Any]]:
        """Return OpenAI tool definitions for category agents."""
        result = []
        for cat_name, summary in sorted(self._categories.items()):
            # Only expose categories that actually have second-class tools
            has_second = any(
                self._tools.get(n) and self._tools[n].tier == "second"
                for n in summary.tool_names
            )
            if has_second:
                agent_spec = CategoryAgentSpec(category=cat_name, summary=summary)
                result.append(agent_spec.to_openai_tool())
        return result

    def get_all_api_tools(self) -> List[Dict[str, Any]]:
        """Full tools list for the API call: first-class + category agents."""
        tools = self.get_first_class_tools()
        tools.extend(self.get_second_class_agents())
        return tools

    def get_category_tools(self, category: str,
                           include_first_class: bool = False) -> List[Dict[str, Any]]:
        """Get tool definitions for a specific category (for sub-agent use).

        Args:
            category: Category name.
            include_first_class: When False (default), exclude first-class tools
                since they're already exposed directly to the main AI.
        """
        summary = self._categories.get(category)
        if not summary:
            return []
        result = []
        for name in summary.tool_names:
            spec = self._tools.get(name)
            if spec and not spec.user_only and (include_first_class or spec.tier != "first"):
                result.append(spec.to_openai_tool_with_prompt())
        return result

    def get_category_invokers(
        self, category: str, include_first_class: bool = False
    ) -> List[Tuple[ToolSpec, Callable]]:
        """Get (ToolSpec, callable) pairs for a specific category.

        Args:
            category: Category name.
            include_first_class: When False (default), exclude first-class tools.
        """
        summary = self._categories.get(category)
        if not summary:
            return []
        result = []
        for name in summary.tool_names:
            spec = self._tools.get(name)
            invoker = self._invokers.get(name)
            if spec and invoker and (include_first_class or spec.tier != "first"):
                result.append((spec, invoker))
        return result

    # ------------------------------------------------------------------
    # Tier management
    # ------------------------------------------------------------------

    def record_call(self, name: str, result_chars: int = 0,
                    is_error: bool = False) -> bool:
        """Record a tool invocation and check for promotion.

        Returns True if the tool was just promoted.
        """
        spec = self._tools.get(name)
        if spec is None:
            return False
        spec.record_call(result_chars, is_error)
        if spec.should_promote(self._promotion_threshold):
            spec.promote()
            print(f"[registry] promoted '{name}' to first-class "
                  f"(called {spec.call_count} times)", file=sys.stderr)
            return True
        return False

    def set_promotion_threshold(self, n: int):
        """Set the call-count threshold for tier promotion."""
        self._promotion_threshold = n

    # ------------------------------------------------------------------
    # Info / introspection
    # ------------------------------------------------------------------

    @property
    def tool_count(self) -> int:
        return len(self._tools)

    @property
    def category_names(self) -> List[str]:
        return sorted(self._categories.keys())

    def stats(self) -> Dict[str, Any]:
        """Return a summary dict for debugging / display."""
        first_count = sum(1 for s in self._tools.values() if s.tier == "first")
        second_count = sum(1 for s in self._tools.values() if s.tier == "second")
        return {
            "total_tools": self.tool_count,
            "first_class": first_count,
            "second_class": second_count,
            "categories": len(self._categories),
            "cached_categories": sum(
                1 for cs in self._categories.values() if cs.tools_hash
            ),
            "promotion_threshold": self._promotion_threshold,
        }


# ---------------------------------------------------------------------------
# Module-level convenience
# ---------------------------------------------------------------------------

_registry: Optional[ToolRegistry] = None
_registry_lock = threading.Lock()


def get_registry(tools_dir: Optional[str] = None) -> ToolRegistry:
    """Get or create the singleton ToolRegistry.

    Thread-safe: uses a module-level lock.
    tools_dir is only honoured the first time the singleton is created.
    """
    global _registry
    if _registry is not None:
        return _registry
    with _registry_lock:
        if _registry is None:
            _registry = ToolRegistry(tools_dir=tools_dir)
    return _registry


def init_registry(llm_fn: Optional[Callable] = None,
                  tools_dir: Optional[str] = None) -> ToolRegistry:
    """Initialise the singleton: scan + cache load + optional compile.

    Call this once at startup (from AIChat.__init__ or equivalent).
    """
    global _registry
    _registry = ToolRegistry(tools_dir=tools_dir)
    _registry.scan()
    _registry.load_from_cache()
    if llm_fn is not None:
        _registry.compile_categories(llm_fn)
    return _registry

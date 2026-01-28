#!/usr/bin/env python3
"""
SearXNG-based web search tool.

This tool uses SearXNG (a metasearch engine) to perform web searches.
It automatically starts the SearXNG docker container if not running.
"""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Any, Optional

import requests

from appdirs import user_data_dir


class SearXNGClient:
    """SearXNG client with auto-start functionality"""

    def __init__(self):
        self._config_dir = Path(user_data_dir("zai", "zighouse"))
        self._settings_path = self._config_dir / "searxng-settings.yaml"
        self._startup_script = self._config_dir / "start-searxng.sh"
        self._base_url = "http://127.0.0.1:8080"
        self._container_name = "searxng-agent"

    def _is_container_running(self) -> bool:
        """Check if SearXNG container is running"""
        try:
            result = subprocess.run(
                ["docker", "ps", "--filter", f"name={self._container_name}", "--format", "{{.Names}}"],
                capture_output=True,
                text=True,
                timeout=5
            )
            return self._container_name in result.stdout
        except Exception as e:
            print(f"Failed to check container status: {e}", file=sys.stderr)
            return False

    def _start_container(self) -> bool:
        """Start SearXNG docker container"""
        if not self._startup_script.exists():
            print(f"SearXNG startup script not found at {self._startup_script}", file=sys.stderr)
            return False

        try:
            # Make the script executable
            os.chmod(self._startup_script, 0o755)

            # Run the startup script from the config directory
            result = subprocess.run(
                [str(self._startup_script)],
                cwd=str(self._config_dir),
                capture_output=True,
                text=True,
                timeout=30
            )

            if result.returncode != 0:
                print(f"Failed to start SearXNG container: {result.stderr}", file=sys.stderr)
                return False

            # Wait for the service to be ready
            for _ in range(10):
                time.sleep(1)
                try:
                    response = requests.get(f"{self._base_url}/config", timeout=2)
                    if response.status_code == 200:
                        return True
                except requests.RequestException:
                    continue

            print("SearXNG container started but service not responding", file=sys.stderr)
            return False

        except subprocess.TimeoutExpired:
            print("Timeout starting SearXNG container", file=sys.stderr)
            return False
        except Exception as e:
            print(f"Error starting SearXNG container: {e}", file=sys.stderr)
            return False

    def _ensure_container_running(self) -> bool:
        """Ensure SearXNG container is running"""
        if self._is_container_running():
            return True
        print("SearXNG container not running, starting...", file=sys.stderr)
        return self._start_container()

    def search(
        self,
        query: str,
        categories: Optional[List[str]] = None,
        engines: Optional[List[str]] = None,
        language: str = "auto",
        time_range: Optional[str] = None,
        safesearch: int = 0,
        page: int = 1
    ) -> Dict[str, Any]:
        """
        Perform a search using SearXNG

        Args:
            query: Search query
            categories: List of categories to search (e.g., ['general', 'images'])
            engines: List of specific engines to use
            language: Language code (e.g., 'en', 'zh', 'auto')
            time_range: Time range filter ('day', 'week', 'month', 'year')
            safesearch: Safe search level (0, 1, 2)
            page: Page number

        Returns:
            Dict with search results
        """
        if not self._ensure_container_running():
            return {
                "error": "Failed to start SearXNG container",
                "results": []
            }

        params = {
            "q": query,
            "format": "json",
            "language": language,
            "safesearch": safesearch,
            "pageno": page
        }

        if categories:
            params["categories"] = ",".join(categories)
        if engines:
            params["engines"] = ",".join(engines)
        if time_range:
            params["time_range"] = time_range

        try:
            response = requests.get(
                f"{self._base_url}/search",
                params=params,
                timeout=15,
                headers={"Accept": "application/json"}
            )
            response.raise_for_status()
            return response.json()

        except requests.RequestException as e:
            return {
                "error": f"Search request failed: {str(e)}",
                "results": []
            }
        except json.JSONDecodeError as e:
            return {
                "error": f"Failed to parse JSON response: {str(e)}",
                "results": []
            }


_global_client: Optional[SearXNGClient] = None


def get_searxng_client() -> SearXNGClient:
    """Get or create global SearXNG client"""
    global _global_client
    if _global_client is None:
        _global_client = SearXNGClient()
    return _global_client


def _format_results_to_markdown(results: Dict[str, Any], max_results: int = 10) -> str:
    """Format SearXNG results to markdown"""
    if "error" in results:
        return f"Error: {results['error']}"

    answers = results.get("answers", [])
    results_list = results.get("results", [])
    infoboxes = results.get("infoboxes", [])

    # Limit results
    results_list = results_list[:max_results]

    output_lines = []

    # Add answers if available
    if answers:
        output_lines.append("## Answers")
        for answer in answers:
            output_lines.append(f"- {answer.get('content', '')}")
        output_lines.append("")

    # Add infoboxes if available
    if infoboxes:
        output_lines.append("## Infoboxes")
        for infobox in infoboxes:
            title = infobox.get("title", "Infobox")
            content = infobox.get("content", "")
            if content:
                output_lines.append(f"### {title}")
                output_lines.append(content)
            # Add infobox attributes
            for attr in infobox.get("attributes", []):
                label = attr.get("label", "")
                value = attr.get("value", "")
                if label and value:
                    output_lines.append(f"- **{label}**: {value}")
            output_lines.append("")

    # Add search results
    if results_list:
        output_lines.append("## Search Results")
        for i, result in enumerate(results_list, 1):
            title = result.get("title", "No title")
            url = result.get("url", "")
            content = result.get("content", "")
            engine = result.get("engine", "")
            score = result.get("score", 0)

            # Format title with link
            if url:
                output_lines.append(f"{i}. [{title}]({url})")
            else:
                output_lines.append(f"{i}. {title}")

            # Add content if available
            if content:
                # Clean up content
                content = re.sub(r'\s+', ' ', content).strip()
                output_lines.append(f"   {content}")

            # Add metadata
            metadata_parts = []
            if engine:
                metadata_parts.append(f"Source: {engine}")
            if score:
                metadata_parts.append(f"Score: {score:.2f}")

            if metadata_parts:
                output_lines.append(f"   *{' | '.join(metadata_parts)}*")

            output_lines.append("")

    return "\n".join(output_lines).strip()


def _format_results_to_links(results: Dict[str, Any], max_results: int = 10) -> str:
    """Format SearXNG results to links list"""
    if "error" in results:
        return f"Error: {results['error']}"

    results_list = results.get("results", [])[:max_results]

    if not results_list:
        return "No results found."

    output_lines = [f"Found {len(results_list)} results:\n"]

    for i, result in enumerate(results_list, 1):
        title = result.get("title", "No title")
        url = result.get("url", "")
        if url:
            output_lines.append(f"{i}. {title}: {url}")
        else:
            output_lines.append(f"{i}. {title}")

    return "\n".join(output_lines)


def invoke_web_search(
    request: str,
    engine: str = "",
    category: str = "",
    time_range: str = "",
    language: str = "auto",
    safesearch: int = 0,
    max_results: int = 10,
    return_format: str = "markdown"
) -> str:
    """
    Execute web search using SearXNG

    Args:
        request: Search query
        engine: Specific search engine to use (empty for auto selection)
        category: Search category (e.g., 'general', 'images', 'videos', 'news')
        time_range: Time range filter ('day', 'week', 'month', 'year')
        language: Language code (e.g., 'en', 'zh', 'auto')
        safesearch: Safe search level (0=off, 1=moderate, 2=strict)
        max_results: Maximum number of results to return
        return_format: Output format ('markdown', 'links', 'html', 'json')

    Returns:
        Formatted search results
    """
    client = get_searxng_client()

    # Build categories list
    categories = [category] if category else None

    # Build engines list
    engines = [engine] if engine else None

    # Perform search
    results = client.search(
        query=request,
        categories=categories,
        engines=engines,
        language=language,
        time_range=time_range or None,
        safesearch=safesearch
    )

    # Format output
    if return_format == "json":
        return json.dumps(results, indent=2, ensure_ascii=False)
    elif return_format == "links":
        return _format_results_to_links(results, max_results)
    elif return_format == "markdown":
        return _format_results_to_markdown(results, max_results)
    elif return_format == "html":
        if "error" in results:
            return f"<p>Error: {results['error']}</p>"
        # Simple HTML formatting
        results_list = results.get("results", [])[:max_results]
        html_parts = ["<ul>"]
        for result in results_list:
            title = result.get("title", "No title")
            url = result.get("url", "")
            content = result.get("content", "")
            if url:
                html_parts.append(f'<li><a href="{url}">{title}</a>')
            else:
                html_parts.append(f"<li>{title}")
            if content:
                html_parts.append(f"<p>{content}</p>")
            html_parts.append("</li>")
        html_parts.append("</ul>")
        return "\n".join(html_parts)
    else:
        return _format_results_to_markdown(results, max_results)

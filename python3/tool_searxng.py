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

    def _create_default_templates(self) -> bool:
        """Create default startup script and settings template"""
        try:
            # Ensure config directory exists
            self._config_dir.mkdir(parents=True, exist_ok=True)

            # Create default settings.yaml if not exists
            if not self._settings_path.exists():
                default_settings = """# SearXNG 配置文件
# 这是自动生成的默认配置，您可以根据需要修改

general:
  instance_name: "SearXNG"
  debug: false
  enable_metrics: true
  privacypolicy_url: false
  donation_url: false
  contact_url: false

brand:
  new_issue_url: https://github.com/searxng/searxng/issues/new
  docs_url: https://docs.searxng.org/
  public_instances: https://searx.space
  wiki_url: https://github.com/searxng/searxng/wiki
  issue_url: https://github.com/searxng/searxng/issues

search:
  safe_search: 0
  autocomplete: ""
  autocomplete_min: 4
  favicon_resolver: ""
  default_lang: "auto"
  ban_time_on_fail: 300
  max_ban_time_on_fail: 120
  formats:
    - json
  timeout: 10.0

server:
  port: 8080
  bind_address: "127.0.0.1"
  base_url: false
  limiter: false
  public_instance: false
  secret_key: "CHANGE_THIS_SECRET_KEY_IN_PRODUCTION"
  image_proxy: false
  http_protocol_version: "1.0"
  method: "GET"
  default_http_headers:
    X-Content-Type-Options: nosniff
    X-Download-Options: noopen
    X-Robots-Tag: noindex, nofollow
    Referrer-Policy: no-referrer

ui:
  static_path: ""
  templates_path: ""
  query_in_title: false
  default_theme: simple
  center_alignment: false
  default_locale: ""
  theme_args:
    simple_style: auto
  search_on_category_select: true
  hotkeys: default
  url_formatting: pretty
  enabled: false

outgoing:
  request_timeout: 10.0
  useragent_suffix: ""
  pool_connections: 100
  pool_maxsize: 20
  enable_http2: true
  # proxies:
  #   all://:
  #     - http://127.0.0.1:7890

plugins:
  searx.plugins.calculator.SXNGPlugin:
    active: true
  searx.plugins.hash_plugin.SXNGPlugin:
    active: true
  searx.plugins.self_info.SXNGPlugin:
    active: true
  searx.plugins.unit_converter.SXNGPlugin:
    active: true
  searx.plugins.ahmia_filter.SXNGPlugin:
    active: true
  searx.plugins.hostnames.SXNGPlugin:
    active: true
  searx.plugins.time_zone.SXNGPlugin:
    active: true
  searx.plugins.tracker_url_remover.SXNGPlugin:
    active: true

checker:
  off_when_debug: true

categories_as_tabs: {}

engines:
  - name: bing
    engine: bing
    shortcut: b

  - name: duckduckgo
    engine: duckduckgo
    shortcut: d

  - name: brave
    engine: brave
    shortcut: br

  - name: startpage
    engine: startpage
    shortcut: sp

  - name: yandex
    engine: yandex
    shortcut: y

  - name: baidu
    engine: baidu
    shortcut: bd

  - name: qwant
    engine: qwant
    shortcut: qw
    qwant_categ: web
    categories: [general, web]

  - name: google
    engine: google
    shortcut: g

  - name: wikipedia
    engine: wikipedia
    shortcut: wp
    display_type: ["infobox"]

doi_resolvers:
  oadoi.org: 'https://oadoi.org/'
  doi.org: 'https://doi.org/'

default_doi_resolver: 'oadoi.org'
"""
                self._settings_path.write_text(default_settings, encoding='utf-8')
                print(f"[SearXNG] 已创建默认配置文件: {self._settings_path}", file=sys.stderr)

            # Create default startup script if not exists
            if not self._startup_script.exists():
                default_script = """#!/bin/bash
# SearXNG 启动脚本
# 该脚本会启动 SearXNG docker 容器

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 移除已存在的容器（如果存在）
docker rm -f searxng-agent 2>/dev/null

# 启动新的 SearXNG 容器
docker run -d \\
  --name searxng-agent \\
  --network host \\
  -e "SEARXNG_BASE_URL=http://localhost:8080/" \\
  -e "SEARXNG_SECRET_KEY=$(openssl rand -hex 32)" \\
  -e "SEARXNG_DISABLE_UI=true" \\
  -e "SEARXNG_SEARCH_FORMATS=json" \\
  -v "${SCRIPT_DIR}/searxng-settings.yaml:/etc/searxng/settings.yml:ro" \\
  searxng/searxng:latest

# 如果需要容器自动重启，可以取消下面这行的注释：
# --restart unless-stopped \\

# 等待容器启动
sleep 3

# 显示容器日志
docker logs searxng-agent --tail 20
"""
                self._startup_script.write_text(default_script, encoding='utf-8')
                # Make the script executable
                os.chmod(self._startup_script, 0o755)
                print(f"[SearXNG] 已创建启动脚本: {self._startup_script}", file=sys.stderr)

            return True

        except Exception as e:
            print(f"[SearXNG] 创建模板文件失败: {e}", file=sys.stderr)
            return False

    def _start_container(self) -> bool:
        """Start SearXNG docker container"""
        # Create default templates if not exist
        if not self._startup_script.exists() or not self._settings_path.exists():
            print("[SearXNG] 未找到启动脚本或配置文件，正在创建默认模板...", file=sys.stderr)
            if not self._create_default_templates():
                return False
            print("[SearXNG] 模板创建完成，正在启动容器...", file=sys.stderr)

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

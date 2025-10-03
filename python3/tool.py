#!/usr/bin/env python3
import json
import re
from pathlib import Path
from typing import Dict, List, Any, Union, Optional
from appdirs import user_data_dir

class ToolManager:

    def __init__(self):
        self._toolsets = {}

    def _load_tool_file(self):
        current_dir = Path(__file__).parent
        config_path = current_dir / 'tool_file.json'
        return json.loads(config_path.read_text(encoding='utf-8'))

    def get_tools(self):
        tools = []
        for k,v in self._toolsets.items():
            tools.extend(v)
        return tools

    def call_tool(self, function_name, arguments):
        # File tools
        if 'file' in self._toolsets:
            if function_name == "mkdir":
                from tool_file import mkdir
                return mkdir(**arguments)
            elif function_name == "write_file":
                from tool_file import write_file
                return write_file(**arguments)
            elif function_name == "read_file":
                from tool_file import read_file
                return read_file(**arguments)
            elif function_name == "copy_file":
                from tool_file import copy_file
                return copy_file(**arguments)
            elif function_name == "ls":
                from tool_file import ls
                return ls(**arguments)

        # Web tools
        if 'web' in self._toolsets:
            if function_name == "get_content":
                from tool_web import get_content
                return get_content(**arguments)
            elif function_name == "search":
                from tool_web import search
                return search(**arguments)
            elif function_name == "parse_links":
                from tool_web import parse_links
                return parse_links(**arguments)

        raise Exception(f"Unknown tool function `{function_name}`")

    def use_tool(self, tool_spec: Union[str, Dict[str, List[str]]]) -> bool:
        """
        使用工具集或特定工具

        Args:
            tool_spec: 工具规范，可以是：
                - 字符串：工具集名称，如 'file'，引入整个工具集
                - 字典：{工具集名: [工具名列表]}，如 {'file': ['read_file', 'write_file']}

        Returns:
            bool: 是否成功加载
        """
        if isinstance(tool_spec, str):
            # introduce whole toolset.
            toolset_name = tool_spec
            toolset_path = Path(__file__).parent / f'tool_{toolset_name}.json'
            try:
                if config := json.loads(toolset_path.read_text(encoding='utf-8')):
                    self._toolsets[toolset_name] = config
                    return True
                return False
            except Exception as e:
                print(f"Unknown toolset `{toolset_name}`: {e}.")
                return False

        elif isinstance(tool_spec, dict):
            # introduce specfied tools
            success = True
            for toolset_name, tool_names in tool_spec.items():
                toolset_path = Path(__file__).parent / f'tool_{toolset_name}.json'
                try:
                    full_toolset = json.loads(toolset_path.read_text(encoding='utf-8'))
                    # select tools from toolset
                    selected_tools = [tool for tool in full_toolset if tool.get('function') and tool['function'].get('name') in tool_names]
                    if selected_tools:
                        if toolset_name not in self._toolsets:
                            self._toolsets[toolset_name] = []
                        # avoid duplicates
                        inlist_names = [tool['function']['name'] for tool in self._toolsets[toolset_name]]
                        for tool in selected_tools:
                            if tool['function']['name'] not in inlist_names:
                                self._toolsets[toolset_name].append(tool)
                    else:
                        print(f"No matching tools found in toolset `{toolset_name}` for {tool_names}")
                        success = False
                except Exception as e:
                    print(f"Failed to load toolset `{toolset_name}`: {e}")
                    success = False
            return success
        else:
            print("Invalid tool specification. Must be string (toolset name) or dict ({toolset: [tools]})")
            return False

    def show_tools(self):
        """
        显示当前已加载的工具，格式如：
        file : read_file, write_file
        dict : read, write
        """
        if not self._toolsets:
            print("No tools loaded.")
            return

        for toolset_name, tools in self._toolsets.items():
            tool_names = []
            for tool in tools:
                if tool.get('function') and tool['function'].get('name'):
                    tool_names.append(tool['function']['name'])

            if tool_names:
                print(f"  {toolset_name} : {', '.join(tool_names)}")

    def use_toolset(self, toolset_name: str) -> bool:
        return self.use_tool(toolset_name)

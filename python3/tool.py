#!/usr/bin/env python3
import json
import re
from pathlib import Path
from typing import Dict, List, Any, Union, Optional
from appdirs import user_data_dir

class ToolManager:

    def __init__(self):
        self._toolsets = {}

    def _load_toolset(self, toolset_name: str) -> List[Dict[str, Any]]:
        toolset_path = Path(__file__).parent / f'tool_{toolset_name}.json'
        try:
            return json.loads(toolset_path.read_text(encoding='utf-8'))
        except Exception as e:
            print(f"Unknown toolset `{toolset_name}`: {e}.")
            return {}

    def get_tools(self, excludes=[]):
        tools = []
        exclude_names = []
        for ex in excludes:
            if 'function' in ex and 'name' in ex['function']:
                exclude_names.append(ex['function']['name'])
        for k,v in self._toolsets.items():
            if not exclude_names:
                tools.extend(v)
            else:
                for it in v:
                    if 'function' in it and 'name' in it['function'] and it['function']['name'] not in exclude_names:
                        tools.append(it)
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

        # OS tools
        if 'os' in self._toolsets:
            if function_name == "os_get_info":
                from tool_os import os_tools
                result = os_tools(**arguments)
                if isinstance(result, str):
                    return result
                return json.dumps(result, indent=2, ensure_ascii=False)

        # AI tools
        if 'ai' in self._toolsets:
            if function_name == "generate_image":
                from tool_ai import generate_image
                result = generate_image(**arguments)
                if isinstance(result, str):
                    return result
                return json.dumps(result, indent=2, ensure_ascii=False)

        raise Exception(f"Unknown tool function `{function_name}`")

    def list_toolsets(self) -> List[str]:
        current_dir = Path(__file__).parent
        tool_files = list(current_dir.glob('tool_*.json'))
        toolsets = []

        for tool_file in tool_files:
            match = re.match(r'tool_(.+)\.json', tool_file.name)
            if match:
                toolsets.append(match.group(1))

        return sorted(toolsets)

    def show_list(self):
        tools = self.list_toolsets()
        if tools:
            for name in tools:
                print(f"  - {name}")

    def show_toolset(self, toolset_name: Optional[str] = None):
        """
        显示工具集详情

        Args:
            toolset_name: 工具集名称，如果为None则显示所有已应用的工具集
        """
        if toolset_name is None:
            # 显示所有已应用的工具集
            if not self._toolsets:
                print("No tools loaded.")
                return

            for toolset_name, tools in self._toolsets.items():
                print(f"\n{toolset_name}:")
                tool_names = []
                for tool in tools:
                    if tool.get('function') and tool['function'].get('name'):
                        tool_names.append(tool['function']['name'])

                if tool_names:
                    # 对已选中的方法添加勾选标记
                    checked_names = [f"✓ {name}" for name in tool_names]
                    print(f"  {', '.join(checked_names)}")
        else:
            # 显示指定工具集
            current_dir = Path(__file__).parent
            toolset_path = current_dir / f'tool_{toolset_name}.json'

            if not toolset_path.exists():
                print(f"Toolset `{toolset_name}` not found.")
                return

            try:
                full_toolset = json.loads(toolset_path.read_text(encoding='utf-8'))
                print(f"\n{toolset_name}:")

                # 获取当前已选中的方法
                selected_methods = set()
                if toolset_name in self._toolsets:
                    for tool in self._toolsets[toolset_name]:
                        if tool.get('function') and tool['function'].get('name'):
                            selected_methods.add(tool['function']['name'])

                # 显示所有方法，对已选中的添加勾选
                for tool in full_toolset:
                    if tool.get('function') and tool['function'].get('name'):
                        method_name = tool['function']['name']
                        if method_name in selected_methods:
                            print(f" -  [ ✓ ] {method_name}")
                        else:
                            print(f" -  [   ] {method_name}")

            except Exception as e:
                print(f"Failed to load toolset `{toolset_name}`: {e}")

    def use_tool(self, tool_spec: Union[str, List[str], Dict[str, List[str]]]) -> bool:
        """
        使用工具集或特定工具

        Args:
            tool_spec: 工具规范，可以是：
                - 字符串：'XXX' 工具集名称，如 'file'，引入整个工具集
                          'XXX.xxx' 指定工具集中的具体工具
                - 字符串列表：['XXX'], ['XXX.xxx'], ['XXX:', 'xxx', 'yyy', 'zzz']
                - 字典：{工具集名: [工具名列表]}，如 {'file': ['read_file', 'write_file']}

        Returns:
            bool: 是否成功加载
        """
        if isinstance(tool_spec, str):
            if '.' in tool_spec:
                toolset_name, tool_candidate = tool_spec.split('.', 1)
            else:
                toolset_name = tool_spec
                tool_candidate = '' # introduce whole toolset.
            config = self._load_toolset(toolset_name)
            if not config:
                return False
            if not tool_candidate:
                self._toolsets[toolset_name] = config
            elif tool_candidate in config:
                self._toolsets[toolset_name] = [config.get(tool_candidate)]
            return True

        elif isinstance(tool_spec, list):
            tools_map = {}
            toolset_name = None
            tool_candidates = []
            for item in tool_spec:
                if isinstance(item, str):
                    if item.endswith(':'):
                        if toolset_name is not None:
                            if toolset_name not in tools_map:
                                tools_map[toolset_name] = []
                            tools_map[toolset_name].extend(tool_candidates)
                        toolset_name = item.rstrip(':')
                        tool_candidates = []
                    elif '.' in item:
                        if toolset_name is not None:
                            if toolset_name not in tools_map:
                                tools_map[toolset_name] = []
                            tools_map[toolset_name].extend(tool_candidates)
                        toolset_name, tool_candidate = item.split('.', 1)
                        if toolset_name not in tools_map:
                            tools_map[toolset_name] = []
                        tools_map[toolset_name].append(tool_candidate)
                    else:
                        if toolset_name is not None:
                            tool_candidates.append(item)
                        else:
                            toolset_name = item
                            tool_candidates = [tool['function']['name'] for tool in self._load_toolset(item) if 'function' in tool and 'name' in tool['function']]
            if toolset_name is not None:
                if toolset_name not in tools_map:
                    tools_map[toolset_name] = []
                tools_map[toolset_name].extend(tool_candidates)
            return self.use_tool(tools_map)

        elif isinstance(tool_spec, dict):
            # introduce specfied tools
            success = True
            for toolset_name, tool_names in tool_spec.items():
                full_toolset = self._load_toolset(toolset_name)
                if full_toolset:
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

#!/usr/bin/env python3
import json
import re
import importlib
from pathlib import Path
from typing import Dict, List, Any, Union, Optional
from appdirs import user_data_dir

class ToolManager:
    """管理工具集，支持动态发现与调用"""

    def __init__(self):
        # toolset_name -> [tool_meta, ...]
        self._toolsets: Dict[str, List[Dict[str, Any]]] = {}

    # ----------- 内部工具 -----------
    def _load_toolset_meta(self, toolset_name: str) -> List[Dict[str, Any]]:
        """读取 tool_{name}.json 元信息"""
        toolset_path = Path(__file__).parent / f"tool_{toolset_name}.json"
        try:
            return json.loads(toolset_path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"[WARN] 无法加载 toolset `{toolset_name}`: {e}")
            return []

    def _ensure_toolset_module(self, toolset_name: str):
        """动态 import tool_{toolset_name} 模块，返回 module 对象"""
        # 已加载则直接返回
        if toolset_name in self._toolsets:
            return importlib.import_module(f"tool_{toolset_name}")
        raise RuntimeError(f"toolset `{toolset_name}` 尚未使用，无法调用其函数")

    def _find_toolset_by_function(self, function_name: str) -> Optional[str]:
        """根据函数名反查所属 toolset"""
        for toolset_name, tools in self._toolsets.items():
            for tool in tools:
                if tool.get("function", {}).get("name") == function_name:
                    return toolset_name
        return None

    def get_tools(self, excludes=[]) -> List[Dict[str, Any]]:
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

    def call_tool(self, function_name: str, arguments: dict) -> Any:
        """
        根据 function_name 动态调用对应 toolset 中的实现函数
        约定：每个 toolset 模块需提供 invoke_{function_name}(**arguments)
        """
        ts = self._find_toolset_by_function(function_name)
        if ts is None:
            raise RuntimeError(f"未知工具函数 `{function_name}`")
        mod = self._ensure_toolset_module(ts)
        invoker = getattr(mod, f"invoke_{function_name}", None)
        if invoker is None:
            raise RuntimeError(
                f"工具集 `{ts}` 中未找到实现函数 `invoke_{function_name}`"
            )
        result = invoker(**arguments)
        if isinstance(result, str):
            return result
        return json.dumps(result, indent=2, ensure_ascii=False)

    def list_toolsets(self) -> List[str]:
        """扫描当前目录下所有 tool_*.json，返回排序后的工具集名称列表"""
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
        加载工具集或指定工具，支持多种形式：
          字符串：
            'file'               -> 加载整个 file 工具集
            'file.mkdir'         -> 仅加载 file 工具集中的 mkdir
          列表：['file', 'web'] / ['file.mkdir'] / ['file:', 'mkdir', 'ls']
          字典：{'file': ['mkdir', 'ls'], 'web': ['search']}
        返回是否全部成功
        """
        # 统一转成 Dict[toolset_name, List[func_name]] 形式
        spec_map: Dict[str, List[str]] = {}

        if isinstance(tool_spec, str):
            if "." in tool_spec:
                ts, fn = tool_spec.split(".", 1)
                spec_map[ts] = [fn]
            else:
                spec_map[tool_spec] = []  # 全量

        elif isinstance(tool_spec, list):
            cur_ts = None
            for item in tool_spec:
                if item.endswith(":"):
                    cur_ts = item[:-1]
                    spec_map.setdefault(cur_ts, [])
                elif "." in item:
                    ts, fn = item.split(".", 1)
                    spec_map.setdefault(ts, []).append(fn)
                else:
                    # 纯函数名，要求 cur_ts 已存在
                    if cur_ts is None:
                        # 把 item 当成 toolset 全量加载
                        spec_map.setdefault(item, [])
                    else:
                        spec_map[cur_ts].append(item)

        elif isinstance(tool_spec, dict):
            spec_map = tool_spec
        else:
            print("[ERROR] 非法的 tool_spec 类型")
            return False

        # 真正加载
        ok = True
        for ts, funcs in spec_map.items():
            meta = self._load_toolset_meta(ts)
            if not meta:
                ok = False
                continue
            # 若 funcs 为空则代表全量
            if not funcs:
                selected = meta
            else:
                selected = [t for t in meta if t.get("function", {}).get("name") in funcs]
                miss = set(funcs) - {t.get("function", {}).get("name") for t in selected}
                if miss:
                    print(f"[WARN] toolset `{ts}` 中未找到函数: {miss}")
                    ok = False
            # 合并进 self._toolsets（去重）
            exist_names = {
                t.get("function", {}).get("name")
                for t in self._toolsets.setdefault(ts, [])
            }
            for t in selected:
                name = t.get("function", {}).get("name")
                if name and name not in exist_names:
                    self._toolsets[ts].append(t)
        return ok

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

#!/usr/bin/env python3
import json
import re
from pathlib import Path
from typing import Dict, List, Any, Union, Optional
from appdirs import user_data_dir

# json strings
_STRING_RE = re.compile(r'"(?:\\["\\/bfnrt]|\\u[0-9a-fA-F]{4}|[^"\\])*"')

# json comments
_COMMENT_RE = re.compile(r'//[^\n]*|/\*.*?\*/', re.S)

def _strip_comments(text: str) -> str:
    str_list: List[str] = []
    def placeholder(_m):
        str_list.append(_m.group(0))
        return f'\x00__STR_{len(str_list)-1}__\x00'
    masked = _STRING_RE.sub(placeholder, text)
    cleaned = _COMMENT_RE.sub('', masked)
    for idx, s in enumerate(str_list):
        cleaned = cleaned.replace(f'\x00__STR_{idx}__\x00', s)
    return cleaned

def _normalize_keys(obj: Any) -> Any:
    """filter keys and normalize `-` as `_`"""
    if isinstance(obj, list):
        return [_normalize_keys(item) for item in obj]
    elif isinstance(obj, dict):
        normalized = {}
        for key, value in obj.items():
            normalized_key = key.replace('-', '_') if isinstance(key, str) else key
            normalized[normalized_key] = _normalize_keys(value)
        return normalized
    else:
        return obj

def config_path_assistants() -> str:
    conf_dir = Path(user_data_dir("zai", "zighouse"))
    try:
        conf_dir.mkdir(parents=True, exist_ok=True)
        return conf_dir / "assistants.json"
    except:
        return "assistants.json"

class AIAssistantManager:
    def __init__(self):
        self._conf_path = self._get_config_path()
        self._provider_list = self._load(self._conf_path)
        self._provider = {}
        self._port = {}

    def _get_config_path(self) -> str:
        return config_path_assistants()

    def _load(self, path: str) -> List[Dict[str, Any]]:
        try:
            with open(path, "r", encoding="utf-8") as f:
                config_data = json.loads(_strip_comments(f.read()))
                return _normalize_keys(config_data)
        except Exception as e:
            print(f'load config error: {e}')
            return []

    def find_provider(self, name: str = '0') -> Dict[str, Any]:
        provider = {}
        if name.isdigit():
            id = int(name)
            if 0 <= id < len(self._provider_list):
                provider = self._provider_list[id].copy()
        else:
            for i in self._provider_list:
                if i.get('name') == name:
                    provider = i.copy()
                    break
        if 'name' in provider and 'base_url' in provider and 'model' in provider and len(provider['model']) > 0:
            return provider
        return {}

    def find_port(self, provider: Dict[str, Any], model: str) -> Dict[str, Any]:
        if provider:
            port = provider.copy()
            model_list = port.pop('model', [])
            if len(model_list):
                port['model'] = model_list[0]
                if model.isdigit():
                    id = int(model)
                    if 0 <= id < len(model_list):
                        port['model'] = model_list[id]
                elif model in model_list:
                    port['model'] = model
            return port
        return {}

    def get_provider(self) -> Dict[str, Any]:
        return self._provider.copy() if self._provider else {}

    def get_port(self) -> Dict[str, Any]:
        return self._port.copy() if self._port else {}

    def get_model(self) -> str:
        return self._port['model'] if self._port else ''

    def use_ai(self, name: Optional[str] = None, model: Optional[str] = None) -> bool:
        provider = {}
        port = {}
        if name:
            provider = self.find_provider(name)
            if provider:
                if model:
                    port = self.find_port(provider, model)
                else:
                    if self._port:
                        port = self.find_port(provider, self._port['model'])
                    if not port:
                        port = self.find_port(provider, '0')
                if not port:
                    return False # port not found
            else:
                return False # provider not found
        else:
            provider = self._provider
            if model:
                port = self.find_port(provider, model)
                if not port:
                    return False # port not found
            else:
                return False # invalid arguments
        if not port:
            return False
        if self._port and self._port['base_url'] == port['base_url'] \
                and self._port['api_key_name'] == port['api_key_name'] \
                and self._port['model'] == port['model']:
                    # perhaps config of the same port is modified.
                    self._provider = provider
                    self._port = port
                    # but should still return False with the same config.
                    return False
        # absolutely the port is changed after this use.
        self._provider = provider
        self._port = port
        return True

    def _reload(self) -> bool:
        list = self._load(self._get_config_path())
        if list:
            provider_name = self._provider['name'] if self._provider and 'name' in self._provider else '0'
            provider = self.find_provider(provider_name)
            model = self._port['model'] if self._port and 'model' in self._port else '0'
            port = self.find_port(provider, model)
            if port:
                self._provider = provider
                self._port = port
                return True
        return False

    def show_list(self):
        self._reload() # re-load the config to reflect the user's change.
        if self._provider_list:
            id = 0
            for provider in self._provider_list:
                if 'name' in provider:
                    print(f" {id} - {provider['name']}")
                    id = id + 1
            print(f"config: '{self._get_config_path()}'")
        else:
            print(f"no AI assistants configured, path: '{self._get_config_path()}'")

    def show_provider(self, provider: dict[str, Any], checked_model: Optional[str] = None, indent: int = 4) -> None:
        if not provider:
            return

        mapping = {k: v for k, v in provider.items() if k in
                      ['api_key_name', 'base_url', 'model', 'prompt',
                       'temperature', 'top_p', 'presence_penalty', 'frequency_panelty', 'logprobs' ]}
        model_list = mapping.pop('model', [])

        # Calculate width based on remaining keys
        width = max(len(k) for k in mapping) if mapping else 0
        sp = " " * indent
        inner_sp = sp + " " * (width + 3)  # extra indent

        # Print other fields first
        for k, v in mapping.items():
            head = f"{sp}{k:>{width}} - "
            print(f"{head}{v}")

        # Print model list with special formatting
        if model_list:
            head = f"{sp}{'model':>{width}} - "
            for idx, item in enumerate(model_list):
                prefix = head if idx == 0 else inner_sp

                if checked_model:
                    # Add checkmark if this checked_model matches the selected one
                    checkmark = "[ ✓ ]" if checked_model == item else "     "
                else:
                    checkmark = ""

                # Adjust spacing to maintain alignment
                aligned_idx = f"{idx}." if idx < 10 else f"{idx}"
                print(f"{prefix}{checkmark}{aligned_idx:>3} {item}")


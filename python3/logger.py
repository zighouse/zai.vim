#!/usr/bin/env python3
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any
from appdirs import user_data_dir

def get_char_width(char):
    # 基本多文种平面（BMP）中的全角字符
    if ord(char) >= 0x4E00 and ord(char) <= 0x9FFF:  # CJK统一汉字
        return 2
    elif ord(char) >= 0x3040 and ord(char) <= 0x30FF:  # 日文假名
        return 2
    elif ord(char) >= 0xAC00 and ord(char) <= 0xD7AF:  # 韩文
        return 2
    elif ord(char) >= 0xFF00 and ord(char) <= 0xFFEF:  # 全角符号
        return 2
    else:
        return 1

def truncate_by_width(text, max_width, suffix="..."):
    suffix_width = sum(get_char_width(c) for c in suffix)
    current_width = 0
    result_chars = []
    for char in text:
        char_width = get_char_width(char)
        if current_width + char_width > max_width - suffix_width:
            break
        result_chars.append(char)
        current_width += char_width
    return ''.join(result_chars) + suffix

class Logger:
    def __init__(self):
        self._verbose = True
        self._enable = True
        self._log_path = None
        self._messages = []
        self._system_message = ''
        self._file = None
        self._error = False

    def set_verbose(self, verbose: bool):
        self._verbose = verbose

    def is_verbose(self) -> bool:
        return self._verbose

    def set_enable(self, enable: bool):
        self._enable = enable

    def is_enable(self) -> bool:
        return self._enable and self._log_path is not None

    def log_system(self, message: str):
        self._system_message = message.strip()

    def open(self, log_dir: str = '', filename: str = '') -> bool:
        if not self._enable:
            self._log_path = None
            return True
        if not log_dir:
            log_dir = Path(user_data_dir("zai", "zighouse")) / "log"
        try:
            if isinstance(log_dir, str):
                log_dir = Path(log_dir)
            log_dir.mkdir(parents=True, exist_ok=True)
            if not filename:
                log_filename = datetime.now().strftime("%Y%m%d_%H%M%S") + '.md'
            else:
                log_filename = filename
            self._log_path = log_dir / log_filename
            self._error = False
            return True

        except Exception as e:
            print(f"Failed initializing log file, error: {e}", file=sys.stderr)
            self._log_path = None
            return False

    def close(self):
        if self._file:
            self._file.close()
        self._file = None

    def get_path(self) -> str:
        if self._log_path:
            return self._log_path.absolute()
        return ''

    def _save_msg(self, msg: Dict[str, Any]):
        if self.is_enable() and self._file is not None:
            begins_small = False
            try:
                self._file.write(f"**{msg['role'].capitalize()}:**\n")
                params = {}
                for k,v in msg.items():
                    if k not in ['role', 'content', 'files', 'reasoning_content', 'tool_call_id', 'name', 'tool_calls', 'stop']:
                        params[k] = v
                if params or 'files' in msg:
                    self._file.write(f"<small>\n")
                    begins_small = True
                    for k,v in params.items():
                        if isinstance(v, str) and "\n" in v:
                            self._file.write(f"  - {k.replace('_','-')}:<<EOF\n{v}\nEOF\n")
                        else:
                            self._file.write(f"  - {k.replace('_','-')}: {v}\n")
                    if 'files' in msg:
                        self._file.write("  - attachments:\n")
                        for file in msg['files']:
                            self._file.write(f"    - {file['full_path']}\n")
                if begins_small:
                    self._file.write(f"</small>\n")
                    begins_small = False
                if 'reasoning_content' in msg:
                    self._file.write(f"<think>\n{''.join(msg['reasoning_content'])}\n</think>\n")
                if 'tool_calls' in msg:
                    self._file.write(f"{msg['content']}\n")
                    tool_calls = msg.get('tool_calls')
                    self._file.write("\n<tool_calls>\n")
                    for tool_call in tool_calls:
                        if 'function' in tool_call:
                            function = tool_call['function']
                            self._file.write(f"  - function: {function.get('name')} ({function.get('arguments')})\n")
                    self._file.write(f"\n</tool_calls>\n\n")
                if 'tool_call_id' in msg:
                    self._file.write("\n<tool_call>\n")
                    self._file.write(f"  - tool_call_id: {msg.get('tool_call_id')}\n")
                    self._file.write(f"  - name: {msg.get('name')}\n")
                    self._file.write(f"  - content:<<CONTENT_EOF\n")
                    self._file.write(f"{msg['content']}\nCONTENT_EOF\n\n")
                    self._file.write("</tool_call>\n\n")

                if not 'tool_call_id' in msg and not 'tool_calls' in msg:
                    self._file.write(f"{msg['content']}\n\n")
            except Exception as e:
                print(f"Error saving log into {self._log_path}: {e}", file=sys.stderr)

    def _ensure_file(self) -> bool:
        if self.is_enable():
            if self._file is None and not self._error:
                try:
                    self._file = open(self._log_path, "a", encoding="utf-8")
                    if self._system_message:
                        self._file.write(f"**System:**\n{self._system_message}\n\n")
                    for msg in self._messages:
                        self._save_msg(msg)
                except Exception as e:
                    print(f"Failed initializing log file {self._log_path}, error: {e}", file=sys.stderr)
                    self._file = None
                    self._error = True
                    return False
            return True
        else:
            return False

    def append_message(self, msg: Dict[str, Any]):
        if self._ensure_file():
            self._save_msg(msg)
            if msg['role'] != 'user':
                try:
                    self._file.flush()
                except:
                    pass
                if self.is_verbose():
                    if 'tool_calls' in msg:
                        for tool_call in msg['tool_calls']:
                            if 'function' in tool_call:
                                function = tool_call['function']
                                name = function.get('name')
                                args = truncate_by_width(function.get('arguments'), 80)
                                print(f"\n  - **tool call**: `{name}` ({args})")
                    elif 'tool_call_id' in msg:
                        print(f"  - return: `{msg.get('name')}`\n")
                    else:
                        print("\n<small>")
                        for k in msg:
                            if k not in ['role', 'content', 'reasoning_content', 'tool_call_id', 'name', 'tool_calls', 'stop']:
                                if isinstance(msg[k], str) and "\n" in msg[k]:
                                    print(f"  - {k.replace('_','-')}:<<EOF\n{msg[k]}\nEOF\n")
                                else:
                                    print(f"  - {k.replace('_','-')}: {msg[k]}")
                        print("</small>")
                        print(f"\nSaved log: {self._log_path}")
        self._messages.append(msg)

    def append_error(self, error: Exception):
        if self.is_enable() and self._file is not None:
            self._file.write(f"**Error:**\n{error}\n\n")
        return self._messages[-1]

    def load_history(self, file: str) -> List[Dict[str, Any]]:
        """load log file into new context"""
        load_messages = []
        message = {}
        if not os.path.exists(file):
            log_dir = os.path.dirname(self.get_path())
            os.path.join(log_dir, file)
            if os.path.exists(temp):
                file = temp
        with open(file, "r", encoding="utf-8") as log_file:
            text_list = []
            caption = ""
            small_start = 0
            for line in log_file:
                text = line.rstrip()
                print(text)
                if text == "**System:**":
                    if caption == "":
                        caption = "System"
                        message = {'role': 'system'}
                        text_list = []
                        small_start = 0
                elif text == "**User:**":
                    if caption in ["System", "Assistant"]:
                        message['content'] = '\n'.join(text_list)
                        load_messages.append(message)
                        message = {'role': 'user'}
                        caption = "User"
                        text_list = []
                        small_start = 0
                elif text == "**Assistant:**":
                    if caption == "User":
                        message['content'] = '\n'.join(text_list)
                        load_messages.append(message)
                        message = {'role': 'assistant'}
                        caption = "Assistant"
                        text_list = []
                        small_start = 0
                elif text == "<small>":
                    small_start = 1
                elif text == "</small>":
                    small_start = 0
                elif small_start == 0:
                    text_list.append(text)
                elif small_start == 1:
                    text = text.strip()
                    if text.startswith("- time: "):
                        message["time"] = text[8:]
                    elif text.startswith("- base-url: "):
                        message["base-url"] = text[12:]
                    elif text.startswith("- model: "):
                        message["model"] = text[9:]
            if caption != "":
                message['content'] = '\n'.join(text_list)
                load_messages.append(message)
                for msg in load_messages:
                    self.append_message(msg)
                log_dir = os.path.dirname(self.get_path())
                if not os.path.exists(log_dir):
                    os.makedirs(log_dir)
                log_filename = datetime.now().strftime("%Y%m%d_%H%M%S.md")
                self.open(log_dir, log_filename)
            else:
                print(f"\n===============\nERROR loading an invalid Zai log file:\n  {file}\n")
        return load_messages


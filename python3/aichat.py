import argparse
import json
import os
import random
import sys
import time
import chardet

from datetime import datetime
from openai import OpenAI, BadRequestError, APIError, APIConnectionError, RateLimitError
from pathlib import Path
from typing import Dict, List, Any, Union, Optional

from config import AIAssistantManager, parse_number_from_readable
from logger import Logger
from tool import ToolManager
from tool_shell import invoke_shell_sandbox_info, invoke_shell_cleanup, invoke_execute_shell
from client import Client
from tokens import AITokenizer

# Default values
_DEFAULT_API_KEY_NAME = "DEEPSEEK_API_KEY"
_DEFAULT_BASE_URL = "https://api.deepseek.com"
_DEFAULT_MODEL = "deepseek-chat"

class AIChat:
    def __init__(self):
        self._cli = Client()
        self._logger = Logger()
        self._aiconfig = AIAssistantManager()
        self._assistant = None
        self._tool = ToolManager()
        self._system_prompt = ""
        self._history = [] # [{request:msg, response:[msg]}]
        self._cur_round = {"request":[], "response":[]}
        self._llm = None
        self._files = []
        self._config = { 'model': {'name':'deepseek-chat'} }
        self._tokenizer = AITokenizer()
        if 'zh' in os.getenv('LANG', '') or 'zh' in os.getenv('LANGUAGE', ''):
            self._system_prompt = '作为一名严格的编程、软件工程与计算机科学助手，将遵循以下步骤处理每个问题：\n 1. 识别核心问题；\n 2. 提供兼顾可行性与工程实践的解决方案。'
            self._prompt_for_title = '\n此外，请在你的回答末尾，单独一行以“### 建议标题：[简洁标题]”的格式提供一个标题总结本次对话的核心，越短越好，尽量不要超过 30 字。'
        else:
            self._system_prompt = 'You are a strict assistant in programming, software engineering and computer science. For each query:\n 1. Identify key issues.\n 2. Propose solutions with pragmatical considerations.'
            self._prompt_for_title = '\nAdditionally, please provide a line for title in English at the end of your response in the format "### Title: [concise title]" to summarize the core suggestion.'

        self._cli.register("base_url", lambda v: self.set_config("base_url", v))
        self._cli.register("api_key_name", lambda v: self.set_config("api_key_name", v))
        self._cli.register("model", self._on_set_model)
        self._cli.register("no_log", lambda: self._logger.set_enable(False))
        self._cli.register("-no_log", lambda: self._logger.set_enable(True))
        self._cli.register("talk_mode", lambda v: self.set_config("talk_mode", v))
        self._cli.register("-talk_mode", lambda: self._config.pop("talk_mode", None))
        self._cli.register("complete_type", lambda v: self.set_config("complete_type", v))
        self._cli.register("-complete_type", lambda: self._config.pop("complete_type", None))
        self._cli.register("prefix", lambda v: self.set_config("prefix", v.strip()), use_raw_cmd=True)
        self._cli.register("-prefix", lambda: self._config.pop("prefix", None))
        self._cli.register("suffix", lambda v: self.set_config("suffix", v.strip()), use_raw_cmd=True)
        self._cli.register("-suffix", lambda: self._config.pop("suffix", None))
        self._cli.register("temperature", lambda v: self.set_config("temperature", float(v)))
        self._cli.register("-temperature", lambda: self._config.pop("temperature", None))
        self._cli.register("top_p", lambda v: self._config.pop("top_p", None))
        self._cli.register("-top_p", lambda: self.set_config("top_p", float(v)))
        self._cli.register("presence_penalty", lambda v: self.set_config("presence_penalty", float(v)))
        self._cli.register("-presence_penalty", lambda: self._config.pop("presence_penalty", None))
        self._cli.register("frequence_penalty", lambda v: self.set_config("frequence_penalty", float(v)))
        self._cli.register("-frequence_penalty", lambda: self._config.pop("frequence_penalty", None))
        self._cli.register("logprobs", lambda v: self.set_config("frequence_penalty", float(v)))
        self._cli.register("-logprobs", lambda: self._config.pop("frequence_penalty", None))
        self._cli.register("max_tokens", lambda v: self.set_config("max_tokens", int(v)))
        self._cli.register("-max_tokens", lambda: self._config.pop("max_tokens", None))
        self._cli.register("prompt", lambda v: self.set_config("prompt", v.strip()), use_raw_cmd=True)
        self._cli.register("-prompt", lambda: self._config.pop("prompt", None))
        self._cli.register("file", self._on_file_attach)
        self._cli.register("-file", lambda: self._files.clear())
        self._cli.register("sandbox", lambda v: self._tool.set_sandbox_home(v))
        self._cli.register("-sandbox", lambda: self._tool.set_sandbox_home(''))
        self._cli.register("load", self._on_load_log)
        self._cli.register("list", self._on_list)
        self._cli.register("use", self._on_use)
        self._cli.register("show", self._on_show)
        self._cli.register("search", self._on_search)
        self._cli.register("goto", self._on_goto)
        self._cli.register("down", self._on_down)
        self._cli.register("open", self._on_open)
        self._cli.register("start", self._on_start)
        self._cli.register("stop", self._on_stop)

    def _get_tokenizer_name(self):
        tokenizer_name = "cl100k_base"
        if "tokenizer" in self._config['model']:
            tokenizer_name = self._config['model'].get("tokenizer")
        elif self._assistant and "tokenizer" in self._assistant:
            tokenizer_name = self._assistant.get("tokenizer", None)
        return tokenizer_name;

    def _count_tokens(self, text):
        return self._tokenizer.count_tokens(text, self._get_tokenizer_name())

    def _open_llm(self, api_key_name=None, base_url=None):
        """Open llm client with given or default parameters"""

        # Use provided values or fall back to defaults
        api_key_name = api_key_name or _DEFAULT_API_KEY_NAME
        base_url = base_url or _DEFAULT_BASE_URL

        # Get API key from environment
        api_key = os.getenv(api_key_name, '')
        if not api_key:
            raise ValueError(f"API key not found in environment variable {api_key_name}")

        return OpenAI(api_key=api_key, base_url=base_url)

    def _filter_request(self, request):
        return request

    def _filter_response(self, response, filter_out=[], filter_toolcalls=False):
        result = []
        if isinstance(response, dict):
            filted = {k:v for k,v in response.items() if k not in filter_out}
            result.append(filted)
        elif isinstance(response, list):
            if filter_toolcalls:
                filter_out.append("tool_calls")
            for it in response:
                if isinstance(it, dict):
                    filted = {k:v for k,v in it.items() if k not in filter_out}
                    if not filter_toolcalls or filted["role"] != "tool":
                        result.append(filted)
                elif isinstance(it, list):
                    for i in it:
                        filted = {k:v for k,v in i.items() if k not in filter_out}
                        if not filter_toolcalls or filted["role"] != "tool":
                            result.append(filted)
        if not result:
            result.append({"role":"assistant", "content":"\n"})
        return result

    def _get_completion_params(self, current_round = None):
        params = { 'stream': True, 'messages':[] }
        messages = [ {
            "role":    "system",
            "content": self._config.get("prompt", self._system_prompt)
            } ]
        if self._history and self._config.get("talk_mode", "chain") == "chain":
            count = 0
            length = len(self._history)
            for round in self._history:
                request = self._filter_request(round.get("request", {}))
                response = round.get("response", [])
                if request:
                    messages.append(request)
                if count + 2 < length:
                    filted = self._filter_response(response,
                            filter_out=["reasoning_content"],
                            filter_toolcalls=True)
                else:
                    filted = self._filter_response(response)
                messages.extend(filted)
                count = count + 1
        if current_round:
            request = current_round.get("request", {})
            response = current_round.get("response", [])
            if request:
                messages.append(request)
                filted = self._filter_response(response)
                messages.extend(filted)

        if len(messages) > 0:
            last = messages[-1]
            if last["role"] == "assistant" and last["content"].strip() == "" and "tool_calls" not in last:
                messages.remove(messages[-1])

        for msg in messages:
            # Create new request message
            request_msg = {k:v for k,v in msg.items() if k in
                    ['role', 'content', 'reasoning_content', 'tool_calls', 'tool_call_id', 'name']}

            # Attach files
            if 'files' in msg:
                files = msg['files']
                file_contents = '\n\n[attachments]:\n'
                file_contents += '\n'.join([f"===== file: `{f['path']}` =====\n{f['content']}\n" for f in files])
                request_msg['content'] += file_contents

            # Append request message
            params['messages'].append(request_msg)

        # apply model configure settings
        params['model'] = self._config['model'].get('name','')
        params.update(self._config['model'].get('params',{}))

        # apply session settings
        if 'deepseek-r' in self._config['model'].get("name","").lower():
            valid_opts = ['max_tokens']
        else:
            valid_opts = ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty']
        params.update({k:v for k,v in self._config.items() if k in valid_opts})

        return params;

    def _get_max_context_tokens(self) -> int:
        """获取当前模型的最大上下文 tokens 限制，缺省为 32K"""
        model_config = self._config.get('model', {})
        if isinstance(model_config, dict):
            context = model_config.get('context', 32768)
            return parse_number_from_readable(context) or 32768
        return 32768

    def _make_tool_calls(self, response) -> List[Dict[str, Any]]:
        tool_returns = []
        if tool_calls := response.get('tool_calls', []):
            for tool_call in tool_calls:
                function = tool_call['function']
                function_name = function['name']
                tool_response = {
                        "tool_call_id": tool_call['id'],
                        "role": "tool",
                        "name": function_name,
                        "content": "ERROR: calling tool failed.",
                    }
                try:
                    function_args = json.loads(function['arguments']) if function['arguments'] else {}
                    tool_response["content"] = self._tool.call_tool(function_name, function_args)
                except Exception as call_ex:
                    print(f"tool_call `{function_name}` error {call_ex}")
                    self._logger.append_error(call_ex)
                    tool_response["content"] = f"[ERROR] calling tool failed: {call_ex}"
                finally:
                    tool_returns.append(tool_response)
        return tool_returns

    def _generate_response(self, current_round) -> Dict[str,Any]:
        """Generate and process assistant response"""
        if not current_round or not current_round.get("request",{}):
            return None
        full_response = {
                "role": "assistant",
                "content": [],
                "tool_calls": []
                }
        full_content = full_response['content']
        reasoning_content = []
        is_FIM = False

        params = self._get_completion_params(current_round)
        msg = {
                "role":     "assistant",
                "content":  "",
                "time":     datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "base_url": self._config.get("base_url",_DEFAULT_BASE_URL),
                }

        if 'complete_type' in self._config:
            messages = params['messages']
            if 'suffix' in self._config:
                # FIM-completion
                is_FIM = True
                if messages[-1]['role'] == 'user':
                    params.pop('messages', None)
                    params['prompt'] = f"```{self._config['complete_type']}\n{messages[-1]['content']}"
                    params['suffix'] = self._config.get("suffix","")
                    params['stream'] = False
                    self._config.pop('suffix', None)
            else:
                # prefix-completion
                params['messages'] = [ m for m in messages if m['role'] != 'system' ]
                params['stop'] = '```'
                if 'prefix' in self._config:
                    prefix = self._config['prefix']
                    self._config.pop('prefix', None)
                else:
                    prefix = ''
                params['messages'].append({
                    'role': 'assistant',
                    'content': f"```{self._config['complete_type']}\n{prefix}",
                    'prefix': True
                    })
            if not 'max_tokens' in params:
                params['max_tokens'] = 400
            if not 'temperature':
                params['temperature'] = 0.2

        msg.update(params)
        msg.pop('stream', None)
        msg.pop('messages', None)

        #print(f"params: {params}")
        start_time = time.time()

        if not self._llm:
            self._llm = self._open_llm(api_key_name=self._config.get('api_key_name', _DEFAULT_API_KEY_NAME),
                    base_url=self._config.get('base_url', _DEFAULT_BASE_URL))
        if is_FIM:
            try:
                response = self._llm.completions.create(**params)
                if content := response.choices[0].text:
                    full_content.append(content)
                    print(content, flush=True)
            except (BadRequestError, APIError, APIConnectionError, RateLimitError) as e:
                error_msg = {
                    "role": "assistant",
                    "content": f"{type(e).__name__}: Request failed with error: {str(e)}",
                    "time": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    "elapsed_time": 0,
                    "api_error": True
                }
                self._logger.append_message(error_msg)
                return error_msg
            except Exception as e:
                error_msg = {
                    "role": "assistant",
                    "content": f"{type(e).__name__}: Request failed with error: {str(e)}",
                    "time": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    "elapsed_time": 0,
                    "unknown_error": True
                }
                self._logger.append_message(error_msg)
                return error_msg
        else:
            if params['messages'][0]['role'] == 'system':
                params['messages'][0]['content'] = params['messages'][0]['content'] + self._prompt_for_title
            if tools := self._tool.get_tools():
                params['tools'] = tools
            request_tokens = 0 # FIXME: calculate a correct rolling request tokens.
            for m in params['messages']:
                if "content_tokens" in m:
                    request_tokens = request_tokens + m["content_tokens"]
                else:
                    request_tokens = request_tokens + self._count_tokens(m['content'])
                if "reasoning_tokens" in m:
                    request_tokens = request_tokens + m["reasoning_tokens"]
            if request_tokens:
                print(f"(request-tokens: {request_tokens})")
            
            # 检查 tokens 是否超限
            max_context_tokens = self._get_max_context_tokens()
            if request_tokens > max_context_tokens * 0.9:  # 达到90%阈值时警告
                print(f"WARNING: Requsted tokens ({request_tokens}) is closing to the {request_tokens/max_context_tokens*100:.1f}% of the maximum context length ({max_context_tokens}).")
            
            try:
                stream = self._llm.chat.completions.create(**params)
            except (BadRequestError, APIError, APIConnectionError, RateLimitError) as e:
                error_msg = {
                    "role": "assistant",
                    "content": f"{type(e).__name__}: Request failed with error: {str(e)}",
                    "time": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    "elapsed_time": 0,
                    "api_error": True
                }
                self._logger.append_message(error_msg)
                return error_msg
            except Exception as e:
                error_msg = {
                    "role": "assistant",
                    "content": f"{type(e).__name__}: Request failed with error: {str(e)}",
                    "time": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    "elapsed_time": 0,
                    "unknown_error": True
                }
                self._logger.append_message(error_msg)
                return error_msg
            
            # 正常处理流式响应
            for chunk in stream:
                chunk_message = chunk.choices[0].delta
                if not full_content:
                    if hasattr(chunk_message, 'reasoning_content'):
                        if think := chunk_message.reasoning_content:
                            if not reasoning_content:
                                print('<think>')
                            print(think, end='', flush=True)
                            reasoning_content.append(think)
                            time.sleep(random.uniform(0.01, 0.05))

                if hasattr(chunk_message, 'tool_calls') and chunk_message.tool_calls:
                    for tool_call in chunk_message.tool_calls:
                        if len(full_response['tool_calls']) <= tool_call.index:
                            full_response['tool_calls'].append({
                                'id': tool_call.id,
                                'type': 'function',
                                'function': {'name': None, 'arguments': []}
                                })
                        if tool_call.function:
                            function = tool_call.function
                            fullres_func = full_response["tool_calls"][tool_call.index]['function']
                            if function.name:
                                fullres_func['name'] = function.name
                            if function.arguments:
                                fullres_func['arguments'].append(function.arguments)

                if content := chunk_message.content:
                    if not full_content:
                        if reasoning_content:
                            print('\n</think>\n')
                    print(content, end='', flush=True)
                    full_content.append(content)
                    time.sleep(random.uniform(0.01, 0.05))

        if reasoning_content:
            if isinstance(reasoning_content, list):
                msg['reasoning_content'] = ''.join(reasoning_content)
            else:
                msg['reasoning_content'] = reasoning_content

        full_response['content'] = ''.join(full_content)
        reasoning_tokens = self._count_tokens(msg.get('reasoning_content',''))
        response_tokens = self._count_tokens(full_response.get('content',''))
        end_time = time.time()
        if full_response['tool_calls']:
            for tool_call in full_response['tool_calls']:
                function = tool_call['function']
                function['arguments'] = ''.join(function['arguments'])

        if full_response['content'] or full_response['tool_calls']:
            msg['content'] = full_response['content']
            msg['time'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            msg['elapsed_time'] = end_time - start_time
            if reasoning_tokens:
                msg['reasoning_tokens'] = reasoning_tokens
            if response_tokens:
                msg['content_tokens'] = response_tokens
            msg['tokenizer'] = self._get_tokenizer_name()
            if full_response['tool_calls']:
                msg['tool_calls'] = full_response['tool_calls']
            self._logger.append_message(msg)

        return msg

    def _fetch_request(self, timeout):
        user_request = self._cli.fetch_request(timeout=timeout)
        if not user_request:
            return None
        msg = {"role": "user", "content": user_request, 'time': datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
        if self._files and len(self._files):
            msg['files'] = self._files
            self._files = []
        if self._config.get('complete_type',''):
            msg['complete_type'] = self._config['complete_type']
            if self._config.get('prefix',''):
                msg['prefix'] = self._config['prefix']
        return msg

    def _main_chat_loop(self):
        response = None
        while not self._cli.is_stopped():
            request = None
            while not self._cli.is_stopped() and request is None:
                request = self._fetch_request(timeout=0.1)
            if request:
                request_tokens = self._count_tokens(request.get("content",""))
                if request_tokens:
                    request["tokenizer"] = self._get_tokenizer_name()
                    request["content_tokens"] = request_tokens
                
                # 检查请求 tokens 是否过高
                max_context_tokens = self._get_max_context_tokens()
                if request_tokens > max_context_tokens * 0.7:  # 达到70%阈值时警告
                    print(f"WARNING: Requsted tokens ({request_tokens}) is closing to the {request_tokens/max_context_tokens*100:.1f}% of the maximum context length ({max_context_tokens}).")
                
                self._logger.append_message(request)
                self._cur_round = {"request": request, "response":[]}
                response = self._generate_response(self._cur_round)
            if response:
                self._cur_round["response"].append(response)
            
            # 检查是否是错误响应（不包含 tool_calls）
            is_error_response = response and (
                response.get('context_exceeded', False) or 
                response.get('api_error', False) or 
                response.get('unknown_error', False)
            )
            
            while not self._cli.is_stopped() and response and 'tool_calls' in response and not is_error_response:
                tool_returns = self._make_tool_calls(response)
                request = self._fetch_request(timeout=0)
                if request:
                    # append user request to tool_returns
                    if tool_returns:
                        tool_returns.append(request)
                    else:
                        tool_returns = request
                if tool_returns:
                    self._logger.append_message(tool_returns)
                    self._cur_round["response"].append(tool_returns)
                    response = self._generate_response(self._cur_round)
                if response:
                    self._cur_round["response"].append(response)
            self._history.append(self._cur_round)
            #print(f"rounds: {self._history}")
            self._cur_round = {"request":[], "response":[]}

    def _on_set_model(self, value: str):
        if value.isdigit() and self._assistant:
            id = int(value)
            if 0 <= id < len(self._assistant["model"]):
                self._config["model"] = self._assistant["model"][id]
                print(f"model `{self._config['model']['name']}` is applied in AI assistant:")
            else:
                print(f"model [{id}] is not list in AI assistant:")
            self._aiconfig.show_provider(self._assistant, self._config.get("model", _DEFAULT_MODEL))
        elif self._assistant:
            for model in self._assistant['model']:
                if value == model['name']:
                    applied = True
                    self._config["model"] = model
                    print(f"model `{value}` is applied in AI assistant:")
                    break
            if not applied:
                print(f"model `{value}` is not list in AI assistant:")
            self._aiconfig.show_provider(self._assistant, self._config.get("model", _DEFAULT_MODEL))
        else:
            self._config["model"] = {"name": value}
            print(f"model `{value}` is applied")

    def set_config(self, name, value):
        if self._config.get(name, "") == value:
            return
        if name in ["base_url", "api_key_name"]:
            self._config[name] = value
            self._llm = None
            self._assistant = None
        elif name == "model":
            self._on_set_model(value)
        else:
            self._config[name] = value

    def get_config(self, name):
        return self._config.get(name, "")

    def _on_file_attach(self, file_path):
        file_obj = Path(file_path).expanduser().resolve()
        if not file_obj.exists():
            print(f"Error: File `{file_path}` does not exist.", file=sys.stderr)
            return True
        try:
            # Check file_obj size (max 2MB)
            if file_obj.stat().st_size > 2 * 1024 * 1024:
                print(f"Error: File `{file_path}` exceeds 2MB size limit", file=sys.stderr)
                return True

            # Detect character encoding, and decode
            rawdata = file_obj.read_bytes()
            encoding = chardet.detect(rawdata)['encoding']
            if not encoding:
                print(f"Error: File `{file_path}` doesn't appear to be a text file, can't determin its character encoding.", file=sys.stderr)
                return True
            content = rawdata.decode(encoding)
            self._files.append({'path': f'{file_path}', 'full_path': f'{file_obj}', 'encoding': encoding, 'content': content})
            print(f"Attached file: `{file_path}`")
        except FileNotFoundError:
            print(f"Error: File `{file_path}` not found", file=sys.stderr)
        except UnicodeError:
            print(f"Error: Convert file `{file_path}` to UTF-8 failure", file=sys.stderr)
        except Exception as e:
            print(f"Error reading file `{file_path}`: {e}", file=sys.stderr)
        return True

    def _on_load_log(self, log_path):
            history_messages = self._logger.load_history(log_path)
            if len(history_messages) != 0:
                self._files = []
            request = None
            response = []
            if self._cur_round and self._cur_round["request"]:
                self._history.append(self._cur_round)
                self._cur_round = {"request":[], "response":[]}
            for msg in history_messages:
                if "role" in msg:
                    if msg["role"] == "user":
                        if request:
                            self._history.append({"request": request, "response": response})
                        request = msg
                    else:
                        response.append(msg)
            if request:
                self._history.append({"request": request, "response": response})
                self._cur_round = {"request":[], "response":[]}
            #print(f"{self._history}")
            return True

    def _on_list(self, list_type):
        if list_type == "ai":
            self._aiconfig.show_list()
        elif list_type == "tool":
            self._tool.show_list()

    def _open_client(self, api_key_name=None, base_url=None):
        """Open client with given or default parameters"""

        # Use provided values or fall back to defaults
        api_key_name = api_key_name or DEFAULT_API_KEY_NAME
        base_url = base_url or DEFAULT_BASE_URL

        # Get API key from environment
        api_key = os.getenv(api_key_name, '')
        if not api_key:
            raise ValueError(f"API key not found in environment variable {api_key_name}")

        return OpenAI(api_key=api_key, base_url=base_url)

    def _on_use(self, *argv):
        argc = len(argv)
        if argc >= 2:
            opt = argv[0].replace('-', '_').lower()
            if opt.lower() == 'ai':
                if argc >= 4 and argv[2].lower() == 'model':
                    changed = self._aiconfig.use_ai(name=argv[1], model=argv[3])
                else:
                    changed = self._aiconfig.use_ai(name=argv[1])
                provider = self._aiconfig.get_provider()
                port = self._aiconfig.get_port()
                model = self._aiconfig.get_model()
                model_name = model.get("name", "")
                if changed:
                    print(f"AI assistant `{provider['name']}` is applied, details:")
                    self._aiconfig.show_provider(provider, model)
                    try:
                        api_key_name = provider.get('api_key_name', _DEFAULT_API_KEY_NAME)
                        base_url = provider.get('base_url', _DEFAULT_BASE_URL)
                        self._llm = self._open_client(api_key_name=api_key_name, base_url=base_url)
                        self._config['api_key_name'] = api_key_name
                        self._config['base_url'] = base_url
                        self._config['model'] = model

                        if 'prompt' in provider:
                            self._config["prompt"] = provider['prompt']
                        for k, v in provider.items():
                            if k in ['temperature', 'top_p', 'presence_penalty', 'frequency_panelty', 'logprobs']:
                                self._config[k] = float(v)

                        self._assistant = provider
                        print(f"Open AI Client: base-url:{base_url}, model:{model_name}, api_key_name:{api_key_name}")
                    except:
                        print(f"Open AI Client failed: base-url:{base_url}, model:{model_name}, api_key_name:{api_key_name}")
                return True
            if opt.lower() == 'tool':
                if self._tool.use_tool(list(argv[1:])):
                    self._tool.show_tools()
                return True

    def _on_show(self, *argv):
        argc = len(argv)
        if argc == 1:
            opt = argv[0].replace('-', '_').lower()
            if opt in self._config.keys():
                value = self._config[opt]
            elif opt == 'prompt':
                value = self._config.get("prompt", self._system_prompt)
            elif opt == 'log_file':
                value = self._logger.get_path()
            elif argv[0] == 'prefix':
                value = self._cmd_prefix
            elif argv[0] == 'ai' and self._assistant:
                print("AI assistant is:")
                provider = self._aiconfig.get_provider()
                model = self._aiconfig.get_model()
                self._aiconfig.show_provider(provider, model)
                return True
            elif argv[0] == 'tool':
                self._tool.show_tools()
                return True
            elif opt == 'sandbox':
                self._tool.show_sandbox_home()
                return True
            elif opt == 'no_log':
                print(f"{not self._logger.is_enable()}")
                return True
            elif argv[0] == 'taskbox':
                try:
                    from tool_shell import invoke_shell_sandbox_info
                    info = invoke_shell_sandbox_info()
                    import json
                    print(json.dumps(info, indent=2))
                except Exception as e:
                    print(f"Error showing taskbox info: {e}")
                return True
            else:
                value = ''
                print(f"Option `{argv[0]}` is unspecified.")
                return True
            if isinstance(value, str) and '\n' in value:
                print(f"{argv[0]} = <<EOF")
                print(value)
                print("EOF")
            else:
                print(f"{argv[0]} = {value}")
            return True
        elif argc == 2:
            opt = argv[0].replace('-', '_').lower()
            if opt == 'ai':
                provider = self._aiconfig.find_provider(argv[1])
                model = self._aiconfig.get_model()
                self._aiconfig.show_provider(provider, model)
            elif opt == 'tool':
                self._tool.show_toolset(argv[1])
            return True

    def _on_search(self, *argv):
        request = " ".join(argv)
        from tool_web import invoke_web_search
        content = invoke_web_search(request=request, engine='google')
        print(f"{content}")

    def _on_goto(self, url):
        from tool_web import invoke_get_content
        content = invoke_get_content(url=url, return_format="markdown")
        print(f"{content}")

    def _on_down(self, url):
        from tool_web import invoke_download_file
        result = invoke_download_file(url)
        for k,v in result.items():
            if k != "url":
                print(f"  {k:>10}: {v:<10}")

    def _on_open(self, file_path):
        import subprocess
        if not os.path.exists(file_path):
            print(f"ERROR：file not found - {file_path}")
            return False
        try:
            if sys.platform == "linux":
                subprocess.run(["xdg-open", file_path])
            elif sys.platform == "darwin":  # macOS
                subprocess.run(["open", file_path])
            elif sys.platform == "win32":   # Windows
                os.startfile(file_path)  # or subprocess.run(["start", file_path], shell=True)
            else:
                print(f"Open file is not supported on: {sys.platform}")
                return False
            return True
        except Exception as e:
            print(f"ERROR: {e}")
            return False

    def set_input_mode(self, input_mode: str):
        self._cli.set_input_mode(input_mode)

    def get_input_mode(self):
        return self._cli.get_input_mode()

    def set_verbose(self, verbose: bool):
        self._logger.set_verbose(verbose)

    def is_verbose(self) -> bool:
        return self._logger.is_verbose()

    def enable_log(self, enable: bool):
        self._logger.set_enable(enable)

    def is_log_enabled(self) -> bool:
        return self._logger.is_enable()

    def open_log(self, log_dir="", log_filename=""):
        self._logger.open(log_dir, log_filename)

    def _on_start(self, *argv):
        if len(argv) == 1 and argv[0] == 'taskbox':
            try:
                from tool_shell import invoke_execute_shell
                result = invoke_execute_shell(command="echo 'Starting taskbox container...'", timeout=2, persistent=True)
                if result.get('success'):
                    print('Taskbox container started.')
                else:
                    print(f'Failed to start taskbox: {result.get("error", "unknown error")}')
            except Exception as e:
                print(f'Error starting taskbox: {e}')
        else:
            print('Usage: start taskbox')

    def _on_stop(self, *argv):
        if len(argv) == 1 and argv[0] == 'taskbox':
            try:
                from tool_shell import invoke_shell_cleanup
                result = invoke_shell_cleanup()
                if result.get('success'):
                    print('Taskbox container stopped.')
                else:
                    print(f'Failed to stop taskbox: {result.get("error", "unknown error")}')
            except Exception as e:
                print(f'Error stopping taskbox: {e}')
        else:
            print('Usage: stop taskbox')
    def start(self):
        self._cli.start()
        self._main_chat_loop()

    def post_user_input(self, user_input: str) -> bool:
        return self._cli.post_user_input(user_input)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--no-log', action='store_true', help='No log')
    parser.add_argument('--log-dir', '-l', type=str, help='Path of dir to save the logfiles')
    parser.add_argument('--log-filename', type=str, help='Base name of the logfile')
    parser.add_argument('--json', action='store_true', help='Use JSON format (equivalent to --mode=json)')
    parser.add_argument('--text', action='store_true',  help='Use Text format (equivalent to --mode=text)')
    parser.add_argument('--base-url', type=str, default=_DEFAULT_BASE_URL,
                       help=f'Base url for API service (default: {_DEFAULT_BASE_URL})')
    parser.add_argument('--api-key-name', type=str, default=_DEFAULT_API_KEY_NAME,
                       help=f'Environment variable name for API key (default: {_DEFAULT_API_KEY_NAME})')
    parser.add_argument('--model', type=str, default=_DEFAULT_MODEL)
    parser.add_argument('--silent', action='store_true', help='No verbose')
    parser.add_argument('--use-ai', type=str, help='Use AI assistant by name or index')
    args = parser.parse_args()

    aichat = AIChat()

    if args.json:
        aichat.set_input_mode("json")
    elif args.text:
        aichat.set_input_mode("text")
    if args.silent:
        aichat.set_verbose(False)
    if args.no_log:
        aichat.enable_log(False)
    aichat.open_log(args.log_dir, args.log_filename)

    # Handle --use-ai parameter
    if args.use_ai:
        if args.model:
            found = aichat._aiconfig.use_ai(args.use_ai, args.model)
            if not found:
                found = aichat._aiconfig.use_ai('0', args.model)
                if not found:
                    found = aichat._aiconfig.use_ai('0', '0')
            if not found:
                print(f"Warning: Assistant '{args.use_ai}' with model:'{args.model}' not found")
        else:
            found = aichat._aiconfig.use_ai(args.use_ai, '0')
            if not found:
                print(f"Warning: Assistant '{args.use_ai}' not found")

        provider = aichat._aiconfig.get_provider()
        port = aichat._aiconfig.get_port()
        model = port.get("model", {})
        model_name = model.get("name", _DEFAULT_MODEL)
        aichat.set_config("base_url", port.get('base_url', _DEFAULT_BASE_URL))
        aichat.set_config("api_key_name", port.get('api_key_name', _DEFAULT_API_KEY_NAME))
        aichat.set_config("model", model_name)
        print(f"Using AI assistant: {port.get('name', 'Unknown')} on model: {aichat.get_config('model')['name']}")
        if 'prompt' in port:
            aichat.set_config("prompt", port['prompt'])
        aichat._assistant = provider
    else:
        # Use individual parameters
        aichat.set_config("base_url", args.base_url)
        aichat.set_config("model", args.model)
        aichat.set_config("api_key_name", args.api_key_name)

    aichat.start()

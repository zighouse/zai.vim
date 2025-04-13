#!/usr/bin/env python3
# Call deepseek to provide chat service.
#
# Supports two input modes: json and text.
#
# In json input mode, the input is a json string list where each item represents a line.
# Responses in json mode will not contain commands.
#
# Text input mode has two request types:
#  1. Line request mode: Each line of text triggers a deepseek request.
#                        Command interpretation takes priority - if a line can be
#                        interpreted as a command, it won't be treated as content.
#
#  2. Block request mode: Multiple lines are grouped as a single request.
#                         Triggered by regex /^<<([A-Za-z][A-Za-z0-9]+)$/. Subsequent lines
#                         until the ending signature are treated as one request. Example:
#                             <<EOF
#                             line 1
#                             line 2
#                             EOF
#                         Sends 'line1\nline2\n' as a single request.
#
# Commands start with a prefix character (default ':'), followed by command name (case-sensitive)
# and parameters.
#
# In json mode, commands must still be entered as plain text (like line requests), not json-encoded.
#
# Command escaping: Double prefix (e.g., '::') escapes the first prefix.
#
# Change command prefix: Use :->/ to change prefix to '/', /->: to revert.
# Valid prefix characters:
#     : / ~ \ ; ! # $ % & ? @ ^ _ * + = , . < > ` ' " ( ) [ ] { }
#
# Command format:
#   :[-]<command> [args]
#   '-' before command name unsets previous parameter settings.
#
# Available commands:
#   ::                     - Escape command prefix for current line.
#   :->/                   - Change command prefix character.
#   :exit, :quit, :bye     - Exit program.
#   :model deepseek-chat   - Set model (options: deepseek-coder, deepseek-reasoner, deepseek-chat)
#   :temperature 0.7       - Set temperature [0,2]. Lower values make responses more deterministic.
#                            Not recommended to use with top_p simultaneously.
#   :top_p  1              - Set top_p [0,1]. 0.1 means select top 10% probability tokens.
#   :max_tokens 1024       - Set maximum generated tokens.
#   :presence_penalty 0    - [-2, 2] Penalize new tokens for topic repetition.
#   :frequency_penalty 0   - [-2, 2] Penalize repeated tokens globally.
#   :logprobs 0            - [0,20] Include log probabilities of top tokens.
#   :prompt <string>       - Set system prompt.
#   :talk_mode  <enum>     - Conversation mode: instant (stateless), chain (context-aware)
#   :file <file-path>      - Attach a text file.
#   :-file                 - Remove all attached text files.
#   :complete_type <file-type>  - File-type to complete.
#   :prefix <string>       - Set prefix.
#
import argparse
import json
import os
import io
import random
import re
import sys
import time
import chardet
from datetime import datetime
from openai import OpenAI
from appdirs import user_data_dir
from pathlib import Path

sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8', errors='replace')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace', line_buffering=True)
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace', line_buffering=True)

g_verbose = True
g_log_enabled = True
g_log_path = None
def log_init(log_dir=''):
    global g_log_path, g_log_enabled
    if not g_log_enabled:
        g_log_path = None
        return
    if not log_dir:
        log_dir = Path(user_data_dir("zai", "zighouse")) / "log"
    try:
        if isinstance(log_dir, str):
            log_dir = Path(log_dir)
        log_dir.mkdir(parents=True, exist_ok=True)
        log_filename = datetime.now().strftime("%Y%m%d_%H%M%S.md")
        g_log_path = log_dir / log_filename
    except Exception as e:
        print(f"Failed initing log file, error: {e}", file=sys.stderr)

g_cmd_prefix = ':'
g_cmd_prefix_chars = [ ':', '/', '~', '\\', ';', '!', '#', '$', '%', '&', '?',
        '@', '^', '_', '*', '+', '=', ',', '.', '<', '>', '`', '\'', '"',
        '(', ')', '[', ']', '{', '}', ]
# '-' is not a valid command prefix char, it has a special usage.

g_input_mode = 'json'
g_output_mode = 'text'

g_block_stack = []  # Stack of active blocks, each entry is:
                    # {'type': 'prompt', 'signature': str, 'content': str}

g_prompt = """You are a strict assistant in programming, software engineering and computer science. For each query:
 1. Identify key issues.
 2. Propose solutions with pragmatical considerations.
 3. Conclude with a concise title reflecting the core suggestion."""
if 'zh' in os.getenv('LANG', '') or 'zh' in os.getenv('LANGUAGE', ''):
    g_prompt = g_prompt + '\n使用中文回答'
g_system_message={'role': 'system', 'content': g_prompt}
# List of messages, each entry is:
# {'role': str, 'content': str, 'time': str,
#   'params': {},
#   'files':[{'path': str, 'encoding': str, 'content': str}]
# }
g_messages = [ g_system_message, ]

# List of attachments, each entry is:
# {'path': str, 'full_path': str, 'encoding': str, 'content': str}
g_files = []

g_log = []

g_config = {
        'model': 'deepseek-chat', # Verified models: deepseek-coder, deepseek-chat, deepseek-reasoner
        # 'temperature': 0.7,
        }

# Default values
DEFAULT_API_KEY_NAME = "DEEPSEEK_API_KEY"
DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"

# Global client instance (will be initialized in main)
g_client = None

def open_client(api_key_name=None, base_url=None):
    """Open client with given or default parameters"""

    # Use provided values or fall back to defaults
    api_key_name = api_key_name or DEFAULT_API_KEY_NAME
    base_url = base_url or DEFAULT_BASE_URL

    # Get API key from environment
    api_key = os.getenv(api_key_name, '')
    if not api_key:
        raise ValueError(f"API key not found in environment variable {api_key_name}")

    return OpenAI(api_key=api_key, base_url=base_url)

def show_help():
    help_text = f"""
Deepseek Chat Terminal Client - Usage Guide

Command Prefix: '{g_cmd_prefix}' (change with {g_cmd_prefix}-><new_prefix>)

BASIC USAGE:
  {g_cmd_prefix}help                  - Show this help message
  {g_cmd_prefix}exit|quit|bye         - Exit the program
  {g_cmd_prefix}{g_cmd_prefix}        - Escape command prefix (send literal '{g_cmd_prefix}')

INPUT MODES:
  Line mode:     Each line is sent as separate request
  Block mode:    Start with <<EOF, end with EOF (or any marker)

COMMANDS:
  Model & Parameters:
    {g_cmd_prefix}model <name>         - Set model (deepseek-coder, deepseek-chat, deepseek-reasoner)
    {g_cmd_prefix}temperature <float>  - Set creativity (0-2, default 0.7)
    {g_cmd_prefix}top_p <float>        - Set nucleus sampling (0-1)
    {g_cmd_prefix}max_tokens <int>     - Set response length limit
    {g_cmd_prefix}prompt <text>        - Set prompt or system message content
    {g_cmd_prefix}prompt<<EOF          - Start block mode for prompt, end with EOF (or any marker)
    {g_cmd_prefix}complete_type <str>  - File-type for completion
    {g_cmd_prefix}prefix <str>         - Prefix for completion
    {g_cmd_prefix}prefix<<EOF          - Start block mode for prefix, end with EOF (or any marker)
    {g_cmd_prefix}suffix <str>         - Suffix for FIM-completion
    {g_cmd_prefix}suffix<<EOF          - Start block mode for suffix, end with EOF (or any marker)
    {g_cmd_prefix}no-log               - Disable file logging
    {g_cmd_prefix}-<param>             - Reset parameter to default

  File Handling:
    {g_cmd_prefix}file <path>          - Attach text file (max 2MB)
    {g_cmd_prefix}-file                - Remove all attached files

  Conversation:
    {g_cmd_prefix}talk_mode <mode>     - Set conversation mode (instant, chain)
    {g_cmd_prefix}logprobs <int>       - Show top token probabilities (0-20)

  Prefix Control:
    {g_cmd_prefix}-><char>             - Change command prefix character
    Valid prefix chars: : / ~ \\ ; ! # $ % & ? @ ^ _ * + = , . < > ` ' " ( ) [ ] {{ }}

EXAMPLES:
  {g_cmd_prefix}model deepseek-coder
  {g_cmd_prefix}temperature 0.5
  <<CODE
  def hello():
      print("Hello world!")
  CODE
  {g_cmd_prefix}file example.py
  {g_cmd_prefix}->/   (now commands start with / instead of :)
"""
    print(help_text)

def save_log():
    """Save conversation history to log file"""
    global g_log_enabled, g_log_path, g_log

    if not g_log_enabled or not g_log_path:
        return

    # avoid create an empty log
    if not g_log:
        return

    # print attachments
    with open(g_log_path, "w", encoding="utf-8") as log_file:
        if (sys_msg := g_system_message['content'].strip()):
            log_file.write(f"**System:**\n{sys_msg}\n\n")
        for msg in g_log:
            log_file.write(f"**{msg['role'].capitalize()}:**\n")
            log_file.write(f"<small>\n")
            for k in msg:
                if k in ['prefix', 'suffix']:
                    log_file.write(f"  - {k.replace('_','-')}:\n```\n{msg[k]}\n```\n")
                elif k not in ['role', 'content', 'files', 'reasoning_content', 'tool_calls', 'stop']:
                    log_file.write(f"  - {k.replace('_','-')}: {msg[k]}\n")
            if 'files' in msg:
                log_file.write("  - attachments:\n")
                for file in msg['files']:
                    log_file.write(f"    - {file['full_path']}\n")
            log_file.write(f"</small>\n")
            if 'reasoning_content' in msg:
                log_file.write(f"<think>\n{''.join(msg['reasoning_content'])}\n</think>\n")
            if 'tool_calls' in msg:
                log_file.write(f"<tool_calls>\n{''.join(msg['tool_calls'])}\n</tool_calls>\n")
            log_file.write(f"{msg['content']}\n\n")
    print(f"\nSaved log: {g_log_path}")

def build_instant_messages(messages):
    '''In instant mode, keep only system role and latest user messages'''
    if not messages or messages[0]['role'] != 'system':
        return messages

    # Find latest user message group
    latest_user_msgs = []
    found_assistant = False

    for msg in reversed(messages):
        if msg['role'] == 'assistant':
            found_assistant = True
        elif msg['role'] == 'user':
            if found_assistant:
                break
            request_msg = {'role': msg['role'], 'content': msg['content']}

            # Attach files
            if 'files' in msg:
                files = msg['files']
                file_contents = '\n\n[attachments]:\n'
                file_contents += '\n'.join([f"===== file: `{f['path']}` =====\n{f['content']}\n" for f in files])
                request_msg['content'] += file_contents

            latest_user_msgs.append(request_msg)

    latest_user_msgs.reverse()
    return [messages[0]] + latest_user_msgs

def get_completion_params():
    global g_messages, g_config
    params = { 'stream': True, 'messages':[] }
    # Conversation mode
    if g_config.get('talk_mode', 'chain') == 'instant':
        params['messages'] = build_instant_messages(g_messages)
    else:
        for msg in g_messages:
            # Create new request message
            request_msg = {'role': msg['role'], 'content': msg['content']}

            # Attach files
            if 'files' in msg:
                files = msg['files']
                file_contents = '\n\n[attachments]:\n'
                file_contents += '\n'.join([f"===== file: `{f['path']}` =====\n{f['content']}\n" for f in files])
                request_msg['content'] += file_contents

            # Append request message
            params['messages'].append(request_msg)

    if 'deepseek-r' in g_config['model'].lower():
        valid_opts = ['model', 'max_tokens']
    else:
        valid_opts = ['model', 'temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty']

    for k in valid_opts:
        if k in g_config:
            params[k] = g_config[k]

    return params;

def generate_response():
    """Generate and process assistant response"""
    global g_messages, g_config, g_client, g_verbose, g_log
    full_response = []
    reasoning_content = []
    tool_calls = []
    is_FIM = False

    params = get_completion_params()
    msg = {
            "role":     "assistant",
            "content":  "",
            "time":     datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            "base_url": g_config['base_url'],
            }

    if 'complete_type' in g_config:
        messages = params['messages']
        if 'suffix' in g_config:
            # FIM-completion
            is_FIM = True
            if messages[-1]['role'] == 'user':
                params.pop('messages', None)
                params['prompt'] = f"```{g_config['complete_type']}\n{messages[-1]['content']}"
                params['suffix'] = g_config['suffix']
                params['stream'] = False
                g_config.pop('suffix', None)
        else:
            # prefix-completion
            params['messages'] = [ m for m in messages if m['role'] != 'system' ]
            params['stop'] = '```'
            if 'prefix' in g_config:
                prefix = g_config['prefix']
                g_config.pop('prefix', None)
            else:
                prefix = ''
            params['messages'].append({
                'role': 'assistant',
                'content': f"```{g_config['complete_type']}\n{prefix}",
                'prefix': True
                })
        if not 'max_tokens' in params:
            params['max_tokens'] = 400
        if not 'temperature':
            params['temperature'] = 0.0

    msg.update(params)
    msg.pop('stream', None)
    msg.pop('messages', None)

    if not g_client:
        g_client = open_client(api_key_name=g_config['api_key_name'], base_url=g_config['base_url'])
    try:
        if is_FIM:
            response = g_client.completions.create(**params)
            if content := response.choices[0].text:
                full_response.append(response.choices[0].text)
                print(response.choices[0].text, flush=True)
        else:
            stream = g_client.chat.completions.create(**params)
            for chunk in stream:
                if not full_response:
                    if hasattr(chunk.choices[0].delta, 'reasoning_content'):
                        if think := chunk.choices[0].delta.reasoning_content:
                            if not reasoning_content:
                                print('<think>')
                            print(think, end='', flush=True)
                            reasoning_content.append(think)
                            time.sleep(random.uniform(0.01, 0.05))
                    elif hasattr(chunk.choices[0].delta, 'tool_calls'):
                        if tool := chunk.choices[0].delta.tool_calls:
                            print(tool, end='', flush=True)
                            tool_calls.extend(tool)
                            time.sleep(random.uniform(0.01, 0.05))

                if content := chunk.choices[0].delta.content:
                    if not full_response:
                        if reasoning_content:
                            print('\n</think>\n')
                    print(content, end='', flush=True)
                    full_response.append(content)
                    time.sleep(random.uniform(0.01, 0.05))

        if reasoning_content:
            msg['reasoning_content'] = reasoning_content
        elif tool_calls:
            msg['tool_calls'] = tool_calls

        if full_response:
            msg['content'] = ''.join(full_response)
            msg['time'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            g_messages.append(msg)
            g_log.append(msg)
            if g_verbose:
                print("\n<small>")
                for k in msg:
                    if k not in ['role', 'content', 'reasoning_content', 'tool_calls', 'stop']:
                        print(f"  - {k.replace('_','-')}: {msg[k]}")
                print("</small>")

    except Exception as e:
        # Rollback error-causing message
        if g_messages and g_messages[-1]["role"] == "user":
            m = g_messages.pop()
            l = g_log.pop();
        print(f"\nFailed generating response, error: {e}", file=sys.stderr)
        if l and len(l):
            print("Rolling back the message which causing error:", file=sys.stderr)
            print("<small>", file=sys.stderr)
            for k in msg:
                if k not in ['role', 'content']:
                    print(f"  - {k.replace('_','-')}: {msg[k]}", file=sys.stderr)
            print("</small>", file=sys.stderr)

def set_prompt(prompt):
    global g_config, g_system_message
    if prompt:
        p = prompt.strip()
        if p:
            g_config['prompt'] = p
            g_system_message['content'] = p

def handle_command(command):
    global g_messages, g_config, g_cmd_prefix, g_cmd_prefix_chars, \
            g_system_message, g_prompt, g_log_enabled, g_log, g_block_stack, g_files, g_client
    argv = command.split()
    argc = len(argv)
    cmd = argv[0][0] + argv[0][1:].replace('-','_')

    # Help command
    if cmd == 'help':
        show_help()
        return True

    # Rest of the command handling logic...
    # Exit commands
    if cmd in ['exit', 'quit', 'bye']:
        save_log()
        sys.exit(0)
        return True

    if cmd == 'no_log':
        g_log_enabled = False
        return True

    # Unset options
    if cmd[0] == '-':
        if cmd[1:] in ['temperature', 'top_p', 'max_tokens', 'logprobs', 'talk_mode',
                'complete_type', 'prefix', 'suffix']:
            g_config.pop(cmd[1:], None)
            return True
        elif cmd[1:] == 'prompt':
            g_config.pop(cmd[1:], None)
            g_system_message['content'] = g_prompt
            return True
        elif cmd[1:] == 'file':
            # Remove all file messages,
            # TODO: if an argument provided, remove the given file.
            # TODO: remove files in context messages.
            g_files = []
            return True
        elif cmd[1:] == 'no_log':
            g_log_enabled = True
            return True

    # String options
    if cmd in ['model', 'talk_mode', 'base_url', 'api_key_name', 'complete_type'] and argc == 2:
        if cmd == 'base_url' and argv[1] != g_config['base_url']:
            # Should reopen client at the new base_url
            g_client = None
        g_config[cmd] = argv[1]
        return True

    if cmd in ['prefix', 'suffix'] and argc > 1:
        g_config[cmd] = command[len(cmd)+1:]
        return True

    # Float options
    if cmd in ['temperature', 'top_p', 'presence_penalty', 'frequency_panelty', 'logprobs'] \
            and argc == 2:
        g_config[cmd] = float(argv[1])
        return True

    # Integer options
    if cmd in ['max_tokens'] and argc == 2:
        g_config[cmd] = int(argv[1])
        return True

    # Text options
    if cmd == 'prompt':
        set_prompt(command.strip()[7:])
        return True

    # Block prompt
    if cmd.startswith('prompt'):
        rest = command[6:].strip()
        if rest.startswith('<<') and len(rest) > 2 and rest[2] != g_cmd_prefix:
            g_block_stack.append({
                'type': 'prompt',
                'signature': rest[2:],
                'content': ''
            })
            return True

    # Block prefix
    if cmd.startswith('prefix'):
        rest = command[6:].strip()
        if rest.startswith('<<') and len(rest) > 2 and rest[2] != g_cmd_prefix:
            g_block_stack.append({
                'type': 'prefix',
                'signature': rest[2:],
                'content': ''
            })
            return True

    # Block suffix
    if cmd.startswith('suffix'):
        rest = command[6:].strip()
        if rest.startswith('<<') and len(rest) > 2 and rest[2] != g_cmd_prefix:
            g_block_stack.append({
                'type': 'suffix',
                'signature': rest[2:],
                'content': ''
            })
            return True

    # Change command prefix
    if len(cmd) == 3 and cmd[0:2] == '->' and cmd[2] in g_cmd_prefix_chars:
        g_cmd_prefix = cmd[2]
        return True

    # File attachment
    if cmd == 'file' and argc == 2:
        file_path = argv[1]
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
            g_files.append({'path': f'{file_path}', 'full_path': f'{file_obj}', 'encoding': encoding, 'content': content})
            print(f"Attached file: `{file_path}`")
        except FileNotFoundError:
            print(f"Error: File `{file_path}` not found", file=sys.stderr)
        except UnicodeError:
            print(f"Error: Convert file `{file_path}` to UTF-8 failure", file=sys.stderr)
        except Exception as e:
            print(f"Error reading file `{file_path}`: {e}", file=sys.stderr)
        return True

    print(f"unknown command: {command}", file=sys.stderr)

    return False

def chat_round():
    global g_block_stack, g_messages, g_input_mode, g_cmd_prefix, g_files

    try:
        user_input = input("")
    except UnicodeDecodeError as e:
        save_log()
        print(f'Get input failure, unicode decode error: {e}', file=sys.stderr)
        return
    except EOFError as e:
        save_log()
        sys.exit(0)
        return
    if not user_input:
        return # ignore empty

    # Process commands
    user_cmd = user_input.strip()
    if len(user_cmd) > 1 and user_cmd[0] == g_cmd_prefix:
        if user_cmd[1] == g_cmd_prefix:
            user_input = user_input[1:]
        else:
            handle_command(user_cmd[1:])
            return

    if g_input_mode == 'json':
        try:
            if not user_input.strip():
                return
            user_request = '\n'.join(json.loads(user_input))
        except json.decoder.JSONDecodeError:
            save_log()
            print(f'Request error with user_input:`{user_input}`', file=sys.stderr)
            return

    # Check block mode
    if not g_block_stack:
        match = re.match(r'^<<(\w+)$', user_input)
        if match:
            group = match.group(1)
            if group[0] != g_cmd_prefix:
                g_block_stack.append({
                    'type': '',
                    'signature': group,
                    'content': ''
                })
                return

    # Accumulate block mode inputs
    if g_block_stack:
        current_block = g_block_stack[-1]
        if user_input == current_block['signature']:
            # Block ended
            block_content = current_block['content']
            g_block_stack.pop()

            if current_block['type'] == 'prompt':
                set_prompt(block_content)
                return
            elif current_block['type'] == 'prefix':
                g_config['prefix'] = block_content
                return
            else:
                user_request = block_content
                if not block_content.strip():
                    return
        else:
            current_block['content'] += user_input + '\n'
            return
    else:
        if g_input_mode == 'json':
            user_request = json.loads(user_input)
        else:
            user_request = user_input

    msg = {"role": "user", "content": user_request, 'time': datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
    if g_files and len(g_files):
        msg['files'] = g_files
        g_files = []
    if 'complete_type' in g_config:
        msg['complete_type'] = g_config['complete_type']
        if 'prefix' in g_config:
            msg['prefix'] = g_config['prefix']
    g_messages.append(msg)
    g_log.append(msg)
    generate_response()
    save_log()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--no-log', action='store_true', help='No log')
    parser.add_argument('--log-dir', '-l', type=str, help='Path of dir to save the logfiles')
    parser.add_argument('--json', action='store_true', help='Use JSON format (equivalent to --mode=json)')
    parser.add_argument('--text', action='store_true',  help='Use Text format (equivalent to --mode=text)')
    parser.add_argument('--base-url', type=str, default=DEFAULT_BASE_URL,
                       help=f'Base url for API service (default: {DEFAULT_BASE_URL})')
    parser.add_argument('--api-key-name', type=str, default=DEFAULT_API_KEY_NAME,
                       help=f'Environment variable name for API key (default: {DEFAULT_API_KEY_NAME})')
    parser.add_argument('--model', type=str, default=DEFAULT_MODEL)
    parser.add_argument('--silent', action='store_true', help='No verbose')

    args = parser.parse_args()
    if args.json:
        g_input_mode = 'json'
    elif args.text:
        g_input_mode = 'text'
    g_verbose = False if args.silent else True
    g_log_enabled = False if args.no_log else True
    log_init(args.log_dir)

    g_config['base_url'] = args.base_url
    g_config['model'] = args.model
    g_config['api_key_name'] = args.api_key_name
    g_client = open_client(api_key_name=args.api_key_name, base_url=args.base_url)

    # Main chat loop
    while True:
        chat_round()

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
#
import argparse
import json
import os
import random
import re
import sys
import time
from datetime import datetime
from openai import OpenAI
from appdirs import user_data_dir
from pathlib import Path

# Log directory
g_log_dir = Path(user_data_dir("zai", "zighouse")) / "log"
g_log_dir.mkdir(parents=True, exist_ok=True)

g_cmd_prefix = ':'
g_cmd_prefix_chars = [ ':', '/', '~', '\\', ';', '!', '#', '$', '%', '&', '?',
        '@', '^', '_', '*', '+', '=', ',', '.', '<', '>', '`', '\'', '"',
        '(', ')', '[', ']', '{', '}', ]
# '-' is not a valid command prefix char, it has a special usage. 

# log file name
g_log_filename = datetime.now().strftime("%Y%m%d_%H%M%S.md")
g_log_path = g_log_dir / g_log_filename
g_input_mode = 'json'
g_output_mode = 'text'

g_is_block_mode = False # Block mode status
g_block_signature = ''  # Block ending signature
g_block = ''            # Accumulated block content
g_is_block_prompt = False # Block mode for prompt
g_prompt="""You are an expert in debugging and code logic. For each query:  
     1. Identify key issues.  
     2. Propose solutions with code snippets.  
     3. Conclude with a concise title reflecting the core fix."""
g_system_message={'role': 'system', 'content': g_prompt}
g_messages = [ g_system_message, ]

# FIM completion (Beta)
# post to https://api.deepseek.com/beta/completions
# base_url="https://api.deepseek.com/beta"
g_config = {
        'model': 'deepseek-chat', # Verified models: deepseek-coder, deepseek-chat, deepseek-reasoner
        'temperature': 0.7,
        }

# Connect to API
g_client = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com")
# for chat completion, should use beta base_url, and provide stop parameter, without system message.
#g_client = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com/beta")
g_log = []

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
    global g_log_path, g_log

    # avoid create an empty log
    if not g_log:
        return

    with open(g_log_path, "w", encoding="utf-8") as log_file:
        sys_msg = g_system_message['content'].strip()
        if sys_msg:
            log_file.write(f"**System:**\n{sys_msg}\n\n")
        for log in g_log:
            msg = log['message']
            log_file.write(f"**{msg['role'].capitalize()}:**\n")
            keys = log.keys() - ['message']
            if len(keys):
                log_file.write(f"<small>\n")
                for k in log:
                    if k not in ['message']:
                        log_file.write(f"  - {k}: {log[k]}\n")
                log_file.write(f"</small>\n")
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
            latest_user_msgs.append(msg)
    
    latest_user_msgs.reverse()
    return [messages[0]] + latest_user_msgs

def get_completion_params():
    global g_messages, g_config
    params = { 'stream': True, 'messages':[] }
    # Conversation mode
    if g_config.get('talk_mode', 'chain') == 'instant':
        params['messages'] = build_instant_messages(g_messages)
    else: 
        params['messages'] = g_messages

    if g_config['model'] == 'deepseek-reasoner':
        candidates = ['model', 'temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty']
    else:
        candidates = ['model', 'max_tokens']

    for k in candidates:
        if k in g_config:
            params[k] = g_config[k]

    return params;

def generate_response():
    """Generate and process assistant response"""
    global g_messages, g_config, g_client, g_log
    full_response = []

    params = get_completion_params()
    msg = {"role": "assistant", "content": ""}
    log = {
        'time': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'message': msg,
        }
    log.update(params)
    log['talk_mode'] = g_config.get('talk_mode', 'chain')
    log.pop('stream', None)
    log.pop('messages', None)
    
    try:
        stream = g_client.chat.completions.create(**params)

        for chunk in stream:
            if content := chunk.choices[0].delta.content:
                print(content, end='', flush=True)
                full_response.append(content)
                time.sleep(random.uniform(0.01, 0.05))
        
        if full_response:
            msg['content'] = ''.join(full_response)
            log['time'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            log['message'] = msg
            g_messages.append(msg)
            g_log.append(log)
            print("\n<small>")
            for k in log:
                if k not in ['message']:
                    print(f"  - {k}: {log[k]}")
            print("</small>")

    except Exception as e:
        # Rollback error-causing message
        if g_messages and g_messages[-1]["role"] == "user":
            m = g_messages.pop()
            l = g_log.pop();
        print(f"\nFailed generating response, error: {e}")
        if l and len(l):
            print("Rolling back the message which causing error:")
            print("<small>")
            for k in log:
                print(f"  - {k}: {log[k]}")
            print("</small>")

def set_prompt(prompt):
    global g_config, g_system_message
    if prompt:
        p = prompt.strip()
        if p:
            g_config['prompt'] = p
            g_system_message['content'] = p

def handle_command(command):
    global g_messages, g_config, g_cmd_prefix, g_cmd_prefix_chars, \
            g_system_message, g_prompt, g_log, \
            g_is_block_mode, g_is_block_prompt, g_block, g_block_signature
    argv = command.split()
    argc = len(argv)
    cmd = argv[0]

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

    # Unset options
    if cmd[0] == '-':
        if cmd[1:] in ['temperature', 'top_p', 'max_tokens', 'logprobs', 'talk_mode']:
            g_config.pop(cmd[1:], None)
            return True
        elif cmd[1:] == 'prompt':
            g_config.pop(cmd[1:], None)
            g_system_message['content'] = g_prompt
            return True
        elif cmd[1:] == 'file':
            # Remove all file messages, TODO or if an argument provided, remove the given file.
            g_messages = [msg for msg in g_messages if not (msg["role"] == "user" and msg["content"].startswith("File: "))]
            g_log = [log for log in g_log if not (log["message"]["role"] == "user" and log["message"]["content"].startswith("File: "))]
            return True
    # String options
    if cmd in ['model', 'talk_mode'] and argc == 2:
        g_config[cmd] = argv[1]
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
    if not g_is_block_mode and cmd.startswith('prompt'):
        rest = command[6:].strip()
        if rest.startswith('<<') and len(rest) > 2 and rest[2] != g_cmd_prefix:
            g_is_block_mode = True
            g_is_block_prompt = True
            g_block_signature = rest[2:]
            g_block = ''
            return True

    # Change command prefix
    if len(cmd) == 3 and cmd[0:2] == '->' and cmd[2] in g_cmd_prefix_chars:
        g_cmd_prefix = cmd[2]
        return True

    # File attachment
    if cmd == 'file' and argc == 2:
        file_path = argv[1]
        try:
            # Check file size (max 2MB)
            if os.path.getsize(file_path) > 2 * 1024 * 1024:
                print(f"Error: File {file_path} exceeds 2MB size limit")
                return True
            
            # Check if file is text (by extension)
            text_extensions = ['.txt', '.md', '.log', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', \
                    '.htm', '.js', '.py', '.sh', '.c', '.h', '.cpp', '.hpp', '.java', '.tex']
            if not any(file_path.lower().endswith(ext) for ext in text_extensions):
                print(f"Error: File {file_path} doesn't appear to be a text file (based on extension)")
                return True
            
            # Read file content
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Create file message with separator
            file_message = f"File: {file_path}\n" + "-" * 40 + "\n" + content + "\n" + "-" * 40
            
            # Add as user message
            msg = {"role": "user", "content": file_message}
            g_log.append({
                'time': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                'message': msg,
                })
            g_messages.append(msg)
            print(f"Attached file: {file_path}")
        except FileNotFoundError:
            print(f"Error: File {file_path} not found")
        except UnicodeDecodeError:
            print(f"Error: File {file_path} is not UTF-8 encoded text")
        except Exception as e:
            print(f"Error reading file {file_path}: {e}")
        return True

    print(f"unknown command: {command}")

    return False

def chat_round():
    global g_is_block_mode, g_block_signature, g_block, g_messages, \
            g_input_mode, g_cmd_prefix, g_is_block_prompt
    
    try:
        user_input = input("")
    except EOFError as e:
        save_log()
        print(f'get input failure:{e}')
        sys.exit(0)
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
            print(f'request error with user_input:`{user_input}`')
            return

    # Check block mode
    if not g_is_block_mode:
        match = re.match(r'^<<(\w+)$', user_input)
        if match:
            group = match.group(1)
            if group[0] != g_cmd_prefix:
                g_is_block_mode = True
                g_block_signature = match.group(1)
                g_block = ''
                return

    # Accumulate block mode inputs
    if g_is_block_mode:
        if user_input == g_block_signature:
            g_is_block_mode = False
            if g_is_block_prompt:
                # For multi-line prompt
                g_is_block_prompt = False
                set_prompt(g_block)
                return
            else:
                # For multi-line user request
                user_request = g_block
                if not g_block.strip():
                    return
        else:
            g_block += user_input + '\n'
            return
    else:
        if g_input_mode == 'json':
            user_request = json.loads(user_input)
        else:
            user_request = user_input

    msg = {"role": "user", "content": user_request}
    g_log.append({
        'time': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'message': msg,
        })
    g_messages.append(msg)
    generate_response()
    save_log()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--log-dir', '-l', type=str, help='Path of dir to save the logfiles')
    parser.add_argument('--mode', choices=['json', 'text'], default='text', help='Output mode (json or text)')
    parser.add_argument('--json', action='store_true', help='Use JSON format (equivalent to --mode=json)')
    parser.add_argument('--text', action='store_true',  help='Use Text format (equivalent to --mode=text)')

    args = parser.parse_args()
    if args.json:
        args.mode = 'json'
    elif args.text:
        args.mode = 'text'
    if args.mode == 'json':
        g_input_mode = 'json'
    else:
        g_input_mode = 'text'
    if args.log_dir:
        os.makedirs(args.log_dir, exist_ok=True)
        g_log_dir = args.log_dir
        g_log_path = os.path.join(g_log_dir, g_log_filename)
    
    # Main chat loop
    while True:
        chat_round()

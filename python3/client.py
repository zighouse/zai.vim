import json
import sys
import threading
import queue
import re
import io
from datetime import datetime

sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8', errors='replace')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace', line_buffering=True)
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace', line_buffering=True)

g_cmd_prefix_chars = [ ':', '/', '~', '\\', ';', '!', '#', '$', '%', '&', '?',
        '@', '^', '_', '*', '+', '=', ',', '.', '<', '>', '`', '\'', '"',
        '(', ')', '[', ']', '{', '}', ]
# '-' is not a valid command prefix char, it has a special usage.

def _extract_block_command(text):
    if "<<<" in text or "<<" not in text or text.count("<<") != 1:
        return None, None
    parts = text.split("<<")
    if len(parts) == 2 and len(parts[1]) > 2:
        return parts[0], parts[1]
    return None, None

class Client:
    def __init__(self):
        self._input_thread = None
        self._input_queue = queue.Queue()
        self._stop_event = threading.Event()
        self._block_stack = []   # Stack of active blocks, each entry is:
                                 # {'type': 'prompt', 'signature': str, 'content': str}
        self._input_mode = 'text'
        self._cmd_prefix = ':'
        self._files = []
        self._commands = {} # registered commands, {"command":(function, instance, use_raw_cmd)}
        self._block_commands = []

        self.register("help", self.show_help)
        self.register("exit", self._exit);
        self.register("quit", self._exit);
        self.register("bye", self._exit);

    def register(self, command: str, function, instance=None, use_raw_cmd=False):
        """register a command"""
        self._commands[command] = (function, instance, use_raw_cmd)
        if use_raw_cmd:
            self._block_commands.append(command)

    def _exit(self):
        self._stop_event.set()

    def is_stopped(self):
        return self._stop_event.is_set()

    def _input_collector(self):
        while not self._stop_event.is_set():
            try:
                user_input = input("")
                self._input_queue.put(user_input)
            except UnicodeDecodeError as e:
                print(f'Get input failure, unicode decode error: {e}', file=sys.stderr)
                continue
            except EOFError:
                self._stop_event.set()
                break

    def set_input_mode(self, input_mode):
        self._input_mode = input_mode

    def get_input_mode(self):
        return self._input_mode

    def post_user_input(self, user_input: str) -> bool:
        if user_input and not self._stop_event.is_set():
            try:
                self._input_queue.put(user_input)
                return True
            except UnicodeDecodeError as e:
                print(f'Get input failure, unicode decode error: {e}', file=sys.stderr)
            except EOFError:
                self._stop_event.set()
        return False

    def start(self):
        if self._input_thread is None or not self._input_thread.is_alive():
            self._stop_event.clear()
            self._input_thread = threading.Thread(target=self._input_collector, daemon=True)
            self._input_thread.start()

    def stop(self):
        self._stop_event.set()
        if self._input_thread and self._input_thread.is_alive():
            self._input_thread.join(timeout=1.0)

    def fetch_request(self, timeout=None):
        try:
            user_input = self._input_queue.get(timeout=timeout)
            return self._build_request(user_input)
        except queue.Empty:
            return None

    def _handle_command(self, command):
        global g_cmd_prefix_chars
        argv = command.split()
        argc = len(argv)
        cmd = argv[0][0] + argv[0][1:].replace('-','_')

        # Change command prefix
        if len(cmd) == 3 and cmd[0:2] == '->' and cmd[2] in g_cmd_prefix_chars:
            self._cmd_prefix = cmd[2]
            return True

        # Handle registered commands
        if cmd in self._commands:
            function, instance, use_raw_cmd = self._commands[cmd]
            if instance is not None:
                all_args = [instance] + argv[1:]
            else:
                all_args = argv[1:]
            try:
                if not use_raw_cmd:
                    function(*all_args)
                else:
                    function(command.lstrip()[len(cmd):])
                return True
            except TypeError as e:
                print(f"Error calling function for command '{command}': {e}")
            except Exception as e:
                print(f"Execution error: {e}")
            return False

        block_cmd, block_sign = _extract_block_command(cmd)
        if block_cmd in self._block_commands and block_sign[0] != self._cmd_prefix:
            self._block_stack.append({
                'type': block_cmd,
                'signature': block_sign,
                'content': ''
            })
            return True

        print(f"unknown command: {command}", file=sys.stderr)
        return False

    def _build_request(self, user_input):
        # Process commands
        if not user_input:
            return None
        user_cmd = user_input.strip()
        if not user_cmd:
            return None

        if len(user_cmd) > 1 and user_cmd[0] == self._cmd_prefix:
            if user_cmd[1] == self._cmd_prefix:
                user_input = user_input[1:]
            else:
                self._handle_command(user_cmd[1:])
                return None

        if self._input_mode == 'json':
            try:
                if not user_input.strip():
                    return None
                user_request = '\n'.join(json.loads(user_input))
            except json.decoder.JSONDecodeError:
                print(f'Request error with user_input:`{user_input}`', file=sys.stderr)
                return None

        # Check block mode
        if not self._block_stack:
            match = re.match(r'^<<(\w+)$', user_input)
            if match:
                group = match.group(1)
                if group[0] != self._cmd_prefix:
                    self._block_stack.append({
                        'type': '',
                        'signature': group,
                        'content': ''
                    })
                    return None

        # Accumulate block mode inputs
        if self._block_stack:
            current_block = self._block_stack[-1]
            if user_input == current_block['signature']:
                # Block ended
                block_content = current_block['content']
                self._block_stack.pop()
                cmd = current_block['type']
                if cmd in self._block_commands and cmd in self._commands:
                    function, instance, use_raw_cmd = self._commands[cmd]
                    if instance is not None:
                        all_args = [instance] + [block_content]
                    else:
                        all_args = [block_content]
                    try:
                        function(*all_args)
                    except TypeError as e:
                        print(f"Error calling function for command '{cmd}': {e}")
                    except Exception as e:
                        print(f"Execution error: {e}")
                    return None
                else:
                    user_request = block_content
                    if not block_content.strip():
                        return None
            else:
                current_block['content'] += user_input + '\n'
                return None
        else:
            if self._input_mode == 'json':
                user_request = json.loads(user_input)
            else:
                user_request = user_input
        return user_request

    def show_help(self):
        cmd_prefix = self._cmd_prefix
        help_text = f"""
Deepseek Chat Terminal Client - Usage Guide

Command Prefix: '{cmd_prefix}' (change with {cmd_prefix}-><new_prefix>)

BASIC USAGE:
  {cmd_prefix}help                  - Show this help message
  {cmd_prefix}exit|quit|bye         - Exit the program
  {cmd_prefix}{cmd_prefix}        - Escape command prefix (send literal '{cmd_prefix}')

INPUT MODES:
  Line mode:     Each line is sent as separate request
  Block mode:    Start with <<EOF, end with EOF (or any marker)

COMMANDS:
  Model & Parameters:
    {cmd_prefix}model <name|idx>     - Set model by name (or index in AI assistant)
    {cmd_prefix}temperature <float>  - Set creativity (0-2, default 0.7)
    {cmd_prefix}top_p <float>        - Set nucleus sampling (0-1)
    {cmd_prefix}max_tokens <int>     - Set response length limit
    {cmd_prefix}prompt <text>        - Set prompt or system message content
    {cmd_prefix}prompt<<EOF          - Start block mode for prompt, end with EOF (or any marker)
    {cmd_prefix}complete_type <str>  - File-type for completion
    {cmd_prefix}prefix <str>         - Prefix for completion
    {cmd_prefix}prefix<<EOF          - Start block mode for prefix, end with EOF (or any marker)
    {cmd_prefix}suffix <str>         - Suffix for FIM-completion
    {cmd_prefix}suffix<<EOF          - Start block mode for suffix, end with EOF (or any marker)
    {cmd_prefix}no-log               - Disable file logging
    {cmd_prefix}load <log-file>      - Load context from a Zai log file.
    {cmd_prefix}-<param>             - Reset parameter to default

  File Handling:
    {cmd_prefix}file <path>          - Attach text file (max 2MB)
    {cmd_prefix}-file                - Remove all attached files

  Conversation:
    {cmd_prefix}talk_mode <mode>     - Set conversation mode (instant, chain)
    {cmd_prefix}logprobs <int>       - Show top token probabilities (0-20)
    {cmd_prefix}history_safety_factor <float> - Set safety factor for history pruning (0.1-0.5, default 0.25)
    {cmd_prefix}history_keep_last_n <int> - Keep last N rounds in history (>=1, default 6)

  AI Assistant:
    {cmd_prefix}list AI              - List valid AI assistants
    {cmd_prefix}show AI <name|idx>   - Display AI assistant by name or index
    {cmd_prefix}use AI <name|idx> [model <name|idx>]
                          - Use AI assistant by name or index, or optional,
                            use model in AI assistant by name or index

  Tools:
    {cmd_prefix}list tool            - List all available tool sets
    {cmd_prefix}show tool [name]     - Show tool set details (all or specific)
    {cmd_prefix}use tool XXX         - Apply entire tool set XXX
    {cmd_prefix}use tool XXX.xxx     - Apply single method xxx from tool set XXX
    {cmd_prefix}use tool XXX: xxx yyy zzz
                          - Apply multiple methods from tool set XXX

  Prefix Control:
    {cmd_prefix}-><char>             - Change command prefix character
    Valid prefix chars: : / ~ \\ ; ! # $ % & ? @ ^ _ * + = , . < > ` ' " ( ) [ ] {{ }}

  Utility:
    {cmd_prefix}show <config>        - Display configurations or parameters.
    {cmd_prefix}show taskbox         - Display taskbox information.
    {cmd_prefix}start taskbox        - Run taskbox docker container.
    {cmd_prefix}stop taskbox         - Stop taskbox docker container.
    {cmd_prefix}search <key words>   - Search the web (by google).
    {cmd_prefix}goto url             - Fetch the content of url.
    {cmd_prefix}down url             - Download file from url.

EXAMPLES:
  {cmd_prefix}model deepseek-coder
  {cmd_prefix}temperature 0.5
<<CODE
  def hello():
      print("Hello world!")
  CODE
  {cmd_prefix}file example.py
  {cmd_prefix}->/   (now commands start with / instead of :)
  {cmd_prefix}list tool
  {cmd_prefix}show tool file
  {cmd_prefix}use tool file
  {cmd_prefix}use tool file.read_file
  {cmd_prefix}use tool file: read_file write_file
"""
        print(help_text)

#class App:
#    def __init__(self, name):
#        self._name = name
#
#    def onexit(self):
#        print(f"{self._name}> exit")
#        sys.exit()
#
#if __name__ == "__main__":
#    a = App("abc")
#    c = Client()
#    c.register("exit", lambda: a.onexit())
#    c.start()
#    while not c.is_stopped():
#        request = c.fetch_request(timeout=0.1)
#        if request:
#            print(f"request: {request}")

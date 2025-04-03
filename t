diff --git a/python3/deepseek.py b/python3/deepseek.py
index 007c5c9..ac2eec5 100644
--- a/python3/deepseek.py
+++ b/python3/deepseek.py
@@ -114,6 +114,7 @@ g_config = {
 # Default values
 DEFAULT_API_KEY_NAME = "DEEPSEEK_API_KEY"
 DEFAULT_BASE_URL = "https://api.deepseek.com"
+DEFAULT_MODEL = "deepseek-chat"
 
 # Global client instance (will be initialized in main)
 g_client = None
@@ -201,7 +202,7 @@ def save_log():
             log_file.write(f"<small>\n")
             for k in msg:
                 if k not in ['role', 'content', 'files']:
-                    log_file.write(f"  - {k}: {msg[k]}\n")
+                    log_file.write(f"  - {k.replace('_','-')}: {msg[k]}\n")
             if 'files' in msg:
                 log_file.write("  - attachments:\n")
                 for file in msg['files']:
@@ -261,11 +262,11 @@ def get_completion_params():
             params['messages'].append(request_msg)
 
     if g_config['model'] == 'deepseek-reasoner':
-        candidates = ['model', 'temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty']
+        valid_opts = ['model', 'max_tokens']
     else:
-        candidates = ['model', 'max_tokens']
+        valid_opts = ['model', 'temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty']
 
-    for k in candidates:
+    for k in valid_opts:
         if k in g_config:
             params[k] = g_config[k]
 
@@ -277,7 +278,8 @@ def generate_response():
     full_response = []
 
     params = get_completion_params()
-    msg = {"role": "assistant", "content": "", "time": datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
+    msg = {"role": "assistant", "content": "", "time": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
+            "base_url": g_config['base_url'] }
     msg.update(params)
     msg.pop('stream', None)
     msg.pop('messages', None)
@@ -298,8 +300,8 @@ def generate_response():
             g_log.append(msg)
             print("\n<small>")
             for k in msg:
-                if k not in ['content']:
-                    print(f"  - {k}: {msg[k]}")
+                if k not in ['role', 'content']:
+                    print(f"  - {k.replace('_','-')}: {msg[k]}")
             print("</small>")
 
     except Exception as e:
@@ -312,8 +314,8 @@ def generate_response():
             print("Rolling back the message which causing error:")
             print("<small>")
             for k in msg:
-                if k not in ['content']:
-                    print(f"  - {k}: {msg[k]}")
+                if k not in ['role', 'content']:
+                    print(f"  - {k.replace('_','-')}: {msg[k]}")
             print("</small>")
 
 def set_prompt(prompt):
@@ -329,7 +331,7 @@ def handle_command(command):
             g_system_message, g_prompt, g_log, g_block_stack, g_files
     argv = command.split()
     argc = len(argv)
-    cmd = argv[0]
+    cmd = argv[0][0] + argv[0][1:].replace('_','-')
 
     # Help command
     if cmd == 'help':
@@ -513,13 +515,13 @@ def chat_round():
 if __name__ == "__main__":
     parser = argparse.ArgumentParser()
     parser.add_argument('--log-dir', '-l', type=str, help='Path of dir to save the logfiles')
-    parser.add_argument('--mode', choices=['json', 'text'], default='text', help='Output mode (json or text)')
     parser.add_argument('--json', action='store_true', help='Use JSON format (equivalent to --mode=json)')
     parser.add_argument('--text', action='store_true',  help='Use Text format (equivalent to --mode=text)')
     parser.add_argument('--base-url', type=str, default=DEFAULT_BASE_URL,
                        help=f'Base url for API service (default: {DEFAULT_BASE_URL})')
     parser.add_argument('--api-key-name', type=str, default=DEFAULT_API_KEY_NAME,
                        help=f'Environment variable name for API key (default: {DEFAULT_API_KEY_NAME})')
+    parser.add_argument('--model', type=str, default=DEFAULT_MODEL)
 
     args = parser.parse_args()
     if args.json:
@@ -534,6 +536,8 @@ if __name__ == "__main__":
         os.makedirs(args.log_dir, exist_ok=True)
         g_log_dir = args.log_dir
         g_log_path = os.path.join(g_log_dir, g_log_filename)
+    g_config['base_url'] = args.base_url
+    g_config['model'] = args.model
 
     # Initialize the global client
     initialize_client(api_key_name=args.api_key_name, base_url=args.base_url)

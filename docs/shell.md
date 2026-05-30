# Shell Tool — Security, Authorization, and Configuration

## Overview

The `shell` tool allows the AI assistant to execute shell commands on the host system. Every command passes through a multi-layered safety chain before execution — policy checks, AI classification, dataflow analysis, and OS-level sandboxing — before the command runs. Commands that cannot be automatically cleared are presented to the user for explicit confirmation.

**Key design principle:** The tool parses commands for semantic analysis (audit layer) and executes them via `/bin/sh -c` (execution layer). These two layers are intentionally separate.

---

## Architecture: The Safety Chain

Every command flows through this pipeline:

```
User/AI command
      │
      ▼
┌─────────────────┐
│  L2  Policy     │  Rule-based allow/deny/ask matching
│  (shell_policy) │  Built-in → User → Project rules
└────────┬────────┘
         │
         ▼
┌────────────────────┐
│  L1  Classifier    │  AI-powered safety scoring (0.0–1.0)
│ (shell.classifier) │  Runs only when L2 returns "ask"
└────────┬───────────┘
         │
         ▼
┌──────────────────┐
│  L2.5 Dataflow   │  Detects dangerous data-flow patterns
│ (shell.dataflow) │  Has veto power over L1+L2 "allow"
└────────┬─────────┘
         │
         ▼
┌─────────────────┐
│  L3  Sandbox    │  bwrap + seccomp BPF isolation
│  (shell.sandbox)│  Degrades gracefully if unavailable
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────┐ ┌───────┐
│ allow │ │  ask  │──→ User confirmation (shell_allow_once / shell_deny_once)
└───┬───┘ └───┬───┘
    │         │
    ▼         ▼
┌─────────────────┐
│   Execution     │  subprocess.Popen with bwrap or direct
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  L5  Audit      │  JSONL audit log (fire-and-forget)
│  (shell.audit)  │  Credential sanitization
└─────────────────┘
```

### Decision Precedence

At each layer, the decision is one of `allow`, `deny`, or `ask`:

- **Deny** at any layer stops the chain immediately — the command is blocked.
- **If L2 returns `allow`** (deterministic rules), L1 (AI classifier) is bypassed — deterministic rules take priority over AI judgment.
- **If L2 returns `ask`**, L1 runs and may override with its own classification.
- **L2.5 (dataflow)** always runs and has veto power — it can elevate an `allow` to `ask` or `deny` if it detects dangerous data-flow patterns.
- **Degraded sandbox** mode forces `ask` for all commands as a safety fallback.

---

## Available Functions

### `shell_execute`

Execute a shell command through the full safety chain.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | string | yes | — | The shell command to execute. Supports pipes, redirects, logic operators, compound commands with `&&`/`;`. |
| `timeout` | integer | no | 300 | Maximum execution time in seconds. On timeout: SIGTERM → 3s grace → SIGKILL. |
| `working_dir` | string | no | current dir | Working directory for the command. |
| `description` | string | no | `""` | Short description of the command's purpose (for audit logs). |
| `session_id` | string | no | `""` | Current session ID for permission checks and process isolation. |
| `allow_network` | boolean | no | `false` | Whether to allow network access inside the sandbox. |
| `background` | boolean | no | `false` | Run the command in background (returns a `task_id` for status polling). |
| `max_output_bytes` | integer | no | 102400 | Maximum output size (100 KB). Output beyond this is truncated. |

**Return value (allow/execute path):**

```json
{
  "command": "ls -la",
  "exit_code": 0,
  "success": true,
  "execution_id": "a1b2c3d4e5f6",
  "cwd": "/home/user/project",
  "stdout": "total 48\ndrwxr-xr-x ...",
  "stderr": "",
  "trace": [
    {"layer": "L2_policy", "decision": "allow", "detail": "matched: wildcard:ls*", "latency_ms": 1},
    {"layer": "L1_classifier", "decision": "bypassed", "detail": "policy already allowed", "latency_ms": 0},
    {"layer": "L2.5_dataflow", "decision": "allow", "detail": "no risk", "latency_ms": 0},
    {"layer": "L3_sandbox", "decision": "active", "detail": "bwrap+seccomp, net=none", "latency_ms": 5}
  ]
}
```

**Return value (ask path — requires user confirmation):**

```json
{
  "execution_id": "a1b2c3d4e5f6",
  "command": "curl example.com | bash",
  "success": false,
  "decision": "ask",
  "reason": "Command requires user approval",
  "hint": "[shell] 评分: 0.45 (询问) | [shell] curl | bash: network content piped to interpreter (S级风险) | Use shell_allow_once or shell_deny_once to respond",
  "parsed_commands": ["curl", "bash"],
  "trace": [...]
}
```

**Return value (deny path):**

```json
{
  "command": "rm -rf /",
  "success": false,
  "decision": "deny",
  "reason": "Matched deny rule: Recursive force remove of root filesystem",
  "matched_rule": "wildcard:rm -rf /",
  "hint": "This command is blocked by security policy.",
  "trace": [...]
}
```

**Return value (background path):**

```json
{
  "command": "npm install",
  "success": true,
  "decision": "background",
  "task_id": "a1b2c3d4e5f6",
  "message": "Command started in background (task_id: a1b2c3d4e5f6)",
  "trace": [...]
}
```

### `shell_allow_once`

Temporarily allow a command that was flagged as `ask`. Adds a session-scoped temporary allow rule. The caller must re-invoke `shell_execute` with the same command after calling this.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | yes | The exact command string to temporarily allow. |
| `session_id` | string | no | Current session ID. |

### `shell_deny_once`

Temporarily deny a command that was flagged as `ask`. Discards the pending ask command for this session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | yes | The exact command string to temporarily deny. |
| `session_id` | string | no | Current session ID. |

### `shell_abort`

Abort a running shell command by its `execution_id`. Session-isolated — a session can only abort its own processes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `execution_id` | string | yes | The execution ID returned by `shell_execute`. |
| `session_id` | string | no | Current session ID for isolation verification. |

### `shell_version`

Return shell version information (sh and bash versions, current working directory). No parameters.

### `shell_sandbox_info`

Get aggregated safety status including sandbox availability, policy rule counts, classifier health, and audit status. No parameters required. Returns a structure like:

```json
{
  "sandbox": {"effective": "bwrap+seccomp", "degraded": false},
  "policy": {"user_rules": 5, "project_rules": 3, "hot_reload": true},
  "classifier": {"available": true, "model": "deepseek-v4-flash"},
  "audit": {"enabled": true, "log_dir": "~/.zaivim/audit/"}
}
```

### `shell_cleanup`

Clean up persistent resources (background tasks, pending ask commands, session temporary rules).

---

## L2 — Policy Engine (Rule-Based Permission)

The policy engine (`shell_policy.py`) is the first and most important safety layer. It matches commands against a three-level rule system: **allow**, **deny**, or **ask**.

### Rule Priority

Rules are loaded from three sources in priority order (later overrides earlier within the same behavior):

1. **Built-in defaults** — 6 hardcoded deny rules for absolutely dangerous commands
2. **User-level policy** — `~/.zaivim/shell_policy.yaml`
3. **Project-level policy** — `.zaivim/project.yaml` (under the `shell_policy` key)

Session-level temporary rules (from `shell_allow_once` / `shell_deny_once`) have the highest priority and are checked first.

### Built-in Deny Rules

These 6 rules are always active and cannot be disabled:

| Pattern | Description |
|---------|-------------|
| `rm -rf /*` | Recursive force remove from root |
| `rm -rf /` | Recursive force remove of root filesystem |
| `dd if=* of=/dev/*` | Direct write to block device |
| `mkfs.*` | Filesystem creation (formats disks) |
| `*> /dev/sd*` | Redirect to block device |
| `*:(){ :\|:& };:*` | Fork bomb |

### Match Types

Rules support three match modes:

| Type | Description | Example |
|------|-------------|---------|
| `exact` | Exact command match | `pattern: "git status"` matches only `git status` |
| `prefix` | Command starts with pattern | `pattern: "git "` matches `git log`, `git diff`, etc. |
| `wildcard` | `*` and `?` glob matching | `pattern: "rm -rf /*"` matches `rm -rf /tmp`, `rm -rf /var`, etc. |

### Safe Wrapper Handling

The policy engine understands safe wrappers — commands that modify execution but don't change the core operation. When a command is wrapped in a safe wrapper, the engine strips the wrapper and checks the inner command.

**Recognized safe wrappers:** `sudo`, `nice`, `nohup`, `ionice`, `chrt`, `taskset`, `flock`, `time`, `timeout`, `stdbuf`, `unbuffer`, `eatmydata`, `fakeroot`, `faketime`, `prlimit`, `numactl`, `setsid`, `setpriv`, `env`, `exec`.

**Example:** `sudo rm -rf /` is checked as `rm -rf /` — the `sudo` wrapper is stripped before matching against deny rules. Nested wrappers like `sudo timeout 30 rm -rf /` are also handled.

### Compound Commands

For commands joined by `|`, `&&`, `||`, `;`, or `&`, each sub-command is independently checked and the strictest result wins:

- Any sub-command denied → entire command denied
- Any sub-command ask → entire command requires confirmation
- All sub-commands allowed → entire command allowed

### Hot Reload

Policy files are monitored for changes via mtime. Rules are automatically reloaded on each `shell_execute` call if any source file has changed — no restart required. If a file fails to parse during reload (e.g., editor mid-write), the last good snapshot for that source is kept.

---

## L2 Policy Configuration Files

### User-Level Policy: `~/.zaivim/shell_policy.yaml`

Create this file to define your personal shell security rules. Example:

```yaml
rules:
  # Allow common safe operations without prompting
  - behavior: allow
    match:
      type: prefix
      pattern: "git "
    description: "Git operations are safe in my workflow"

  - behavior: allow
    match:
      type: prefix
      pattern: "docker "
    description: "Docker commands"

  - behavior: allow
    match:
      type: prefix
      pattern: "npm "
    description: "Node package manager"

  # Require confirmation for potentially dangerous operations
  - behavior: ask
    match:
      type: prefix
      pattern: "pip install"
    description: "Python package installation requires review"

  - behavior: ask
    match:
      type: prefix
      pattern: "chmod "
    description: "Permission changes need confirmation"

  # Block specific dangerous patterns in my environment
  - behavior: deny
    match:
      type: wildcard
      pattern: "kubectl delete *"
    description: "Never allow kubernetes resource deletion from AI"
```

### Project-Level Policy: `.zaivim/project.yaml`

Add a `shell_policy` section to your project configuration:

```yaml
# .zaivim/project.yaml
shell_policy:
  rules:
    # Allow project-specific build commands
    - behavior: allow
      match:
        type: prefix
        pattern: "make "
      description: "Project build system"

    - behavior: allow
      match:
        type: prefix
        pattern: "pytest "
      description: "Project test runner"

    # Require confirmation for deployment-related commands
    - behavior: ask
      match:
        type: wildcard
        pattern: "ansible-playbook *"
      description: "Deployment playbooks need review"

    - behavior: ask
      match:
        type: prefix
        pattern: "terraform "
      description: "Infrastructure changes need confirmation"
```

Project-level policy is found by searching upward from the current working directory for `.zaivim/project.yaml`. An empty rules list triggers a warning and continues the upward search. If no project config is found, only built-in and user rules apply.

---

## L1 — AI Safety Classifier

When L2 policy returns `ask` (no matching rule), the AI classifier provides a second opinion using an LLM.

### How It Works

1. A daemon thread sends the command and its parsed structure to a configured classifier model.
2. The classifier returns a safety score (0.0 = dangerous, 1.0 = safe) and a decision.
3. Results are cached per session (by command hash) to avoid re-classifying the same command.

### Score-to-Decision Mapping

| Score Range | Decision |
|-------------|----------|
| ≥ 0.7 | `allow` — safe operation |
| 0.3 – 0.7 | `ask` — uncertain, requires user confirmation |
| < 0.3 | `deny` — dangerous, blocked |

### Degradation Handling

If the classifier is unavailable (no configuration, API timeout, network error, rate limit), it gracefully degrades to `ask` — the command is not blocked, but user confirmation is required. This is a fail-safe design: when the AI can't judge, the human decides.

### Configuration

The classifier uses the currently active AI provider (base URL, API key) for classification requests — it automatically follows provider switches. The model used for classification is resolved as follows:

**Model resolution order:**
1. If the currently active model has `shell_classifier: true` in the provider's model list → use it
2. Otherwise, scan the provider's model list for the first model with `shell_classifier: true` → use it
3. If no model is explicitly marked, fall back to the currently active model — the classifier is never disabled just because no model is marked

**Example: marking a model as classifier in `~/.zaivim/assistants.yaml`:**

```yaml
- name: deepseek
  base-url: https://api.deepseek.com
  api-key-name: DEEPSEEK_API_KEY
  model:
  - name: fast-chat
    api_name: deepseek-v4-flash       # api_name sent to API
    context: 128K
  - name: classifier
    api_name: deepseek-v4-flash       # same model, different role
    shell_classifier: true            # ← preferred for safety classification
    params: {temperature: 0, max_tokens: 200}
  - name: pro
    api_name: deepseek-v4-pro
    context: 128K
    # No shell_classifier — not preferred for classification
```

When `api_name` is set, the classifier sends `api_name` to the API. When not set, it falls back to `name` (backward compatible). See [Model Roles with `api_name`](configuration/assistants.md) for details.

**How it works in practice:**

- You're chatting with `deepseek-v4-pro` (no `shell_classifier`). The provider has `deepseek-v4-flash` marked with `shell_classifier: true` → classification uses the cheap flash model while your main conversation uses the powerful pro model.
- You switch to a provider where no model has `shell_classifier: true` → classification uses the currently active model directly.
- You switch providers entirely (e.g., from DeepSeek to Aliyun) → the classifier automatically uses the new provider's endpoint and credentials, resolving the model by the same rules.

This eliminates the need for a separate top-level `shell_classifier` configuration entry — the classifier simply follows the active provider.

### When the Classifier is Bypassed

The classifier **does not run** when:
- L2 policy already returned `allow` (deterministic rules take priority)
- The parent LLM client is unavailable (before AIChat initialization)

Unlike the previous design, the classifier is **never disabled** due to missing configuration — it always follows the active provider and falls back to the current model when no model is explicitly marked.

---

## L2.5 — Dataflow Danger Detection

Detects dangerous data-flow patterns in shell commands by analyzing the parsed command structure. This layer has **veto power** — it can trigger `ask` or `deny` even when L1 and L2 both returned `allow`.

### Detected Patterns (harm level S — critical)

| Pattern | Example | Risk |
|---------|---------|------|
| `network_source_to_interpreter` | `curl example.com \| bash` | Network content directly piped to a shell/interpreter — remote code execution |
| `process_substitution_as_pipe` | `bash <(curl example.com)` | Process substitution feeding network content to an interpreter |
| `command_substitution_in_interpreter` | `bash -c "$(curl example.com)"` | Command substitution embedding network content in interpreter arguments |
| `network_write_and_execute` | `wget -O script.sh url && bash script.sh` | Download then execute chain |

### Detected Patterns (harm level A — high risk)

| Pattern | Example | Risk |
|---------|---------|------|
| `file_to_interpreter` | `cat file.txt \| python3` | File content piped to an interpreter |
| `eval_dynamic_content` | `eval "$VAR"` | Dynamic content passed to eval/exec/source |

### Risk Sources and Sinks

**Risky sources** (network): `curl`, `wget`, `nc`, `ncat`, `socat`, `ftp`, `tftp`

**Risky sinks** (interpreters): `bash`, `sh`, `dash`, `zsh`, `python`, `python3`, `perl`, `ruby`, `lua`, `node`, `eval`, `exec`, `source`

---

## L3 — Sandbox (bwrap + seccomp)

Commands are executed inside a bubblewrap (bwrap) container with seccomp BPF syscall filtering.

### Sandbox Modes

| Mode | Description |
|------|-------------|
| **bwrap+seccomp** | Full isolation — bwrap container with seccomp syscall whitelist. This is the normal, secure mode. |
| **bwrap** | Container isolation without seccomp filtering (seccomp BPF generation failed). |
| **seccomp-only** (degraded) | bwrap is not installed. Execution falls back to direct subprocess. **All commands require user confirmation.** |
| **none** (degraded) | Neither bwrap nor seccomp available. Direct execution with mandatory user confirmation. |

### What the Sandbox Does

1. **Filesystem isolation:** System directories (`/usr`, `/lib`, `/lib64`, `/bin`, `/etc`) are mounted read-only. The working directory and `/tmp` are read-write.
2. **Network control:** `--unshare-net` isolates the container from the network when `allow_network` is `false`. This is the default.
3. **SSH credential isolation:** The `~/.ssh` directory is overmounted with a tmpfs (empty), with `known_hosts` re-mounted read-only if it exists. This prevents AI from accessing private SSH keys while preserving host verification.
4. **Process isolation:** `--die-with-parent` ensures the container is cleaned up if the parent Vim process dies.
5. **Seccomp syscall filtering:** A BPF program restricts available syscalls to a whitelist of ~50 safe syscalls (read, write, open, close, stat, etc.). Dangerous syscalls like `ptrace`, `mount`, `kexec_load`, `bpf`, `unshare` are explicitly blocked.

### Installing bwrap

**Ubuntu/Debian:**
```bash
sudo apt install bubblewrap
```

**Fedora/RHEL:**
```bash
sudo dnf install bubblewrap
```

**Arch:**
```bash
sudo pacman -S bubblewrap
```

**Verify installation:**
```bash
bwrap --version  # Should be >= 0.4.0
```

If `bwrap` is not installed, the sandbox operates in degraded mode — commands still execute, but every command requires explicit user confirmation.

### Sandbox Availability Detection

The sandbox builder checks:
1. bwrap binary is in PATH
2. bwrap version ≥ 0.4.0 (required for `--seccomp` flag)
3. User namespaces are available (`/proc/sys/kernel/unprivileged_userns_clone` or `/proc/sys/user/max_user_namespaces`)

Detection results are cached for 7 days in `~/.zaivim/sandbox_cache.json` to avoid repeated subprocess calls.

---

## L5 — Audit Logging

Every command execution is logged to JSONL audit files for traceability.

### Audit Log Location

```
~/.zaivim/audit/audit-YYYY-MM-DD.jsonl
```

### What is Logged

Each audit entry includes:
- **Timestamp** (ISO 8601 with microseconds)
- **Session ID** and **Execution ID**
- **Command** (sanitized — credentials redacted)
- **Parsed command structure** (sub-commands, arguments)
- **Harm level** (S, A, B, or none)
- **Working directory**
- **Full safety trace** (every layer's decision, detail, and latency)
- **Sandbox configuration** (effective mode, network mode, degraded status)
- **Execution result** (exit code, success, duration, stdout/stderr summaries)
- **User decision** (allow_once, deny_once, background)

### Credential Sanitization

Before writing to the audit log, the following patterns are redacted:

- PEM private key blocks → `***PRIVATE KEY***`
- Environment variables containing SECRET/TOKEN/PASSWORD/API_KEY → value replaced with `***`
- Bearer tokens → `Bearer ***`
- JWT tokens (eyJ... format) → `eyJ***`
- Database connection strings (postgres://, mysql://, etc.) → `***DSN***`
- URL query parameters containing keys or tokens → parameter value replaced with `***`
- CLI password flags (`--password=...`) → `--password=***`

### Log Rotation and Retention

- Logs are written to daily files: `audit-2026-05-30.jsonl`
- Files auto-rotate at 10,000 entries per file: `audit-2026-05-30.2.jsonl`, etc.
- Logs older than 30 days are automatically cleaned up.

### Querying Audit Logs

The audit logger supports querying by session ID, time range, and entry limit. These are programmatic APIs used internally — there is no built-in CLI query tool currently.

---

## Environment Filtering

Before execution, the subprocess environment is carefully constructed to prevent credential leakage:

### Default Mode (no explicit env vars)

When no environment variables are explicitly passed, only a whitelist of known-safe variables is copied from the parent process:

`HOME`, `USER`, `LOGNAME`, `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `PWD`, `SHELL`, `TERM`, `DISPLAY`, `EDITOR`, `VISUAL`, `VIRTUAL_ENV`, `CONDA_PREFIX`, `CONDA_DEFAULT_ENV`, `NVM_DIR`, `GOPATH`, `GOROOT`, `JAVA_HOME`, `PYTHONPATH`, `LD_LIBRARY_PATH`, `PKG_CONFIG_PATH`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `TMPDIR`, `TMP`, `TEMP`

Plus any variables starting with `LC_` or `CONDA_`.

### Custom Env Mode

When environment variables are explicitly provided, they are filtered to remove credential-like keys. A variable is considered a credential if its name (case-insensitive) contains any of: `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `API_KEY`, `APIKEY`, `CREDENTIAL`, `AUTH`, `PRIVATE_KEY`.

`PATH` is always added if not present.

---

## Background Task Execution

Commands can be run in the background by setting `background: true`. This is useful for long-running operations like builds, installations, or test suites.

### Task Lifecycle

1. Task is registered with status `starting`
2. A daemon thread starts the subprocess, status changes to `running`
3. On completion: status becomes `completed`, `timeout`, or `failed`
4. Audit entry is logged at completion (not at submission)
5. All running tasks are terminated on Vim exit via atexit handler

### Task States

| Status | Description |
|--------|-------------|
| `starting` | Task registered, thread starting |
| `running` | Subprocess is executing |
| `completed` | Finished normally (exit code available) |
| `timeout` | Exceeded timeout, killed |
| `failed` | Execution error occurred |

### Background Task Sandboxing

Background tasks also use the bwrap sandbox when available. The `--share-net` flag is explicitly stripped from sandbox arguments even if present, as a defense-in-depth measure.

---

## User Interaction: The Ask Flow

When a command cannot be automatically classified as safe, Zai.Vim prompts the user for a decision. This happens when:

1. **L2 policy returns `ask`** — no matching allow/deny rule exists
2. **L1 classifier returns `ask`** — safety score between 0.3 and 0.7
3. **L2.5 dataflow detects risk** — dangerous data-flow pattern found
4. **Sandbox is degraded** — bwrap unavailable, all commands require confirmation

### The Hint Message

When a command requires confirmation, the return value includes a `hint` field with contextual information:

```
[shell] bwrap 未安装，已降级为 seccomp 模式 | [shell] 评分: 0.45 (询问) | [shell] curl | bash: network content piped to interpreter (S级风险) | Use shell_allow_once or shell_deny_once to respond
```

This tells the user:
- Why the command was flagged (degraded sandbox, classifier score, dataflow risk)
- What action to take (`shell_allow_once` or `shell_deny_once`)

### Confirmation Flow

1. AI calls `shell_execute` with a command
2. The safety chain returns `decision: "ask"` with an `execution_id`
3. The command is stashed as "pending" (expires after 300 seconds)
4. The user is prompted: accept with `shell_allow_once` or reject with `shell_deny_once`
5. If accepted: AI re-invokes `shell_execute` with the same command (now temporarily allowed)
6. If rejected: the pending command is discarded

---

## Configuration Reference

### User Data Directory

The user-level data directory is resolved with this priority:

1. `ZAI_USER_DIR` environment variable (if set)
2. `~/.zaivim/` — if it contains config files (`assistants.yaml` or `assistants.json`)
3. `~/.local/share/zai/` — legacy appdirs location, used only if it has data and `~/.zaivim/` does not
4. `~/.zaivim/` — default for new installations

To migrate from the legacy location: use `:call zai#MigrateDataDir()` in Vim, or simply move the files manually.

### Files and Locations

| File | Purpose |
|------|---------|
| `~/.zaivim/assistants.yaml` | Provider and model definitions — add `shell_classifier: true` to a model entry to prefer it for classification |
| `~/.zaivim/shell_policy.yaml` | User-level shell policy rules |
| `.zaivim/project.yaml` (field: `shell_policy`) | Project-level shell policy rules |
| `~/.zaivim/sandbox_cache.json` | Cached sandbox availability detection |
| `~/.zaivim/audit/audit-*.jsonl` | Audit log files |

### Complete `shell_policy.yaml` Example

```yaml
# ~/.zaivim/shell_policy.yaml
# Shell policy rules — checked in order within each behavior.

rules:
  # === ALLOW: Commands safe to execute without prompting ===
  - behavior: allow
    match:
      type: prefix
      pattern: "ls "
    description: "List directory contents"

  - behavior: allow
    match:
      type: prefix
      pattern: "pwd"
    description: "Print working directory"

  - behavior: allow
    match:
      type: prefix
      pattern: "echo "
    description: "Echo is safe"

  - behavior: allow
    match:
      type: prefix
      pattern: "cat "
    description: "Read file contents"

  - behavior: allow
    match:
      type: prefix
      pattern: "find "
    description: "Find files"

  - behavior: allow
    match:
      type: prefix
      pattern: "grep "
    description: "Search file contents"

  - behavior: allow
    match:
      type: prefix
      pattern: "git "
    description: "Git version control"

  - behavior: allow
    match:
      type: prefix
      pattern: "python3 "
    description: "Python scripts"

  - behavior: allow
    match:
      type: prefix
      pattern: "npm "
    description: "Node package manager"

  - behavior: allow
    match:
      type: prefix
      pattern: "pip "
    description: "Python package installer"

  # === ASK: Commands that require user confirmation ===
  - behavior: ask
    match:
      type: prefix
      pattern: "pip install"
    description: "Package installation needs review"

  - behavior: ask
    match:
      type: prefix
      pattern: "npm install -g"
    description: "Global package installation needs review"

  - behavior: ask
    match:
      type: prefix
      pattern: "chmod "
    description: "Permission changes need confirmation"

  - behavior: ask
    match:
      type: prefix
      pattern: "chown "
    description: "Ownership changes need confirmation"

  - behavior: ask
    match:
      type: prefix
      pattern: "docker rm"
    description: "Container removal needs confirmation"

  - behavior: ask
    match:
      type: wildcard
      pattern: "curl * | *"
    description: "Piped curl commands need review"

  # === DENY: Commands that are always blocked ===
  - behavior: deny
    match:
      type: prefix
      pattern: "shutdown "
    description: "System shutdown blocked"

  - behavior: deny
    match:
      type: prefix
      pattern: "reboot "
    description: "System reboot blocked"
```

Note: You do not need to add deny rules for the 6 built-in dangerous patterns (`rm -rf /`, `dd if=* of=/dev/*`, `mkfs.*`, `fork bomb`, etc.) — those are always active.

### Complete Project Config Example

```yaml
# .zaivim/project.yaml
shell_policy:
  rules:
    - behavior: allow
      match:
        type: prefix
        pattern: "make "
      description: "Project build system"

    - behavior: allow
      match:
        type: prefix
        pattern: "pytest "
      description: "Run tests"

    - behavior: allow
      match:
        type: wildcard
        pattern: "python3 setup.py *"
      description: "Package setup"

    - behavior: ask
      match:
        type: prefix
        pattern: "docker compose"
      description: "Container orchestration needs review"

    - behavior: ask
      match:
        type: prefix
        pattern: "ansible-playbook"
      description: "Deployment playbooks need review"
```

---

## How to Work Within the Constraints

### For Users: Getting Started

1. **Install bwrap** for full sandbox protection:
   ```bash
   sudo apt install bubblewrap   # Debian/Ubuntu
   ```

2. **Check your current safety status:**
   Ask the AI: "show me the shell sandbox info" — this calls `shell_sandbox_info` and shows sandbox mode, policy rule counts, and classifier availability.

3. **Start with the defaults.** The built-in deny rules protect against the most dangerous commands. Commands without explicit rules will prompt for confirmation.

4. **Add allow rules gradually.** When you find yourself repeatedly approving the same type of command, add an allow rule to your `~/.zaivim/shell_policy.yaml`.

5. **Use project-level rules** for project-specific commands (build systems, test runners, deployment scripts). This keeps rules scoped to the right context.

### For the AI Assistant: Understanding Capabilities

When a user asks "I don't know how to do X" or "can you help me with Y?", the AI should:

1. **Check sandbox status first** — call `shell_sandbox_info` to understand the current environment:
   - Is bwrap available? (If not, every command will require confirmation.)
   - What policy rules are active?
   - Is the AI classifier available?

2. **Understand what will trigger `ask` vs `allow`:**
   - Commands matching an `allow` rule → execute immediately
   - Commands not matching any rule → require user confirmation
   - Commands in degraded sandbox → always require confirmation
   - Commands with dangerous dataflow → require confirmation even with allow rules

3. **Explain constraints clearly:**
   - "This command needs your approval because the sandbox is running in degraded mode (bwrap not installed)."
   - "This command was flagged by the dataflow detector as a potential remote code execution risk."
   - "This command isn't covered by any allow rule yet — you can add one to `shell_policy.yaml` to skip future prompts."

4. **Guide users to add rules:**
   - "If you'll use `docker compose` commands frequently, add this to your `~/.zaivim/shell_policy.yaml`: ..."

### Common Scenarios and Solutions

**"Every command asks for confirmation"**
→ bwrap is probably not installed. Run `sudo apt install bubblewrap` and restart Vim.

**"I want to allow all git commands"**
→ Add to `~/.zaivim/shell_policy.yaml`:
```yaml
rules:
  - behavior: allow
    match:
      type: prefix
      pattern: "git "
    description: "Git operations"
```

**"I want to block a specific dangerous command in my project"**
→ Add to `.zaivim/project.yaml`:
```yaml
shell_policy:
  rules:
    - behavior: deny
      match:
        type: wildcard
        pattern: "rm -rf /important-data/*"
      description: "Protect critical project data"
```

**"A command I think is safe keeps getting flagged as ask"**
→ Check the `hint` field in the ask response. It may be the classifier score, dataflow detection, or degraded sandbox. Address the specific reason.

**"I want to review the audit log for a specific session"**
→ The audit logs are JSONL files in `~/.zaivim/audit/`. Each line is a JSON object with session_id, command, and execution details.

---

## Troubleshooting

### Sandbox Issues

| Symptom | Likely Cause | Solution |
|---------|-------------|----------|
| "bwrap not found in PATH" | bubblewrap not installed | `sudo apt install bubblewrap` |
| "bwrap version < 0.4.0" | Outdated bwrap | Upgrade bubblewrap package |
| "user namespaces not available" | Kernel restriction | Check `sysctl kernel.unprivileged_userns_clone=1` |
| All commands require confirmation | Degraded sandbox mode | Install bwrap to restore automatic allow |

### Policy Issues

| Symptom | Likely Cause | Solution |
|---------|-------------|----------|
| Rule not taking effect | YAML syntax error | Check for warnings in Vim `:messages` |
| Empty rules file warning | Rules list is `[]` or missing `rules` key | Ensure file has non-empty rules list |
| Hot reload not working | File not saved or mtime unchanged | Save the file and re-run command |
| Project rules not loading | Config file not found in directory tree | Ensure `.zaivim/project.yaml` exists in CWD or parent |

### Classifier Issues

| Symptom | Likely Cause | Solution |
|---------|-------------|----------|
| "classifier unavailable" | LLM client not reachable | Check provider config and API key |
| "LLM API timeout" | Network or API issue | Classifier degrades to ask — safe fallback |
| "LLM API rate limit" | Too many classification requests | Results are cached per session |

### Execution Issues

| Symptom | Likely Cause | Solution |
|---------|-------------|----------|
| Command timed out | `timeout` too short for the operation | Increase `timeout` parameter (max 600s) |
| Output truncated | Output exceeded `max_output_bytes` | Increase `max_output_bytes` or redirect to file |
| Cross-session abort rejected | Wrong session_id | Each session can only abort its own processes |
| Background task not found | Task already completed or task_id invalid | Task IDs are 12-char hex strings |

---

## Security Considerations

### What the Shell Tool Protects Against

- **Accidental data destruction** — `rm -rf /`, `dd` to block devices, `mkfs`
- **Fork bombs and resource exhaustion** — detected and blocked
- **Remote code execution via pipes** — `curl | bash` patterns detected
- **Credential leakage** — environment variables filtered, SSH keys isolated, audit logs sanitized
- **Network exfiltration** — network disabled by default in sandbox
- **Privilege escalation** — `ptrace`, `mount`, `bpf`, `kexec_load` syscalls blocked via seccomp

### What the Shell Tool Does NOT Protect Against

- **Malicious commands that match allow rules** — if you whitelist `bash`, any bash command can run
- **Social engineering** — the AI can still suggest dangerous commands that pass policy checks
- **Kernel vulnerabilities** — seccomp BPF provides syscall filtering, not kernel exploit mitigation
- **Side-channel attacks** — timing, power analysis, etc. are out of scope
- **Commands run outside the tool** — direct terminal commands are not intercepted

### Best Practices

1. **Install bwrap** for sandbox isolation — this is the strongest protection layer
2. **Be conservative with allow rules** — start with `ask` and upgrade to `allow` once you're confident
3. **Use project-level deny rules** to protect critical project data
4. **Review audit logs periodically** for unexpected command patterns
5. **Keep allow rules specific** — prefer `wildcard: "git *"` over `prefix: "git "` when you want exact control
6. **Test rules** by trying commands you expect to be blocked/allowed and verifying the behavior

---

## Related Documentation

- [File Tool](tools/file.md) — File operations with similar permission model
- [Web Tool](tools/web.md) — Web fetch and search operations
- [Tool System Overview](tools/README.md) — How tools are loaded, registered, and managed
- [Configuration Guide](configuration.md) — Full Zai.Vim configuration reference

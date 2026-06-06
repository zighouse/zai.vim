# Skills System

## Overview

Skills extend zai.vim's AI assistant with structured, reusable capabilities. A skill is defined by a `SKILL.md` file — a YAML frontmatter contract plus a Markdown body describing how to use it. This "Text-as-Protocol" design means skills are both human-readable documentation and machine-executable contracts.

Skills can come from three sources:
- **Native** — bundled with zai.vim or created by the user
- **External** — installed from a URL
- **MCP** — discovered from MCP (Model Context Protocol) servers

## Quick Start

### List installed skills

```vim
:ZaiSkillList
```

Filter by security domain:

```vim
:ZaiSkillList workspace
```

### View skill details

```vim
:ZaiSkillInfo my-skill
```

### Enable / Disable a skill

```vim
:ZaiSkillEnable my-skill
:ZaiSkillDisable my-skill
```

### Install a skill from URL

```vim
:ZaiSkillInstall https://example.com/skills/my-skill.tar.gz sha256checksum
```

If no checksum is provided, zai.vim will prompt for confirmation.

### Update a skill

```vim
:ZaiSkillUpdate my-skill https://example.com/skills/my-skill-v2.tar.gz sha256checksum
```

### View trust history

```vim
:ZaiSkillHistory my-skill
```

### Uninstall a skill

```vim
:ZaiSkillUninstall my-skill
```

### Create a new skill

The easiest way to create a skill is to ask the AI assistant. The workflow:

1. **Ask the AI** to create a skill for a specific task (e.g., "create a skill that translates Markdown files to Chinese")
2. The AI calls `skill_read_spec` to learn the SKILL.md format, then creates the skill under `.zaivim/skills/<name>/SKILL.md`
3. The AI validates the format with `skill_validate`
4. **Debug** the skill in your project — it is automatically discovered and usable immediately
5. When satisfied, **deploy** it globally:

```vim
:ZaiSkillDeploy my-skill
" Force overwrite if target exists:
:ZaiSkillDeploy! my-skill
```

You can also have the AI deploy for you — it will call `skill_deploy` and ask for confirmation before overwriting.

### Deploy a project skill

```vim
:ZaiSkillDeploy my-skill           " Deploy (refuse if target exists)
:ZaiSkillDeploy! my-skill          " Force overwrite
```

Copies `.zaivim/skills/<name>/` to `~/.zaivim/skills/<name>/`, making it available globally.
The skill is validated before deployment — invalid SKILL.md files are rejected.

## Model Compatibility

Skills rely on the AI model's ability to reason about available tools before acting. This means **thinking/reasoning mode significantly affects skill discovery quality**.

### Recommended: Thinking Mode Enabled

Models with thinking enabled (e.g., `extra_body: {thinking: {type: enabled}}`) reason about the `## Available Skills` section in the system prompt and proactively call the `skill` tool when a user request matches a registered skill. This produces the best results — the model follows the skill's SKILL.md instructions, which often include best practices like preserving original files.

### Known Limitation: Thinking Mode Disabled

Models with thinking disabled (`thinking: {type: disabled}`) or models that lack reasoning capability tend to skip skill discovery. They see the same system prompt and tool list, but act reflexively — reaching for the most obvious tool (`read_file`, `write_file`) without considering registered skills. This can lead to:

- Skills being ignored entirely
- Suboptimal behavior (e.g., overwriting original files instead of creating translations with a `.zh.md` suffix)

### Configuration Tip

For best skill support, prefer models with thinking enabled. In `assistants.yaml`:

```yaml
# Good — thinking enabled, skills work reliably
params:
  extra_body: {thinking: {type: enabled}}
  reasoning_effort: high

# Skills may be ignored — thinking disabled
params:
  extra_body: {thinking: {type: disabled}}
```

## SKILL.md Format

Every skill is a directory containing a `SKILL.md` file. The file uses YAML frontmatter for structured metadata and Markdown body for usage instructions.

### Minimal Example

```
my-skill/
└── SKILL.md
```

```markdown
---
name: my-skill
description: A brief description of what this skill does.
---

# My Skill

Instructions for how the AI should use this skill.

## Usage

Describe when and how to invoke this skill.
```

### Full Frontmatter Reference

```markdown
---
# Required fields
name: my-skill                    # kebab-case identifier (lowercase, digits, hyphens)
description: What this skill does # one-line summary

# Optional fields
version: "1.0.0"                  # semantic version
security_domain: workspace        # local | workspace | personal | public
origin: native                    # native | adapted | external
trust_level: L1                   # L1 | L2 | L3
dependencies:                     # required tools or services
  python: ">=3.10"
  docker: true
output_schema: |                  # expected output format (YAML)
  type: object
  properties:
    result:
      type: string

# Claude Code compatible fields (hyphenated or underscore form accepted)
when_to_use: When the user asks for X   # natural-language trigger description
arguments: file_path output_format       # named positional parameters
argument_hint: "<file> <format>"         # human-readable argument hint
allowed_tools: read_file write_file      # tools the skill is allowed to use
disallowed_tools: shell_execute          # tools the skill must NOT use
tags: documentation, translation         # categorization tags
paths: "*.md" "*.txt"                    # file path patterns
disable_model_invocation: false          # hide from automatic model discovery
user_invocable: true                     # whether user can invoke via /name
localized_descriptions:                  # i18n descriptions
  zh: 该技能的功能说明
context: ""                              # extra context injected into prompt
agent: ""                                # target agent type
model: ""                                # target model override
effort: ""                               # reasoning effort level
hooks: {}                                # lifecycle hooks (reserved)
shell: ""                                # shell environment (reserved)
---

# Skill Body

Markdown content describing the skill's capabilities and usage instructions.
```

> **Note**: zai.vim accepts both hyphenated (`allowed-tools`) and underscore (`allowed_tools`) key forms in frontmatter. Hyphenated keys are automatically mapped to their underscore equivalents for Claude Code compatibility.

### Field Details

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | kebab-case identifier (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`) |
| `description` | No* | — | One-line summary (inferred from body if missing) |
| `version` | No | `"0.1.0"` | Semantic version string |
| `security_domain` | No | `workspace` | Permission scope (see Security Domains) |
| `origin` | No | `native` | How the skill was introduced |
| `trust_level` | No | `L1` | Initial trust level |
| `dependencies` | No | `{}` | Required tools or services |
| `output_schema` | No | `""` | Expected output format |
| `when_to_use` | No | `""` | Natural-language trigger description for auto-discovery |
| `arguments` | No | `[]` | Named positional parameters (space/comma-separated or YAML list) |
| `argument_hint` | No | `""` | Human-readable argument hint, e.g. `"<file> <format>"` |
| `allowed_tools` | No | `[]` | Tools the skill is allowed to use (space/comma-separated or YAML list) |
| `disallowed_tools` | No | `[]` | Tools the skill must NOT use |
| `tags` | No | `[]` | Categorization tags |
| `paths` | No | `[]` | File path patterns relevant to this skill |
| `disable_model_invocation` | No | `false` | Hide from automatic model discovery (user can still invoke via `/name`) |
| `user_invocable` | No | `true` | Whether user can invoke via `/name` slash command |
| `localized_descriptions` | No | `{}` | i18n descriptions (e.g. `zh: 中文描述`) |
| `context` | No | `""` | Extra context injected into the system prompt |
| `agent` | No | `""` | Target agent type override |
| `model` | No | `""` | Target model override |
| `effort` | No | `""` | Reasoning effort level |
| `hooks` | No | `{}` | Lifecycle hooks (reserved for future use) |
| `shell` | No | `""` | Shell environment override (reserved for future use) |

\* `name` and `description` are automatically inferred from the directory name and body text if omitted from frontmatter.

## Variable System

Skills support variable expansion in SKILL.md body text. Variables are expanded at invocation time before the content is sent to the AI model.

### Project Root

```
@{project-root}
```

Expands to the absolute path of the project root directory (discovered by upward search for `.zaivim/` or `.claude/`).

### Session Variables

```
${CLAUDE_SESSION_ID}  or  ${ZAI_SESSION_ID}
${CLAUDE_EFFORT}      or  ${ZAI_EFFORT}
${CLAUDE_SKILL_DIR}   or  ${ZAI_SKILL_DIR}
${CLAUDE_PROJECT_ROOT} or ${ZAI_PROJECT_ROOT}
```

Dual-name compatibility: both `CLAUDE_*` and `ZAI_*` prefixes are supported, making skills portable between Claude Code and zai.vim.

| Variable | Description |
|----------|-------------|
| `${ZAI_SESSION_ID}` / `${CLAUDE_SESSION_ID}` | Current session identifier |
| `${ZAI_EFFORT}` / `${CLAUDE_EFFORT}` | Reasoning effort level |
| `${ZAI_SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` | Directory containing the skill's SKILL.md |
| `${ZAI_PROJECT_ROOT}` / `${CLAUDE_PROJECT_ROOT}` | Project root directory |

### Positional Arguments

```
$ARGUMENTS         # full argument string
$ARGUMENTS[0]      # first positional argument (0-indexed)
$0                 # shorthand for $ARGUMENTS[0]
$1                 # shorthand for $ARGUMENTS[1]
```

### Named Arguments

When `arguments` is declared in frontmatter, positional arguments are also available by name:

```yaml
arguments: file_path output_format
```

With invocation args `"README.md pdf"`, both `$file_path` and `$0` expand to `README.md`.

Out-of-range positional arguments (e.g. `$50` when only 3 args provided) are left unchanged rather than silently deleted.

## Dynamic Context Injection

Skills can execute shell commands and inject their output into the skill body using `!`cmd`` syntax. This enables dynamic, context-aware skill content.

### Inline Form

```
The current git branch is !`git branch --show-current`.
```

### Block Form

```
```!
ls -la
```
```

### Security Model

Dynamic injection follows zai.vim's layered security architecture:

1. **Domain/Origin Gate**: Only `public`/`personal` domain skills, or `workspace` skills with `native` origin, are allowed to execute injected commands. External/untrusted skills are blocked.
2. **Sandboxed Execution** (default): Commands run inside a bwrap sandbox with seccomp syscall filtering — the same security model as `shell_execute`. If the sandbox is unavailable, execution is blocked (fail-closed).
3. **Global Kill Switch**: Set `disableSkillShellExecution: true` in settings to disable all dynamic injection.

### Shell Execution Configuration

Control how injected commands are executed via `skillShellExecution` in `~/.zaivim/settings.json`:

**Global setting** (applies to all skills):
```json
{
  "skillShellExecution": "sandbox"
}
```

**Per-skill rules** (regex-based, first match wins):
```json
{
  "skillShellExecution": [
    { "pattern": "^git-", "mode": "host" },
    { "pattern": "^docker-", "mode": "docker" },
    { "pattern": ".*", "mode": "sandbox" }
  ]
}
```

| Mode | Behavior |
|------|----------|
| `sandbox` (default) | bwrap sandbox with seccomp filtering — matches zai.vim security philosophy |
| `host` | Direct host execution (opt-in, bypasses sandbox) |
| `docker` | Docker container execution (reserved, currently falls back to sandbox) |

**Configuration precedence**:
1. Per-skill regex rules (first match wins)
2. Global string value (`"sandbox"`, `"host"`, or `"docker"`)
3. Default: `"sandbox"`

## Claude Code Compatibility

zai.vim is compatible with the Claude Code skill format. Skills written for Claude Code can be used directly, and zai.vim skills can include CC-specific fields.

### Field Mapping

CC's hyphenated field names are automatically mapped to zai.vim's underscore form:

| Claude Code | zai.vim |
|-------------|---------|
| `allowed-tools` | `allowed_tools` |
| `disallowed-tools` | `disallowed_tools` |
| `user-invocable` | `user_invocable` |
| `disable-model-invocation` | `disable_model_invocation` |

### Project Root Discovery

zai.vim searches upward from the current directory for project markers:
- `.zaivim/` (zai.vim project config)
- `zai.project/` (legacy Python version — see [migration guide](config-migration-guide.md))
- `.claude/` (Claude Code project config)

This means zai.vim automatically discovers skills in projects that use Claude Code's `.claude/skills/` or `.claude/commands/` directories.

### Importing Claude Code Skills

#### From Local Claude Code Installation

List discoverable CC skills:
```vim
:ZaiSkillImportClaude
```

Install selected CC skills:
```vim
:ZaiSkillImportClaude my-cc-skill another-skill
```

Scans `~/.claude/commands/*.md` and `~/.claude/skills/*/SKILL.md` for importable skills. Installed skills are placed in `~/.zaivim/skills/` with zai.vim default frontmatter fields added (`security_domain: workspace`, `origin: external`, `trust_level: L1`).

#### From GitHub Repository

List skills available in a GitHub repo:
```vim
:ZaiSkillInstallGithub owner/repo .claude/commands
```

Install selected skills:
```vim
:ZaiSkillInstallGithub owner/repo .claude/commands skill-name-1 skill-name-2
```

Reads `GITHUB_TOKEN` or `GH_TOKEN` environment variable for authenticated API access (raises rate limit from 60 to 5000 requests/hour).

## Skill Visibility

Control which skills are visible to the AI model via `skillOverrides` in `~/.zaivim/settings.json`:

```json
{
  "skillOverrides": {
    "my-skill": "on",
    "experimental-skill": "name-only",
    "dangerous-skill": "user-invocable-only",
    "deprecated-skill": "off"
  }
}
```

| Visibility | Model Can See | User Can Invoke via `/name` | Description |
|------------|---------------|----------------------------|-------------|
| `on` (default) | Yes | Yes | Fully visible and invocable |
| `name-only` | Name only (no description) | Yes | Model knows it exists but not what it does |
| `user-invocable-only` | No | Yes | Hidden from model listing, user-invocable only |
| `off` | No | No | Completely disabled (same as `:ZaiSkillDisable`) |

## Directory Structure

Skills are discovered from multiple locations. Project-level skills take priority over user-level skills.

### User-level skills

```
~/.zaivim/skills/
├── my-skill/
│   ├── SKILL.md
│   └── ...
└── another-skill/
    ├── SKILL.md
    └── ...
```

All users of the system share these skills. This is where URL-installed and adapted skills are stored.

### Project-level skills

```
.zaivim/skills/
├── project-skill/
│   ├── SKILL.md
│   └── ...
```

### Claude Code directories (auto-discovered)

zai.vim automatically scans Claude Code skill directories in the project root:

```
.claude/skills/           # Modern CC format (directory per skill)
└── cc-skill/
    └── SKILL.md

.claude/commands/          # Legacy CC format (single .md files)
├── cc-command-1.md
└── cc-command-2.md
```

Skills from `.claude/` directories are registered with `origin: external` and `trust_level: L1`.

### Priority

When a skill exists in multiple locations:

1. Project `.zaivim/skills/` — takes priority, shadows all other versions
2. Project `.claude/skills/` and `.claude/commands/` — CC-compatible project skills
3. User `~/.zaivim/skills/` — fallback if no project version exists

## Security Model

### Security Domains

Skills declare their intended scope via `security_domain`:

| Domain | Scope | Examples |
|--------|-------|---------|
| `local` | Single file or buffer | Code formatting, linting |
| `workspace` | Project directory | File search, project-wide refactor |
| `personal` | User's personal data | Git operations, config editing |
| `public` | External network access | Web search, API calls |

### Trust Levels

Skills progress through trust levels via Human-in-the-Loop (HITL) confirmation:

| Level | Behavior | How to Reach |
|-------|----------|-------------|
| **L1** | Requires confirmation every invocation | Initial level for all new skills |
| **L2** | Auto-approved within declared domain | 3 consecutive safe uses in same domain |
| **L3** | Auto-approved with full trust | 20 consecutive safe uses (L2+, no security events) |

Trust can be manually downgraded at any time. Security-related changes (domain, schema) automatically reset trust to L1.

### L0 Intent Verification

The skill system adds a L0 verification layer on top of the existing shell security chain:

- **Intent boundary**: runtime behavior must stay within declared intent
- **Trust isolation**: trust does not propagate — sub-skills always auto-downgrade
- **Parse consistency**: AI interpretations are cached with version binding to prevent drift

### MCP Security

MCP-discovered tools go through enhanced HITL:

- First call to any MCP tool triggers confirmation
- Schema changes on reconnect trigger re-confirmation
- Tools removed from an MCP server are marked unavailable

## Skill Chains

Multiple skills can be executed in sequence via `SkillChain`:

```
Skill A → Skill B → Skill C
```

Features:
- Output from one skill is passed to the next
- Security checkpoints between each step (trust auto-downgrade for sub-skills)
- Exponential backoff retry on recoverable failures (1s, 2s, 4s)
- Partial success preservation — completed steps are preserved even if later steps fail

## Skill Installation

### From URL

```vim
:ZaiSkillInstall <url> [sha256-checksum]
```

Supported archive formats: `.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`, `.zip`.

Security measures:
- SHA256 checksum verification (recommended)
- Path traversal prevention (no `..` in archive entries)
- Symlink/hardlink filtering
- 100MB download size limit
- Atomic install with rollback on failure

### From Claude Code (Local)

Import skills from your local Claude Code installation:

```vim
" List importable CC skills
:ZaiSkillImportClaude

" Install selected skills
:ZaiSkillImportClaude skill-1 skill-2
```

Scans `~/.claude/commands/*.md` and `~/.claude/skills/*/SKILL.md`. Installed skills are placed in `~/.zaivim/skills/` with zai.vim governance fields added automatically.

### From GitHub Repository

Install skills from any GitHub repository's `.claude/commands/` or similar path:

```vim
" List skills in a GitHub repo
:ZaiSkillInstallGithub owner/repo .claude/commands

" Install selected skills
:ZaiSkillInstallGithub owner/repo .claude/commands skill-1 skill-2
```

Set `GITHUB_TOKEN` or `GH_TOKEN` environment variable for authenticated API access (raises rate limit from 60 to 5000 requests/hour).

### From MCP Server

MCP tools are automatically discovered when MCP servers are configured. No manual installation needed — tools appear as skills with `mcp-` name prefix.

## Skill Updates

```vim
:ZaiSkillUpdate <name> <url> [sha256-checksum]
```

The updater:
1. Downloads and validates the new version
2. Compares frontmatter (version, description, domain, schema, dependencies)
3. Displays a diff summary of changes
4. Performs atomic directory swap (old → `.bak`, new in place)
5. Auto-downgrades trust to L1 if security-related fields changed
6. Rolls back on failure

## Skill Creation Tools

The AI assistant has access to three dedicated tools for creating and managing skills. These tools are automatically discovered at startup.

### skill_read_spec

Returns the full SKILL.md format specification (this document) plus a creation guide. The AI calls this first to learn how to structure a skill.

**Output**: Complete `docs/skills.md` content plus step-by-step creation instructions.

**When the AI uses it**: When the user asks to create a new skill or customize an existing one.

### skill_validate

Validates a project skill's `SKILL.md` file using the parser. Checks frontmatter, required fields, name format, and field types.

**Parameters**:
- `name` — skill directory name under `.zaivim/skills/`

**Output**: Success with parsed metadata summary, or a description of parse errors.

**When the AI uses it**: After creating or editing a SKILL.md, to verify correctness before testing.

### skill_deploy

Copies a project skill to the user-level directory (`~/.zaivim/skills/`), making it globally available.

**Parameters**:
- `name` — skill name to deploy
- `force` (optional, default `false`) — overwrite if target already exists

**Behavior**:
- Validates SKILL.md before deploying (rejects invalid skills)
- Refuses to overwrite unless `force=True`
- Refreshes the skill registry after deployment

**When the AI uses it**: When the user is satisfied with a project skill and wants to install it globally.

## Audit Trail

All skill invocations are logged to `~/.zaivim/skill-audit.jsonl` in JSONL format. Each record includes:

- Timestamp, session ID
- Skill name, call chain
- Security domain, trust level
- Verification decision
- Execution time (ms)
- Result summary

Query with `jq`:

```bash
jq '.skill_name == "my-skill"' ~/.zaivim/skill-audit.jsonl
```

## Pattern Suggestions

The system monitors audit logs for frequently repeated skill chains. When a chain pattern exceeds a threshold (default: 5 uses within 7 days), it suggests creating a new skill to capture the pattern.

Generated suggestions include a SKILL.md draft with the chain description pre-filled.

## Vim Commands Reference

| Command | Description |
|---------|-------------|
| `:ZaiSkillList [domain]` | List installed skills, optionally filtered by domain |
| `:ZaiSkillInfo <name>` | Show detailed skill information |
| `:ZaiSkillEnable <name>` | Enable a disabled skill |
| `:ZaiSkillDisable <name>` | Disable a skill without removing it |
| `:ZaiSkillInstall <url> [checksum]` | Install a skill from a URL |
| `:ZaiSkillUpdate <name> <url> [checksum]` | Update a skill from a URL |
| `:ZaiSkillImportClaude [names...]` | Import CC skills from local `~/.claude/` installation |
| `:ZaiSkillInstallGithub <repo> <path> [names...]` | List/install skills from a GitHub repository |
| `:ZaiSkillHistory <name> [limit]` | Show trust evolution timeline |
| `:ZaiSkillUninstall <name>` | Remove a skill (with confirmation) |
| `:ZaiSkillDeploy[!] <name>` | Deploy project skill to user-level (`!` = force overwrite) |

Tab completion is available for skill names in all commands that accept `<name>`.

## Configuration Reference

### User Directory Override

The user-level skills directory can be overridden:

- **Environment variable**: `ZAI_USER_DIR=/custom/path`
- **Vim config**: `let g:zai_user_dir = '/custom/path'`

When neither is set, zai.vim uses `~/.zaivim/` if it exists, otherwise falls back to the platform default (`~/.local/share/zai/` on Linux).

### Settings File (`~/.zaivim/settings.json`)

All skill-related settings are stored in `~/.zaivim/settings.json`:

```json
{
  "disableSkillShellExecution": false,
  "skillShellExecution": "sandbox",
  "skillOverrides": {}
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `disableSkillShellExecution` | boolean | `false` | Global kill switch — disables all `!`cmd`` dynamic injection |
| `skillShellExecution` | string or array | `"sandbox"` | Shell execution mode: `"sandbox"`, `"host"`, `"docker"`, or per-skill regex rules |
| `skillOverrides` | object | `{}` | Per-skill visibility: `"on"`, `"name-only"`, `"user-invocable-only"`, `"off"` |

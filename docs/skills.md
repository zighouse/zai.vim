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
---

# Skill Body

Markdown content describing the skill's capabilities and usage instructions.
```

### Field Details

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | kebab-case identifier (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`) |
| `description` | Yes | — | One-line summary |
| `version` | No | `"0.1.0"` | Semantic version string |
| `security_domain` | No | `workspace` | Permission scope (see Security Domains) |
| `origin` | No | `native` | How the skill was introduced |
| `trust_level` | No | `L1` | Initial trust level |
| `dependencies` | No | `{}` | Required tools or services |
| `output_schema` | No | `""` | Expected output format |

## Directory Structure

Skills are discovered from two locations, with project-level skills taking priority over user-level skills.

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

Project-level skills override user-level skills with the same name (the user-level version is "shadowed").

### Priority

When a skill exists in both locations:

1. Project `.zaivim/skills/` — takes priority, shadows the user-level version
2. User `~/.zaivim/skills/` — fallback if no project version exists

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
| `:ZaiSkillHistory <name> [limit]` | Show trust evolution timeline |
| `:ZaiSkillUninstall <name>` | Remove a skill (with confirmation) |
| `:ZaiSkillDeploy[!] <name>` | Deploy project skill to user-level (`!` = force overwrite) |

Tab completion is available for skill names in all commands that accept `<name>`.

## Configuration Override

The user-level skills directory can be overridden:

- **Environment variable**: `ZAI_USER_DIR=/custom/path`
- **Vim config**: `let g:zai_user_dir = '/custom/path'`

When neither is set, zai.vim uses `~/.zaivim/` if it exists, otherwise falls back to the platform default (`~/.local/share/zai/` on Linux).

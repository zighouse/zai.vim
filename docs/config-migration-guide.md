# Configuration File Naming Migration Guide

This document explains the configuration file naming change between the Python (legacy) and Node.js versions of zai.vim. If you are an existing user migrating from the Python version, follow this guide to update your configuration files.

## Why The Change

As part of the Node.js migration, configuration files have been consolidated under a single `.zaivim/` directory for consistency and discoverability:

| Reason | Detail |
|--------|--------|
| **Consistency** | All configuration lives under `~/.zaivim/` instead of scattered across the filesystem |
| **Modern conventions** | Matches tools like `.gitconfig`, `.npmrc`, `.claude/` |
| **Simplicity** | File names are shorter (`project.yaml` vs `zai_project.yaml`) |
| **Discoverability** | A single `.zaivim/` directory makes it clear where zai.vim stores its configuration |

## What Changed

### User Configuration

| Legacy (Python) | New (Node.js) |
|-----------------|---------------|
| `~/.zaivimrc.yaml` | `~/.zaivim/assistants.yaml` |

### Project Configuration

| Legacy (Python) | New (Node.js) |
|-----------------|---------------|
| `zai.project/zai_project.yaml` | `.zaivim/project.yaml` |

> **Note on other legacy paths**: The Python version also searched for `zai_project.yaml` (flat file in project root), `.zaivim/zai_project.yaml`, and `.zai/zai_project.yaml`. These paths are **not** supported by the Node.js version and require manual migration.

### PID File (Node.js only)

| File | Purpose |
|------|---------|
| `~/.zaivim/engine.pid` | Engine daemon process ID (new in Node.js version) |

## How to Migrate

### Step 1: Migrate User Configuration

```bash
# Copy your old user config to the new location
cp ~/.zaivimrc.yaml ~/.zaivim/assistants.yaml
```

Or create a new one:

```yaml
# ~/.zaivim/assistants.yaml
services:
  openai:
    api_key: sk-your-api-key
    models: [gpt-4, gpt-3.5-turbo]
    type: openai
    default_model: gpt-4

defaults:
  provider: openai
  model: gpt-4
  temperature: 0.7
  maxTokens: 4096
```

### Step 2: Migrate Project Configuration

```bash
# Move your project config to the new location
mkdir -p .zaivim
mv zai.project/zai_project.yaml .zaivim/project.yaml
```

Or if your project had a flat `zai_project.yaml` in the root:

```bash
mkdir -p .zaivim
mv zai_project.yaml .zaivim/project.yaml
```

The Node.js version uses a simplified YAML structure:

```yaml
# .zaivim/project.yaml
sandbox:
  enabled: false
  type: none
  work_dir: /tmp/zaivim-sandbox
  timeout: 30000
```

### Step 3: Verify

```bash
# Check that the engine detects your configuration
zaivim ping

# Or directly verify config loading
node -e "const {loadConfig} = require('@zaivim/engine'); console.log(loadConfig());"
```

## Configuration File Locations (Reference)

| File | Scope | Purpose |
|------|-------|---------|
| `~/.zaivim/assistants.yaml` | User | AI provider definitions and API keys |
| `.zaivim/project.yaml` | Project | Sandbox, Docker container, and project settings |
| `~/.zaivim/engine.pid` | Runtime | Engine daemon PID (auto-managed) |

Both user and project config files support environment variable interpolation (`$VAR_NAME` or `${VAR_NAME}`) in string values.

## Old Paths No Longer Supported

The following paths are **not** automatically discovered by the Node.js version:

| Path | Previous Use | Action Required |
|------|-------------|-----------------|
| `zai.project/zai_project.yaml` | Python project config | Rename to `.zaivim/project.yaml` |
| `zai_project.yaml` | Python project config | Rename to `.zaivim/project.yaml` |
| `.zaivim/zai_project.yaml` | Python compat config | Rename to `.zaivim/project.yaml` |
| `.zai/zai_project.yaml` | Python compat config | Rename to `.zaivim/project.yaml` |
| `~/.zaivimrc.yaml` | Python user config | Rename to `~/.zaivim/assistants.yaml` |

## Reference

- Decision record: [ADR: Config Directory and File Naming](adr-config-naming.md)
- Configuration guide: [Configuration Overview](configuration/README.md)
- Project configuration: [Project Configuration](configuration/project.md)

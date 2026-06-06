# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Zai.Vim is a Vim plugin that integrates AI assistants directly into the Vim editor. It manages multiple AI chat sessions simultaneously, records conversation logs, and allows loading logs to continue previous conversations. The plugin supports flexible model/prompt switching, file attachments, and various AI tool calls.

## Common Development Tasks

### Installation and Setup
- Install Python dependencies: `pip install -r requirements.txt`
- Use the installation script for optional dependencies: `python3 python3/install.py --all-optional`
- Install system dependencies (Linux): `sudo apt install docker.io docker-compose chromium-browser build-essential python3-dev`
- For development, you may need to install the plugin locally for testing

### Configuration System
**IMPORTANT**: Zai.Vim 使用两套配置系统，分别对应 Python 和 Node.js 版本：

#### Python 版本配置（旧系统）
- 用户配置: `~/.zaivimrc.yaml`
- 项目配置: `zai.project/zai_project.yaml`

#### Node.js 版本配置（新系统 - 当前迁移目标）
- **用户配置**: `~/.zaivim/assistants.yaml` - Provider 配置、API keys
- **项目配置**: `.zaivim/project.yaml` - Sandbox、工作目录配置
- **PID 文件**: `~/.zaivim/engine.pid` - 引擎进程 ID

**配置加载优先级** (Node.js):
1. 项目配置优先读取新命名 `.zaivim/project.yaml`
2. Fallback 到旧命名 `zai.project/zai_project.yaml` (向后兼容)
3. 环境变量可覆盖上述配置

**决策记录**: 详见 `docs/adr-config-naming.md`
**迁移指南**: 详见 `docs/config-migration-guide.md`

### Testing
- Run individual test files: `python3 python3/mytest.py` or `python3 python3/test_round.py`
- There is no formal test suite; tests are scattered in various Python files
- Check for `.swp` files in `python3/` that may indicate test scripts in development

### Linting and Code Quality
- No specific linting configuration found
- Python code follows PEP 8 conventions
- Vim script files use standard Vim script syntax

## Architecture and Key Components

### Vim Script Layer (`autoload/`, `plugin/`)
- **Entry point**: `plugin/zai.vim` - Main plugin initialization and command definitions
- **Core modules** in `autoload/zai/`:
  - `zai.vim`: Main dispatch and session management
  - `chat.vim`: Chat interface and window management
  - `util.vim`: Utility functions and helpers
  - `comp.vim`: Code completion functionality
  - `version.vim`: Version information
- **User commands**: Defined in `plugin/zai.vim` with mappings to autoload functions

### Python Backend (`python3/`)
- **Main AI client**: `aichat.py` - Core chat logic, session management, and AI communication
- **Client interface**: `client.py` - Input handling, command parsing, and session management (not HTTP client)
- **Configuration**: `config.py` - Loads user and project configurations
- **Tool system**: Multiple tool modules for AI interaction:
  - `tool.py` - Base tool system and registry
  - `tool_file.py` - File operations (read, write, search, diff)
  - `tool_web.py` - Web operations (fetch content, search, download)
  - `tool_shell.py` - Secure shell execution in Docker containers
  - `tool_grep.py` - File searching with grep-like functionality
  - `tool_ai.py` - AI-specific operations (image generation)
  - `tool_browser.py` - Browser automation (experimental)
  - `tool_os.py` - System information
  - `tool_archive.py` - Conversation archiving
- **Supporting modules**:
  - `paths.py` - Centralized path management (user dir, skills, logs, sessions)
  - `generator.py` - Content generation utilities
  - `logger.py` - Logging functionality
  - `tokens.py` - Token counting and management
  - `install.py` - Dependency installation script

### Project Configuration System
- **User configuration**: `~/.zaivim/assistants.yaml` defines available AI services and models
- **Project configuration**: `zai.project/zai_project.yaml` (or `zai_project.yaml`) in project root
  - Configures sandbox directory, Docker container settings, and package installations
  - Supports `pip_install`, `apt_install`, and `post_start_commands` for container setup
- **Configuration precedence**: Project config overrides user config, which overrides defaults

### Session and Tool Architecture
- **Multiple chat sessions**: Each session maintains its own state, configuration, and tool context
- **Tool chaining**: AI can call multiple tools in a single response; tools can be loaded/unloaded per session
- **Sandbox isolation**: File and shell operations are confined to sandbox directories for security
- **Docker integration**: `tool_shell` uses Docker containers (`taskbox`) for isolated command execution

## Key Patterns and Conventions

### Vim-Python Communication
- Vim script calls Python functions via `:python3` or `:py3` commands
- Python returns results to Vim through stdout/stderr or temporary files
- Session state is maintained in Python, with Vim providing the UI layer

### Tool Implementation Pattern
- Each tool module defines a class with methods corresponding to available functions
- Tools are registered in `tool.py`'s global registry
- Tool methods must return JSON-serializable results or raise exceptions for errors
- Tools can have both synchronous and asynchronous implementations

### Configuration Loading
- Configuration is loaded lazily when first needed
- Project configuration is searched upward from current directory
- Environment variables override configuration file settings for API keys

### Error Handling
- Python exceptions are caught and formatted for display in Vim
- Tool errors are returned as structured error objects
- Network errors trigger retries with exponential backoff

## Development Notes

- **Experimental directories**: `.zaivim/` contains project config and can be ignored for code development
- **Virtual environments**: `python3/voicechat_env/` and `python3/funasr_env/` are experimental Python environments
- **Windows support**: `zai-win32/` contains Windows-specific files and logs
- **Documentation**: `doc/zai.txt` and `doc/zai.cnx` contain plugin documentation
- **Non-essential files**: Some files like `tool_offline.py`, `command.py`, and `deepseek.py` are experimental or not managed by git and can be ignored for core development

## When Modifying Code

1. **Vim script changes**: Test in an actual Vim/Neovim session with the plugin loaded
2. **Python changes**: Ensure backward compatibility with existing session state
3. **Tool development**: Follow the existing pattern in `tool_*.py` files
4. **Configuration changes**: Update both `config.py` and documentation in `README.md`
5. **API changes**: Consider migration paths for existing user configurations

### Code Quality Guidelines

1. **Avoid hardcoding local paths** - Never include user-specific paths like `/home/username/...` in code
   - Use generic examples: `/usr/local/myproject`, `/path/to/project`, `~/project`
   - For tests: use temporary directories (`tempfile.mkdtemp()`) or generic paths
   - For docstrings/examples: use realistic but generic paths
   - **Why**: Code becomes portable and doesn't leak developer's local environment

2. **Don't expose sensitive information** - Avoid committing:
   - API keys, tokens, passwords
   - Personal email addresses or usernames
   - Local configuration files with sensitive data
   - Internal IP addresses or hostnames

## Git Commit Guidelines

When creating git commits:
- **Do NOT add Co-Authored-By trailers** - Commits should be attributed solely to the human user. AI agents do not have legal personhood and cannot be commit co-authors. This applies to all trailers: `Co-Authored-By`, `Signed-off-by`, `Reviewed-by`, etc.
- Keep commit messages concise and descriptive
- Use conventional commit format: `type: description` (e.g., `feat:`, `fix:`, `docs:`)
- Reference relevant issue numbers when applicable

### What NOT to Commit

**IMPORTANT**: Not all newly created files should be committed to the git repository. Default to NOT committing files that:

- **Are ignored by .gitignore** - If a file pattern is in `.gitignore`, assume it should not be committed
- **Contain local or sensitive information** - API keys, local paths, personal configuration files
- **Are process or temporary files** - Development logs, test artifacts, build intermediates
- **Have no direct value to end users** - Test helpers, experimental scripts, debugging files

**Examples of files to avoid committing**:
- **Process and planning artifacts** - Files in `_bmad-output/` (brainstorming, PRD, architecture, epics, implementation artifacts, sprint status, readiness reports)
  - **Why**: These are internal development process files with no value to end users who install the plugin from GitHub. They add noise and bloat to the repository.
  - **How to apply**: `_bmad-output/` is in `.gitignore`. Never commit files under this directory.
- **Test scripts** - Files like `test_*.py`, `mytest.py`, `mytest*.py`, `test_round.py`, `test_pagination.py` (unless they are part of the formal test suite)
  - **Why**: This project has no formal test suite; tests are scattered and used for development/debugging only
  - **How to apply**: Use `.gitignore` patterns like `python3/test_*.py`, `python3/mytest*.py` to prevent accidental commits
- Local configuration files containing personal settings
- Process documentation like `llm_agent_requests.md` (conversation records)
- Temporary artifacts, screenshots, or output files
- Files in `.zaivim/` used for project management tasks

**When in doubt**: Ask the user before committing new files. The principle is that the git repository should contain source code and essential documentation, not every file created during development.

### Git History Preservation Rules

**IMPORTANT**: Never modify git history that has been pushed to the remote repository (GitHub). This includes:

- **Do NOT rebase commits that exist in origin/main** - Rewriting public history causes problems for collaborators
- **Do NOT force push to main/master** - Use regular `git push` instead
- **Do NOT amend published commits** - Create new commits for changes instead
- **Check before rewriting history**: Always run `git log origin/main..HEAD` to see which commits are local-only

**Local-only commits are safe to modify**:
- Commits that exist only locally (ahead of origin/main) can be rebased, amended, or squashed
- Use `git log --oneline origin/main..HEAD` to verify which commits are local
- Use `git reset` and `git rebase` freely on local commits before pushing

**Examples**:
```bash
# Check which commits are local-only (safe to modify)
git log --oneline origin/main..HEAD

# Safe: Rebase local commits before pushing
git rebase -i HEAD~3  # OK if these commits aren't in origin/main

# Unsafe: Force push to remote
git push --force  # NEVER do this on main/master branches
```

## Useful References

- `README.md` and `README_zh.md` - Comprehensive user documentation
- `requirements.txt` and `requirements.md` - Dependency specifications
- `doc/zai.txt` - Vim help file (can be viewed with `:help zai` in Vim)
- Recent git commits show ongoing development in archive/windowing features and tool improvements

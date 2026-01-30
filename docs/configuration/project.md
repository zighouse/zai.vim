# Project Configuration

This page covers project-level configuration using `zai.project/zai_project.yaml` for Docker containers, sandbox directories, and automatic package installation.

## Overview

Project configuration allows you to define:
- Sandbox directory for file operations
- Docker container settings for `tool_shell`
- Automatic package installation on container startup
- Project-specific tool behavior

## Configuration File Location

Zai searches upward from the current working directory:

1. `zai.project/zai_project.yaml` (new format, recommended)
2. `zai_project.yaml` (legacy format, shows warning)

## Configuration Structure

The file contains a list of configuration objects. The first object is used for the current project.

```yaml
- sandbox_home: /path/to/sandbox        # Optional: sandbox directory
  shell_container:                       # Optional: Docker configuration
    image: taskbox:latest
    name: my-container
    # ... other Docker options
  pip_install:                           # Optional: Python packages
    - packages: [PyYAML, appdirs]
  apt_install:                           # Optional: System packages
    - packages: [vim, git, curl]
  post_start_commands:                   # Optional: Custom commands
    - "echo 'Ready'"
```

## Sandbox Directory

Configure where file-related tools can operate.

### Configuration

```yaml
- sandbox_home: /path/to/project/sandbox
```

### Default Value

If not specified: `~/.local/share/zai/sandbox`

### Security

File tools (`tool_file`, `tool_shell`) are restricted to the sandbox directory. Files outside cannot be accessed for security.

### Use with Session Commands

Override at runtime:

```
:sandbox /custom/sandbox/path
```

## Docker Container Configuration

Configure the `tool_shell` Docker container (taskbox).

### Basic Example

```yaml
- shell_container:
    image: taskbox:latest
    name: my-project-taskbox
    working_dir: /sandbox
```

### Complete Example

```yaml
- shell_container:
    # Image configuration
    image: taskbox:latest
    name: my-project-taskbox
    Dockerfile: Dockerfile.taskbox

    # Working directory
    working_dir: /sandbox

    # User configuration
    user: "1000:1000"  # UID:GID to match host user
    # Or use image user: user: "sandbox"

    # Volume mounts
    volumes:
      - "/host/path:/container/path:rw"
      - "/home/user/project/.git:/sandbox/project/.git:ro"
      - "/ccache:/ccache:ro"

    # Network
    network_mode: bridge

    # Environment variables
    environment:
      CCACHE_DIR: "/ccache"
      CCACHE_MAXSIZE: "10G"
      CUSTOM_VAR: "value"

    # Resource limits
    mem_limit: "4g"
    cpu_period: 100000
    cpu_quota: 50000

    # Container behavior
    detach: true
    auto_remove: true
    command: ["tail", "-f", "/dev/null"]
```

### Field Descriptions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `image` | string | `taskbox:latest` | Docker image name |
| `name` | string | `zai-tool-shell-taskbox` | Container name |
| `Dockerfile` | string | - | If image doesn't exist, build from this Dockerfile |
| `working_dir` | string | `/sandbox` | Container working directory |
| `user` | string | Host UID:GID | Container user (format: `UID:GID` or `username`) |
| `volumes` | list | `[]` | Volume mounts (`host:container:mode`) |
| `network_mode` | string | `bridge` | Docker network mode |
| `environment` | dict | `{}` | Environment variables |
| `mem_limit` | string | - | Memory limit (e.g., `"4g"`, `"512m"`) |
| `cpu_period` | int | - | CPU period (100000 = 100ms) |
| `cpu_quota` | int | - | CPU quota (50000 = 50% of 1 CPU) |
| `detach` | bool | `true` | Run in detached mode |
| `auto_remove` | bool | `true` | Remove container on exit |
| `command` | list | - | Container command |

## Automatic Package Installation

Automatically install packages when the container starts.

### pip_install: Python Packages

Install Python packages via pip.

#### Simple List

```yaml
pip_install:
  - PyYAML
  - appdirs
  - requests
```

#### With Options

```yaml
pip_install:
  - packages: [torch, torchvision, torchaudio]
    options: [--index-url, https://download.pytorch.org/whl/cpu]
```

#### Mixed Format

```yaml
pip_install:
  - PyYAML
  - ["torch", "--index-url", "https://download.pytorch.org/whl/cpu"]
```

#### User Installation (Non-root)

If container user is not root, add `--user` flag:

```yaml
pip_install:
  - packages: [requests, numpy]
    options: [--user]
```

### apt_install: System Packages

Install system packages via package manager.

#### Simple List (defaults to apt)

```yaml
apt_install:
  - vim
  - git
  - curl
  - build-essential
```

#### Specify Package Manager

```yaml
apt_install:
  - package_manager: dnf  # For Fedora
    packages: [vim, git, curl]
    options: [-y]
```

#### Multiple Installation Specs

```yaml
apt_install:
  - package_manager: apt
    packages: [vim, curl]
    options: [-y]
  - package_manager: dnf
    packages: [htop, ncdu]
    options: [-y]
```

### post_start_commands: Generic Commands

Run arbitrary shell commands after package installation.

```yaml
post_start_commands:
  - "cargo install bat"
  - "go install github.com/user/tool@latest"
  - "npm install -g package"
  - "echo 'Installation complete'"
  - "python3 --version && pip --version"
```

## Installation Process

### When Installation Runs

1. Container is created for the first time
2. Persistent container is started
3. Does NOT run on every shell command

### Installation Order

1. Update package manager (e.g., `apt-get update`)
2. Install system packages (`apt_install`)
3. Upgrade pip
4. Install Python packages (`pip_install`)
5. Execute custom commands (`post_start_commands`)

### Permission Handling

Zai automatically handles permissions:

- **Root user (UID=0)**: Commands run directly
- **sudo available**: Commands prefixed with `sudo`
- **Neither**: Commands run directly (may fail with permissions)

### Error Handling

- Package manager update warnings: Continue installation
- pip upgrade failure: Show warning, continue
- Individual package failures: Log error, continue
- All errors reported to stderr for debugging

## Complete Project Configuration Example

```yaml
# zai.project/zai_project.yaml

# Sandbox directory for file operations
sandbox_home: /home/user/project/sandbox

# Docker container configuration
shell_container:
  image: python:3.11-slim
  name: my-project-dev-env
  working_dir: /sandbox

  # User configuration
  user: "1000:1000"  # Matches host user

  # Volume mounts
  volumes:
    - "/home/user/project:/sandbox/project:rw"
    - "/home/user/.git:/sandbox/.git:ro"
    - "/ccache:/ccache:ro"

  # Network
  network_mode: bridge

  # Environment
  environment:
    CCACHE_DIR: "/ccache"
    CCACHE_MAXSIZE: "10G"
    PYTHONPATH: "/sandbox"

  # Resource limits
  mem_limit: "4g"
  cpu_period: 100000
  cpu_quota: 50000

  # Container behavior
  detach: true
  auto_remove: true
  command: ["tail", "-f", "/dev/null"]

# Python packages to install
pip_install:
  - packages: [PyYAML, appdirs, requests]
  - packages: [torch, torchvision, torchaudio]
    options: [--index-url, https://download.pytorch.org/whl/cpu]
  - packages: [numpy, pandas]
    options: [--user]

# System packages to install
apt_install:
  - packages: [vim, git, curl, build-essential, python3-dev]
    options: [-y]

# Custom commands after installation
post_start_commands:
  - "cargo install bat exa"
  - "echo 'Development environment ready'"
  - "python3 --version && pip --version"
```

## Session Commands for Project Configuration

### Show Taskbox Status

```
:show taskbox
```

Output includes:
- Container name
- Image name
- Status (running/stopped)
- Mounts
- Environment

### Start Taskbox

```
:start taskbox
```

### Stop Taskbox

```
:stop taskbox
```

### Set Sandbox Path

```
:sandbox /custom/sandbox/path
```

## Creating a Dockerfile

If the specified image doesn't exist, Zai can build it from a Dockerfile.

### Dockerfile.taskbox Example

```dockerfile
FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    vim \
    curl \
    build-essential \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Create sandbox user
RUN useradd -m -u 1000 sandbox && \
    mkdir -p /sandbox && \
    chown -R sandbox:sandbox /sandbox

# Set working directory
WORKDIR /sandbox

# Switch to sandbox user
USER sandbox

# Default command
CMD ["tail", "-f", "/dev/null"]
```

### Reference in Configuration

```yaml
shell_container:
  image: my-custom-taskbox:latest
  Dockerfile: Dockerfile.taskbox
```

## Use Cases

### Python Development Environment

```yaml
- sandbox_home: ~/project/sandbox
  shell_container:
    image: python:3.11-slim
    working_dir: /sandbox
    user: "1000:1000"
    volumes:
      - "~/project:/sandbox:rw"
  pip_install:
    - packages: [pytest, black, mypy, pylint]
```

### Go Development Environment

```yaml
- shell_container:
    image: golang:1.21
    working_dir: /sandbox
  apt_install:
    - packages: [vim, git]
  post_start_commands:
    - "go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest"
```

### Web Scraping Environment

```yaml
- shell_container:
    image: python:3.11-slim
  pip_install:
    - beautifulsoup4
    - selenium
    - requests
    - lxml
  apt_install:
    - packages: [chromium-driver, curl]
```

## Troubleshooting

### Container Not Starting

**Check:**
1. Docker is running: `docker ps`
2. Image exists: `docker images`
3. Configuration syntax is valid YAML

### Permission Denied Errors

**Solution:**
1. Check user UID/GID: `id` on host
2. Match in configuration: `user: "1000:1000"`
3. Or use image user: `user: "sandbox"`

### Packages Not Installing

**Check:**
1. Container logs: `docker logs <container-name>`
2. Start container manually: `:start taskbox`
3. Check shell command errors

### Sandbox Access Denied

**Check:**
1. Sandbox directory exists
2. Directory permissions allow user access
3. Volume mounts include sandbox directory

## Next Steps

- [Basic Configuration](basic.md) - Vim configuration options
- [AI Assistants Configuration](assistants.md) - Multiple AI providers
- [Session Commands](session-commands.md) - Runtime commands
- [Shell Tool](../tools/shell.md) - Using tool_shell

## Related Topics

- [Installation Guide](../installation/) - Set up Zai.Vim
- [Configuration Overview](README.md) - All configuration topics
- [Tools Documentation](../tools/) - AI tool capabilities

# System Requirements

This page details the requirements for installing and running Zai.Vim.

## Core Requirements

### Editor
- **Vim 8.0+** or **Neovim** (any version)

### Python
- **Python 3.6+** (Python 3.8+ recommended)

Verify Python installation:
```bash
python3 --version
```

### API Access
- An AI API key from a supported provider:
  - DeepSeek (recommended)
  - OpenAI
  - Gemini
  - Moonshot
  - Or any OpenAI-compatible API

Set your API key as an environment variable:
```bash
# Example for DeepSeek
export DEEPSEEK_API_KEY=sk-********************************
```

## Python Dependencies

### Required (Core)
These packages are required for basic functionality:

| Package | Purpose | License |
|---------|---------|---------|
| `openai` | OpenAI API client | MIT |
| `requests` | HTTP request library | Apache 2.0 |
| `appdirs` | Application directory management | MIT |
| `chardet` | Character encoding detection | LGPLv3 |
| `PyYAML` | YAML configuration file parsing | MIT |
| `tiktoken` | OpenAI token counting | MIT |

Install core dependencies:
```bash
pip install -r requirements.txt
```

### Optional (Feature-Specific)

#### Web Features
| Package | Purpose | License |
|---------|---------|---------|
| `beautifulsoup4` | HTML parsing | MIT |
| `selenium` | Browser automation | Apache 2.0 |
| `undetected-chromedriver` | Chrome driver | MIT |
| `html2text` | HTML to Markdown conversion | MIT |

#### File Operations
| Package | Purpose | License |
|---------|---------|---------|
| `python-magic` | File type detection | MIT |

#### System Tools
| Package | Purpose | License |
|---------|---------|---------|
| `distro` | Linux distribution detection | GPLv3 |
| `docker` | Docker Python SDK | Apache 2.0 |

#### AI Tools
| Package | Purpose | License |
|---------|---------|---------|
| `transformers` | Hugging Face library | Apache 2.0 |

#### Voice Input (ASR)
| Package | Purpose | License |
|---------|---------|---------|
| `websockets` | WebSocket client | MIT |
| `pyaudio` | Audio recording | MIT |

#### Utility Tools
| Package | Purpose | License |
|---------|---------|---------|
| `lunarcalendar` | Lunar calendar support | MIT |

Install all optional dependencies:
```bash
python3 python3/install.py --all-optional
```

Install specific optional dependencies:
```bash
pip install beautifulsoup4 selenium html2text
```

## System Dependencies

### Linux (Recommended)

#### Docker Engine
Required for secure shell execution with `tool_shell`.

```bash
# Ubuntu/Debian
sudo apt install docker.io docker-compose
sudo usermod -aG docker $USER
sudo systemctl restart docker

# Log out and log back in for docker group to take effect
```

#### Chrome/Chromium Browser
Required for web search functionality.

```bash
# Ubuntu/Debian
sudo apt install chromium-browser

# Or install Google Chrome from official website
```

#### Development Tools
Often needed for building Python packages:

```bash
sudo apt install build-essential python3-dev
```

#### PortAudio (for ASR)
Required for voice input functionality:

```bash
sudo apt install portaudio19-dev python3-pyaudio
```

### Windows

Docker and Chrome are available on Windows, but configuration is more complex. Using Linux is recommended for the best experience.

### macOS

Install dependencies using Homebrew:

```bash
# Docker
brew install --cask docker

# Chrome (or use Chromium)
brew install --cask google-chrome

# PortAudio (for ASR)
brew install portaudio
```

## Optional Vim Plugins

These plugins enhance Zai's functionality but are not required:

| Plugin | Purpose | Installation |
|--------|---------|--------------|
| `iamcco/markdown-preview.nvim` | Preview chat in browser | `Plug 'iamcco/markdown-preview.nvim'` |
| `junegunn/fzf.vim` | Fuzzy search for logs | `Plug 'junegunn/fzf.vim'` |

## Compatibility Matrix

| Feature | Vim 8.0 | Vim 9.0 | Neovim | Required Python |
|---------|---------|---------|--------|-----------------|
| Basic Chat | ✅ | ✅ | ✅ | 3.6+ |
| Tool Calling | ✅ | ✅ | ✅ | 3.6+ |
| Shell Tools | ✅ | ✅ | ✅ | 3.6+ |
| Web Tools | ✅ | ✅ | ✅ | 3.6+ |
| ASR Input | ✅ | ✅ | ✅ | 3.6+ |

## Check Your Setup

Run this command to verify your environment:

```bash
# Check Python version
python3 --version

# Check Docker
docker --version

# Check API key (example)
echo $DEEPSEEK_API_KEY

# Test in Vim
vim +":Zai"
```

## Next Steps

Once requirements are met, proceed to:
- [Plugin Managers](plugin-managers.md) - Install using a plugin manager
- [Manual Installation](manual.md) - Install without a plugin manager
- [Voice Input Setup](asr.md) - Configure ASR for voice input

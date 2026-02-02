#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
import sys
import subprocess
import importlib
import argparse
import platform
from typing import List, Tuple

# Core dependencies - must be installed
CORE_DEPS = [
    "openai>=1.0.0",
    "requests>=2.28.0", 
    "appdirs>=1.4.0",
    "chardet>=5.0.0",
    "PyYAML>=6.0.0",
    "tiktoken>=0.5.0",
]

# Optional dependencies - install as needed
OPTIONAL_DEPS = {
    "web": [
        "beautifulsoup4>=4.12.0",  # bs4
        "selenium>=4.10.0",
        "undetected-chromedriver>=3.5.0",
        "html-to-markdown>=1.0.0",  # HTML to Markdown conversion
    ],
    "file": [
        "python-magic>=0.4.27",  # File type detection
    ],
    "system": [
        "distro>=1.8.0",  # Linux distribution detection
        "docker>=6.0.0",  # Docker Python SDK
    ],
    "ai": [
        "transformers>=4.30.0",  # Hugging Face Transformers
    ],
    "utils": [
        "lunarcalendar>=0.0.9",  # Lunar calendar
    ],
    "asr": [
        "websockets>=11.0.0",  # WebSocket for ASR
        "pyaudio>=0.2.13",  # Audio recording
    ]
}

# System dependency notes
SYSTEM_DEPS_NOTES = {
    "web": """
    ⚠ Web search feature requires additional system dependencies:

    For Linux (Ubuntu/Debian):
      sudo apt install chromium-browser
      # Or install Google Chrome from official website

    For Windows:
      - Install Google Chrome browser
      - ChromeDriver will be managed automatically, but requires Chrome browser

    Note: Web search feature works best on Linux, Windows may require additional configuration.
    """,

    "system": """
    ⚠ Docker container feature requires additional system dependencies:

    For Linux (Ubuntu/Debian):
      sudo apt install docker.io docker-compose
      sudo usermod -aG docker $USER
      sudo systemctl restart docker
      # Log out and log back in for docker group to take effect

    For Windows:
      - Install Docker Desktop
      - Enable WSL2 integration (recommended)
      - Configure shared drives

    Note: Docker feature is most stable on Linux, Windows requires Docker Desktop.
    """,

    "file": """
    ⚠ File type detection may require system libraries:

    For Linux (Ubuntu/Debian):
      sudo apt install libmagic1

    For Windows:
      - May need to install magic DLL
      - Or use python-magic-bin alternative package
    """,

    "asr": """
    ⚠ ASR (Speech Recognition) feature requires additional system dependencies:

    For Linux (Ubuntu/Debian):
      sudo apt install portaudio19-dev python3-dev
      sudo apt install build-essential cmake

    For Windows:
      - Install PyAudio binary package
      - Visit https://www.lfd.uci.edu/~gohlke/pythonlibs/#pyaudio

    For macOS:
      brew install portaudio
      pip install pyaudio

    Notes:
    - ASR feature requires zasr-server (C++ service)
    - Requires approximately 500MB-1GB memory for model loading
    - Model download is approximately 200MB-700MB
    """
}

def check_dependency(package_name: str) -> bool:
    """Check if dependency is already installed"""
    try:
        # Special handling for packages with hyphens
        if package_name == "html2text":
            import html2text
            return True
        elif package_name == "PyYAML":
            import yaml
        elif package_name == "beautifulsoup4":
            import bs4
        elif package_name == "python-magic":
            import magic
        elif package_name == "undetected-chromedriver":
            import undetected_chromedriver
        else:
            # Try importing package name directly
            importlib.import_module(package_name.split('>=')[0].split('[')[0])
        return True
    except ImportError:
        return False

def install_dependencies(deps: List[str], optional: bool = False) -> Tuple[int, int]:
    """Install dependency list"""
    installed = 0
    failed = 0
    
    for dep in deps:
        package_name = dep.split('>=')[0].split('[')[0]
        
        if check_dependency(package_name):
            print(f"✓ {package_name} already installed")
            installed += 1
            continue
            
        print(f"Installing {dep}...")
        try:
            # Install using pip
            subprocess.check_call([sys.executable, "-m", "pip", "install", dep])
            print(f"✓ Successfully installed {package_name}")
            installed += 1
        except subprocess.CalledProcessError as e:
            if optional:
                print(f"⚠ Optional dependency {package_name} installation failed: {e}")
            else:
                print(f"✗ Core dependency {package_name} installation failed: {e}")
            failed += 1
            
    return installed, failed

def install_all_optional():
    """Install all optional dependencies"""
    total_installed = 0
    total_failed = 0
    
    print("Installing all optional dependencies...")
    for category, deps in OPTIONAL_DEPS.items():
        print(f"\nInstalling {category} related dependencies:")

        # Display system dependencies notes
        if category in SYSTEM_DEPS_NOTES:
            print(SYSTEM_DEPS_NOTES[category])
        
        installed, failed = install_dependencies(deps, optional=True)
        total_installed += installed
        total_failed += failed
    
    return total_installed, total_failed

def install_specific_optional(categories: List[str]):
    """Install specified optional dependency categories"""
    total_installed = 0
    total_failed = 0
    
    for category in categories:
        if category not in OPTIONAL_DEPS:
            print(f"⚠ Unknown dependency category: {category}")
            continue

        print(f"\nInstalling {category} related dependencies:")

        # Display system dependencies notes
        if category in SYSTEM_DEPS_NOTES:
            print(SYSTEM_DEPS_NOTES[category])
        
        installed, failed = install_dependencies(OPTIONAL_DEPS[category], optional=True)
        total_installed += installed
        total_failed += failed
    
    return total_installed, total_failed

def show_platform_info():
    """Display platform information"""
    print(f"Operating System: {platform.system()} {platform.release()}")
    print(f"Python Version: {platform.python_version()}")
    print(f"Platform Architecture: {platform.machine()}")
    print()

def show_system_deps_summary():
    """Display system dependencies summary"""
    print("\n" + "=" * 60)
    print("System Dependencies Installation Guide (Linux Ubuntu/Debian)")
    print("=" * 60)
    
    print("""
1. Install Docker (for secure shell execution):
   sudo apt install docker.io docker-compose
   sudo usermod -aG docker $USER
   sudo systemctl restart docker
   # Log out and log back in for docker group to take effect

2. Install Chrome/Chromium (for web search):
   sudo apt install chromium-browser
   # Or install Google Chrome from official website

3. Install development tools:
   sudo apt install build-essential python3-dev

4. Verify installation:
   docker --version
   chromium-browser --version  # or google-chrome --version
   """)
    
    print("Note: Docker Desktop and Chrome can also be installed on Windows, but configuration is more complex.")
    print("Linux environment recommends Ubuntu/Debian distributions.")
    print("=" * 60)

def install_zasr_service():
    """Install ZASR service"""
    import os
    from pathlib import Path

    # Check if zasr_installer.py exists
    script_dir = Path(__file__).parent
    installer_script = script_dir / "zasr_installer.py"

    if not installer_script.exists():
        print(f"❌ ZASR installation script not found: {installer_script}")
        return 1

    print("\n" + "=" * 60)
    print("  ZASR Service Installation")
    print("=" * 60)
    print()
    print("⚠️  Note: ZASR is a standalone C++ service requiring compilation")
    print("⚠️  Requires CMake and C++ compiler")
    print("⚠️  Model files are approximately 200MB-700MB")
    print("⚠️  Runtime memory usage is approximately 500MB-1GB")
    print()

    # Run installer
    try:
        subprocess.run([sys.executable, str(installer_script)], check=True)
        return 0
    except subprocess.CalledProcessError as e:
        print(f"❌ ZASR installation failed: {e}")
        return 1
    except KeyboardInterrupt:
        print("\n\nInstallation cancelled")
        return 1


def main():
    parser = argparse.ArgumentParser(description="Zai.Vim Dependency Installation Tool")
    parser.add_argument("--optional", nargs="*",
                       help="Install specified optional dependency categories: web, file, system, ai, utils, asr")
    parser.add_argument("--all-optional", action="store_true",
                       help="Install all optional dependencies")
    parser.add_argument("--skip-core", action="store_true",
                       help="Skip core dependencies installation")
    parser.add_argument("--show-system-deps", action="store_true",
                       help="Show system dependencies installation guide")
    parser.add_argument("--install-zasr", action="store_true",
                       help="Install ZASR speech recognition service")
    
    args = parser.parse_args()

    # Show system dependencies guide
    if args.show_system_deps:
        show_system_deps_summary()
        return

    # Install ZASR service
    if args.install_zasr:
        result = install_zasr_service()
        # Also install ASR Python dependencies after ZASR installation
        print("\n" + "=" * 60)
        print("Installing ASR Python Dependencies...")
        print("=" * 60)
        installed, failed = install_dependencies(OPTIONAL_DEPS["asr"], optional=True)
        print(f"\nASR dependencies installation complete: {installed} successful, {failed} failed")
        return result
    
    print("=" * 60)
    print("Zai.Vim Python Dependency Installation Tool")
    print("=" * 60)

    # Display platform information
    show_platform_info()

    # Install core dependencies
    if not args.skip_core:
        print("\nChecking and installing core dependencies...")
        installed, failed = install_dependencies(CORE_DEPS, optional=False)
        print(f"\nCore dependencies installation complete: {installed} successful, {failed} failed")

        if failed > 0:
            print("⚠ Some core dependencies failed to install, may affect basic functionality")

    # Install optional dependencies
    if args.all_optional:
        installed, failed = install_all_optional()
        print(f"\nOptional dependencies installation complete: {installed} successful, {failed} failed")
    elif args.optional:
        installed, failed = install_specific_optional(args.optional)
        print(f"\nSpecified optional dependencies installation complete: {installed} successful, {failed} failed")
    
    print("\n" + "=" * 60)
    print("Installation Complete!")
    print("\nUsage Instructions:")
    print("1. Basic functionality only requires core dependencies")
    print("2. Web-related features need: --optional web")
    print("3. File type detection needs: --optional file")
    print("4. Docker container features need: --optional system")
    print("5. ASR speech recognition needs: --optional asr")
    print("6. Complete installation: --all-optional")
    print("7. System dependencies guide: --show-system-deps")
    print("8. Install ZASR service: --install-zasr")
    print("\nImportant Notes:")
    print("- Web search requires Chrome browser (system dependency)")
    print("- Shell tools require Docker engine (system dependency)")
    print("- ASR requires Portaudio library (system dependency)")
    print("- ZASR service requires CMake and C++ compiler")
    print("- html-to-markdown is for HTML to Markdown conversion")
    print("- See system dependencies installation: --show-system-deps")
    print("=" * 60)

if __name__ == "__main__":
    main()

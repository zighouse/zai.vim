#!/usr/bin/env python3
# Zai.Vim - AI Assistant Integration for Vim
# Copyright (C) 2025-2026 zighouse <zighouse@users.noreply.github.com>
#
# Licensed under the MIT License
#
"""
ZASR Installer for Zai.Vim

This script handles the installation of zasr-server for zai.vim users.
It provides interactive prompts for model selection and installation location.
"""

import os
import sys
import subprocess
import shutil
import tempfile
from pathlib import Path
from typing import Optional, List, Tuple


# Default installation directory
DEFAULT_INSTALL_DIR = Path.home() / ".local" / "share" / "zai" / "zasr"

# ZASR GitHub repository
ZASR_GITHUB_REPO = "https://github.com/zighouse/zasr.git"

# Temporary clone directory (will be created in /tmp/)
ZASR_TEMP_DIR: Optional[Path] = None


def get_zasr_project_root() -> Path:
    """Get or create ZASR project root in temporary directory"""
    global ZASR_TEMP_DIR
    if ZASR_TEMP_DIR is None:
        ZASR_TEMP_DIR = Path(tempfile.mkdtemp(prefix="zasr-install-"))
    return ZASR_TEMP_DIR

# Model information
# Maps to download-models.sh types: vad, sense-voice, streaming-zipformer, punctuation, all
MODELS = {
    "sense-voice": {
        "name": "SenseVoice (Multilingual)",
        "description": "Supports Chinese, English, Japanese, Korean, Cantonese - ideal for multilingual scenarios",
        "languages": "Chinese/English/Japanese/Korean/Cantonese",
        "memory_mb": 500,
        "disk_mb": 300,
        "download_type": "sense-voice",
        "needs_vad": True
    },
    "streaming-zipformer": {
        "name": "Streaming Zipformer (English)",
        "description": "Low latency, high accuracy, English only",
        "languages": "English",
        "memory_mb": 400,
        "disk_mb": 200,
        "download_type": "streaming-zipformer",
        "needs_vad": False
    },
    "streaming-zipformer-bilingual": {
        "name": "Streaming Zipformer (Chinese/English) - Manual Download",
        "description": "Low latency, Chinese/English bilingual (requires manual download)",
        "languages": "Chinese/English",
        "memory_mb": 450,
        "disk_mb": 250,
        "download_type": None,  # Not supported by download-models.sh
        "needs_vad": False,
        "manual_download": {
            "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2",
            "target_dir": "streaming-zipformer",
            "instructions": [
                "Download Chinese/English bilingual model:",
                f"  cd {DEFAULT_INSTALL_DIR}/models",
                "  wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2",
                "  mkdir -p streaming-zipformer",
                "  tar -xjf sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2 -C streaming-zipformer/",
                "  rm sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2"
            ]
        }
    },
    "all": {
        "name": "All Models",
        "description": "Install all available models (multilingual + English + punctuation)",
        "languages": "All",
        "memory_mb": 1200,
        "disk_mb": 700,
        "download_type": "all",
        "needs_vad": True
    }
}


def print_header(title: str):
    """Print a section header"""
    print("\n" + "=" * 60)
    print(f"  {title}")
    print("=" * 60)


def print_info(msg: str):
    """Print an info message"""
    print(f"ℹ️  {msg}")


def print_success(msg: str):
    """Print a success message"""
    print(f"✅ {msg}")


def print_warning(msg: str):
    """Print a warning message"""
    print(f"⚠️  {msg}")


def print_error(msg: str):
    """Print an error message"""
    print(f"❌ {msg}")


def check_zasr_project() -> bool:
    """Clone or verify zasr project exists"""
    project_root = get_zasr_project_root()

    # Check if already cloned
    if (project_root / ".git").exists():
        return True

    # Clone from GitHub
    print_info(f"Cloning ZASR project from GitHub...")
    print_info(f"Repository: {ZASR_GITHUB_REPO}")
    print_info(f"Temporary directory: {project_root}")

    try:
        subprocess.run(
            ["git", "clone", "--depth", "1", ZASR_GITHUB_REPO, str(project_root)],
            check=True,
            capture_output=True
        )
        print_success("ZASR project cloned successfully")
        return True
    except subprocess.CalledProcessError as e:
        print_error(f"Failed to clone ZASR project: {e}")
        print_error(f"stderr: {e.stderr.decode() if e.stderr else 'N/A'}")
        return False
    except FileNotFoundError:
        print_error("git is not installed. Please install git first")
        return False


def cleanup_zasr_project():
    """Clean up temporary ZASR project directory"""
    global ZASR_TEMP_DIR
    if ZASR_TEMP_DIR and ZASR_TEMP_DIR.exists():
        try:
            shutil.rmtree(ZASR_TEMP_DIR)
            print_info(f"Cleaned up temporary directory: {ZASR_TEMP_DIR}")
        except Exception as e:
            print_warning(f"Failed to clean up temporary directory: {e}")
        finally:
            ZASR_TEMP_DIR = None


def check_build() -> bool:
    """Check if zasr-server binary exists"""
    project_root = get_zasr_project_root()
    binary = project_root / "build" / "zasr-server"
    if not binary.exists():
        print_warning(f"ZASR service not built: {binary}")
        print_info("Need to build zasr-server from source")
        return False
    return True


def fix_yaml_cpp_download(third_party: Path) -> bool:
    """Fix yaml-cpp download issue by using correct tag name"""
    yaml_cpp_dir = third_party / "yaml-cpp"
    if yaml_cpp_dir.exists():
        return True  # Already exists

    print_warning("Attempting to fix yaml-cpp download...")
    try:
        # Download using correct tag (0.8.0 instead of yaml-cpp-0.8.0)
        tarball = third_party / "yaml-cpp-0.8.0.tar.gz"
        subprocess.run(
            ["wget", "-O", str(tarball),
             "https://github.com/jbeder/yaml-cpp/archive/refs/tags/0.8.0.tar.gz"],
            cwd=third_party,
            check=True
        )

        # Extract
        subprocess.run(
            ["tar", "xzf", str(tarball)],
            cwd=third_party,
            check=True
        )

        # Create yaml-cpp directory and copy headers
        yaml_cpp_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["cp", "-r", "yaml-cpp-0.8.0/include/yaml-cpp", "yaml-cpp/"],
            cwd=third_party,
            check=True
        )

        # Cleanup
        subprocess.run(
            ["rm", "-rf", "yaml-cpp-0.8.0", str(tarball)],
            cwd=third_party,
            check=True
        )

        print_success("yaml-cpp download fix successful")
        return True
    except subprocess.CalledProcessError as e:
        print_error(f"yaml-cpp download fix failed: {e}")
        return False


def download_and_build_sherpa_onnx(third_party: Path) -> bool:
    """Download and build sherpa-onnx"""
    sherpa_dir = third_party / "sherpa-onnx"

    # Check if already built
    if (sherpa_dir / "build" / "lib" / "libsherpa-onnx-core.a").exists():
        print_info("sherpa-onnx already built, skipping")
        return True

    # Clone if needed
    if not sherpa_dir.exists():
        print_warning("Downloading sherpa-onnx...")
        print_info("Note: sherpa-onnx repository is large (~300MB+), download may take some time...")
        try:
            subprocess.run(
                ["git", "clone", "--depth", "1", "--branch", "master",
                 "https://github.com/k2-fsa/sherpa-onnx.git"],
                cwd=third_party,
                check=True
            )
            print_success("sherpa-onnx cloned successfully")
        except subprocess.CalledProcessError as e:
            print_error(f"sherpa-onnx clone failed: {e}")
            return False

    # Build sherpa-onnx
    print_header("Building sherpa-onnx")
    print_warning("sherpa-onnx compilation may take 10-30 minutes, please wait...")

    sherpa_build_dir = sherpa_dir / "build"
    sherpa_build_dir.mkdir(exist_ok=True)

    try:
        # Configure sherpa-onnx
        print_info("Configuring sherpa-onnx...")
        subprocess.run(
            ["cmake", "..", "-DCMAKE_BUILD_TYPE=Release",
             "-DSHERPA_ONNX_ENABLE_PYTHON=OFF",
             "-DSHERPA_ONNX_ENABLE_TESTS=OFF",
             "-DSHERPA_ONNX_ENABLE_C_API=ON"],
            cwd=sherpa_build_dir,
            check=True
        )

        # Build sherpa-onnx
        print_info("Building sherpa-onnx (using {} threads)...".format(os.cpu_count() or 2))
        subprocess.run(
            ["make", f"-j{os.cpu_count() or 2}"],
            cwd=sherpa_build_dir,
            check=True
        )

        print_success("sherpa-onnx build completed")
        return True
    except subprocess.CalledProcessError as e:
        print_error(f"sherpa-onnx build failed: {e}")
        return False


def build_zasr() -> bool:
    """Build zasr from source"""
    print_header("Building ZASR Service")

    project_root = get_zasr_project_root()

    # Check dependencies
    if not shutil.which("cmake"):
        print_error("CMake is not installed")
        print_info("Please run: sudo apt install cmake")
        return False

    if not shutil.which("g++") and not shutil.which("clang++"):
        print_error("C++ compiler is not installed")
        print_info("Please run: sudo apt install build-essential")
        return False

    # Download dependencies if needed
    third_party = project_root / "third_party"

    # Try using download_deps.sh first
    if not (third_party / "sherpa-onnx").exists():
        print_info("Downloading third-party dependencies...")
        download_script = third_party / "download_deps.sh"
        if download_script.exists():
            try:
                subprocess.run(
                    ["bash", str(download_script)],
                    cwd=third_party,
                    check=True,
                    timeout=600  # 10 minutes timeout
                )
                print_success("Dependencies downloaded successfully")
            except subprocess.CalledProcessError as e:
                print_warning(f"Dependency download script failed: {e}")
                print_info("Attempting to fix yaml-cpp download...")
                if not fix_yaml_cpp_download(third_party):
                    print_error("Dependency download failed and automatic fix failed")
                    return False
                print_success("Dependencies downloaded (using fallback method)")
            except subprocess.TimeoutExpired:
                print_warning("Dependency download timed out")

    # Download other small dependencies (asio, websocketpp, json.hpp)
    for dep_name, dep_url, dep_extract_cmd in [
        ("asio", "https://github.com/chriskohlhoff/asio/archive/refs/tags/asio-1-28-2.tar.gz", "asio-asio-1-28-2"),
        ("websocketpp", "https://github.com/zaphoyd/websocketpp/archive/refs/tags/0.8.2.tar.gz", "websocketpp-0.8.2"),
    ]:
        if not (third_party / dep_name).exists():
            print_info(f"Downloading {dep_name}...")
            try:
                tarball = third_party / f"{dep_name}.tar.gz"
                subprocess.run(
                    ["wget", "-q", "-O", str(tarball), dep_url],
                    check=True
                )
                subprocess.run(
                    ["tar", "xzf", str(tarball)],
                    cwd=third_party,
                    check=True
                )
                subprocess.run(
                    ["mv", str(third_party / dep_extract_cmd), str(third_party / dep_name)],
                    check=True
                )
                subprocess.run(["rm", str(tarball)], check=True)
            except (subprocess.CalledProcessError, FileNotFoundError):
                pass  # Already exists or failed

    # Download json.hpp
    if not (third_party / "json.hpp").exists():
        print_info("Downloading nlohmann/json...")
        try:
            subprocess.run(
                ["wget", "-q", "-O", "json.hpp",
                 "https://github.com/nlohmann/json/releases/download/v3.11.3/json.hpp"],
                cwd=third_party,
                check=True
            )
        except subprocess.CalledProcessError:
            pass

    # Download and build sherpa-onnx
    if not download_and_build_sherpa_onnx(third_party):
        return False

    # Build zasr
    build_dir = project_root / "build"
    build_dir.mkdir(exist_ok=True)

    print_info("Starting zasr-server compilation...")
    try:
        subprocess.run(
            ["cmake", "..", "-DCMAKE_BUILD_TYPE=Release"],
            cwd=build_dir,
            check=True
        )
        subprocess.run(
            ["make", f"-j{os.cpu_count() or 2}"],
            cwd=build_dir,
            check=True
        )
        print_success("zasr-server compiled successfully")
        return True
    except subprocess.CalledProcessError as e:
        print_error(f"Compilation failed: {e}")
        return False


def select_models() -> List[str]:
    """Interactive model selection"""
    print_header("Select ASR Model")

    print_info("Please select the ASR model to install:")
    print()

    options = list(MODELS.keys())
    for i, (key, info) in enumerate(MODELS.items(), 1):
        print(f"  {i}. {info['name']}")
        print(f"     {info['description']}")
        print(f"     Languages: {info['languages']}")
        print(f"     Memory: {info['memory_mb']}MB")
        print(f"     Disk: {info['disk_mb']}MB")
        print()

    while True:
        try:
            choice = input("Enter option (1-4) [default: 1]: ").strip() or "1"
            idx = int(choice) - 1
            if 0 <= idx < len(options):
                selected = options[idx]
                print_success(f"Selected: {MODELS[selected]['name']}")
                return [selected]  # Return model key instead of model names
            else:
                print_error("Invalid option, please try again")
        except (ValueError, KeyboardInterrupt):
            print_error("Invalid input")
            return []


def install_zasr(install_dir: Path, models: List[str], from_source: bool = False) -> bool:
    """Install zasr to target directory"""

    # Build if needed
    if from_source or not check_build():
        if not build_zasr():
            return False

    print_header("Installing ZASR Service")

    project_root = get_zasr_project_root()

    # Check if install directory exists and is not empty
    if install_dir.exists() and list(install_dir.iterdir()):
        print_warning(f"Installation directory already exists and is not empty: {install_dir}")
        print_info("Will clean and reinstall...")
        try:
            shutil.rmtree(install_dir)
        except Exception as e:
            print_error(f"Failed to clean directory: {e}")
            return False

    # Prepare install script arguments
    install_script = project_root / "scripts" / "install.sh"
    cmd = [
        "bash",
        str(install_script),
        "--dir", str(install_dir),
        "--from-binary"
    ]

    print_info(f"Installation directory: {install_dir}")
    print_info(f"Running: {' '.join(cmd)}")

    try:
        # Set environment to skip interactive prompts
        env = os.environ.copy()
        env['DEBIAN_FRONTEND'] = 'noninteractive'
        subprocess.run(cmd, check=True, env=env)
        print_success("ZASR service installed successfully")
        return True
    except subprocess.CalledProcessError as e:
        print_error(f"Installation failed: {e}")
        return False


def download_vad_model(install_dir: Path) -> bool:
    """Download Silero VAD model directly"""
    vad_dir = install_dir / "models" / "vad"
    vad_model = vad_dir / "silero_vad.onnx"

    # Check if VAD model already exists
    if vad_model.exists() and vad_model.stat().st_size > 0:
        print_info("VAD model already exists")
        return True

    # Create directory
    vad_dir.mkdir(parents=True, exist_ok=True)

    # Download VAD model
    vad_url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"

    print_info("Downloading Silero VAD model...")
    print_info(f"  URL: {vad_url}")

    try:
        subprocess.run(
            ["wget", "-O", str(vad_model), vad_url],
            check=True
        )
        print_success("VAD model downloaded successfully")
        return True
    except subprocess.CalledProcessError as e:
        print_error(f"VAD model download failed: {e}")
        # Clean up partial download
        if vad_model.exists():
            try:
                vad_model.unlink()
            except Exception:
                pass
        return False


def download_models(install_dir: Path, model_keys: List[str]) -> bool:
    """Download ASR models based on user selection"""
    if not model_keys:
        print_warning("No model selected, skipping model download")
        return True

    print_header("Downloading ASR Models")

    download_script = install_dir / "scripts" / "download-models.sh"
    if not download_script.exists():
        print_error(f"Model download script not found: {download_script}")
        return False

    # Process each model selection
    has_manual_download = False
    downloaded_something = False

    for model_key in model_keys:
        model_info = MODELS.get(model_key)
        if not model_info:
            print_warning(f"Unknown model: {model_key}")
            continue

        # Check if this model requires manual download
        if model_info.get("manual_download"):
            has_manual_download = True
            print_info(f"Model '{model_info['name']}' requires manual download")
            for instruction in model_info["manual_download"]["instructions"]:
                print(f"  {instruction}")
            print()
            continue

        # Download using download-models.sh
        download_type = model_info.get("download_type")
        if download_type:
            print_info(f"Downloading {model_info['name']}...")
            print_warning("Model download may take a long time and significant bandwidth")

            try:
                subprocess.run(
                    [str(download_script), "--type", download_type,
                     "--dir", str(install_dir / "models"),
                     "--non-interactive"],
                    check=True
                )
                print_success(f"{model_info['name']} downloaded successfully")
                downloaded_something = True
            except subprocess.CalledProcessError as e:
                print_error(f"{model_info['name']} download failed: {e}")
                return False

    # Always download VAD and Punctuation models (they are small and essential)
    print_header("Downloading Auxiliary Models")
    print_info("Downloading Punctuation and VAD (Voice Activity Detection) models...")
    print_info("These models are small but important, recommended to always download")

    # Download Punctuation model using download-models.sh
    try:
        print_info("Downloading punctuation model...")
        subprocess.run(
            [str(download_script), "--type", "punctuation",
             "--dir", str(install_dir / "models"),
             "--non-interactive"],
            check=True,
            timeout=180
        )
        print_success("punctuation model downloaded successfully")
        downloaded_something = True
    except subprocess.TimeoutExpired:
        print_warning("punctuation model download timed out")
    except subprocess.CalledProcessError as e:
        # Check if model files exist and are valid
        punctuation_dir = install_dir / "models" / "punctuation"
        if punctuation_dir.exists():
            files = list(punctuation_dir.rglob("*"))
            non_empty_files = [f for f in files if f.is_file() and f.stat().st_size > 0]
            if non_empty_files:
                print_info("punctuation model already exists")
                downloaded_something = True
            else:
                print_warning("punctuation model download failed")
        else:
            print_warning("punctuation model download failed")

    # Download VAD model directly using correct URL
    print()
    if download_vad_model(install_dir):
        downloaded_something = True
    else:
        print_warning("VAD model download failed")
        print_info("Note: VAD model is required for SenseVoice, optional for Streaming Zipformer")

    # Show manual download instructions if needed
    if has_manual_download:
        print_header("Manual Download Instructions")
        print_warning("The following models require manual download:")
        print()

        for model_key in model_keys:
            model_info = MODELS.get(model_key)
            if model_info and model_info.get("manual_download"):
                print(f"Model: {model_info['name']}")
                print(f"Languages: {model_info['languages']}")
                print(f"Download URL: {model_info['manual_download']['url']}")
                print()
                print("Download steps:")
                for step in model_info["manual_download"]["instructions"]:
                    print(f"  {step}")
                print()

    if downloaded_something or has_manual_download:
        print_header("Model Download Complete")
        if has_manual_download:
            print_info("Please follow the instructions above to manually download other models")
            print()

        # Show how to download models later
        print_info("Methods for downloading models later:")
        print()
        print(f"  Interactive selection: {download_script}")
        print(f"  Download specific model: {download_script} --type <sense-voice|streaming-zipformer|vad|punctuation|all>")
        print(f"  Specify directory: {download_script} --type all --dir {install_dir}/models")
        print()

        # Show sherpa-onnx official website for more models
        print_header("More Models")
        print_info("You can download more pretrained models from sherpa-onnx official website:")
        print()
        print("  Online Transducer models (streaming, low latency):")
        print("     https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/index.html")
        print()
        print("  Offline Transducer models (batch, high accuracy):")
        print("     https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/index.html")
        print()
        print("  Voice Activity Detection (VAD) models:")
        print("     https://k2-fsa.github.io/sherpa/onnx/pretrained_models/vad/index.html")
        print()
        print("  Punctuation models:")
        print("     https://k2-fsa.github.io/sherpa/onnx/pretrained_models/punctuation/index.html")
        print()
        print("  All pretrained models:")
        print("     https://k2-fsa.github.io/sherpa/onnx/pretrained_models/index.html")
        print()
        print_info("Manually add models:")
        print(f"  1. Download models to: {install_dir}/models/")
        print(f"  2. Update config file: {install_dir}/config/default.yaml")
        print(f"  3. Restart service: {install_dir}/scripts/zasrctl restart")
        print()

    return True


def verify_installation(install_dir: Path) -> bool:
    """Verify zasr installation"""
    print_header("Verifying Installation")

    binary = install_dir / "bin" / "zasr-server"
    if not binary.exists():
        print_error(f"zasr-server binary not found: {binary}")
        return False

    ctl_script = install_dir / "scripts" / "zasrctl"
    if not ctl_script.exists():
        print_error(f"zasrctl script not found: {ctl_script}")
        return False

    print_success("ZASR service installation verified successfully")
    print()
    print_info("Installation location:")
    print(f"  Binary: {binary}")
    print(f"  Control script: {ctl_script}")
    print()
    print_info("Usage:")
    print(f"  Start service: {ctl_script} start")
    print(f"  Stop service: {ctl_script} stop")
    print(f"  Check status: {ctl_script} status")
    print()

    return True


def main():
    """Main installation flow"""
    print_header("ZAI.VIM - ZASR Service Installer")

    # Check zasr project
    if not check_zasr_project():
        return 1

    # Check if binary exists
    has_binary = check_build()

    # Interactive installation
    print()
    print_info("Welcome to ZASR Service Installer")
    print()

    # Select installation directory
    install_dir_str = input(
        f"Installation directory [default: {DEFAULT_INSTALL_DIR}]: "
    ).strip() or str(DEFAULT_INSTALL_DIR)
    install_dir = Path(install_dir_str)

    # Select models
    model_keys = select_models()
    if not model_keys:
        print_warning("No model selected, exiting")
        return 1

    # Show memory warning
    total_memory = sum(MODELS[key]['memory_mb'] for key in model_keys)
    print()
    print_warning(f"Estimated memory usage: {total_memory}MB")
    print()

    confirm = input("Continue installation? (y/N): ").strip().lower()
    if confirm != 'y':
        print_info("Installation cancelled")
        return 0

    # Install zasr
    if not install_zasr(install_dir, model_keys, from_source=not has_binary):
        return 1

    # Download models
    if not download_models(install_dir, model_keys):
        return 1

    # Verify
    if not verify_installation(install_dir):
        return 1

    print_header("Installation Complete")
    print_success("ZASR service installed successfully")
    print()
    print_info("Next steps:")
    print("  1. Download models according to the instructions above (if needed)")
    print("  2. Set in .vimrc: let g:zai_auto_enable_asr = 1")
    print("  3. Start Vim, ASR will be automatically enabled")
    print()

    # Clean up temporary directory
    cleanup_zasr_project()

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n\nInstallation cancelled")
        # Clean up on interrupt
        cleanup_zasr_project()
        sys.exit(1)
    finally:
        # Ensure cleanup happens even on error
        cleanup_zasr_project()

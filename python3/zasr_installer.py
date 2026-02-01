#!/usr/bin/env python3
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
MODELS = {
    "sense-voice": {
        "name": "SenseVoice (多语言)",
        "description": "支持中英日韩粤语，适合多语言场景",
        "languages": "中英日韩粤语",
        "memory_mb": 500,
        "disk_mb": 300,
        "models": [
            "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
        ]
    },
    "streaming-zipformer-zh": {
        "name": "Streaming Zipformer (中文)",
        "description": "低延迟，高精度，仅支持中文",
        "languages": "中文",
        "memory_mb": 400,
        "disk_mb": 200,
        "models": [
            "sherpa-onnx-streaming-zipformer-zh-2023-12-12"
        ]
    },
    "streaming-zipformer-bilingual": {
        "name": "Streaming Zipformer (中英)",
        "description": "低延迟，中英双语",
        "languages": "中英",
        "memory_mb": 450,
        "disk_mb": 250,
        "models": [
            "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"
        ]
    },
    "all": {
        "name": "所有模型",
        "description": "安装所有可用模型（多语言 + 中文 + 中英）",
        "languages": "全部",
        "memory_mb": 1200,
        "disk_mb": 700,
        "models": [
            "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
            "sherpa-onnx-streaming-zipformer-zh-2023-12-12",
            "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"
        ]
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
    print_info(f"从 GitHub 克隆 ZASR 项目...")
    print_info(f"仓库: {ZASR_GITHUB_REPO}")
    print_info(f"临时目录: {project_root}")

    try:
        subprocess.run(
            ["git", "clone", "--depth", "1", ZASR_GITHUB_REPO, str(project_root)],
            check=True,
            capture_output=True
        )
        print_success("ZASR 项目克隆完成")
        return True
    except subprocess.CalledProcessError as e:
        print_error(f"克隆 ZASR 项目失败: {e}")
        print_error(f"stderr: {e.stderr.decode() if e.stderr else 'N/A'}")
        return False
    except FileNotFoundError:
        print_error("git 未安装，请先安装 git")
        return False


def cleanup_zasr_project():
    """Clean up temporary ZASR project directory"""
    global ZASR_TEMP_DIR
    if ZASR_TEMP_DIR and ZASR_TEMP_DIR.exists():
        try:
            shutil.rmtree(ZASR_TEMP_DIR)
            print_info(f"已清理临时目录: {ZASR_TEMP_DIR}")
        except Exception as e:
            print_warning(f"清理临时目录失败: {e}")
        finally:
            ZASR_TEMP_DIR = None


def check_build() -> bool:
    """Check if zasr-server binary exists"""
    project_root = get_zasr_project_root()
    binary = project_root / "build" / "zasr-server"
    if not binary.exists():
        print_warning(f"ZASR 服务未编译: {binary}")
        print_info("需要从源码编译 zasr-server")
        return False
    return True


def build_zasr() -> bool:
    """Build zasr from source"""
    print_header("编译 ZASR 服务")

    project_root = get_zasr_project_root()

    # Check dependencies
    if not shutil.which("cmake"):
        print_error("CMake 未安装")
        print_info("请运行: sudo apt install cmake")
        return False

    if not shutil.which("g++") and not shutil.which("clang++"):
        print_error("C++ 编译器未安装")
        print_info("请运行: sudo apt install build-essential")
        return False

    # Download dependencies if needed
    third_party = project_root / "third_party"
    if not (third_party / "sherpa-onnx").exists():
        print_info("下载第三方依赖...")
        download_script = third_party / "download_deps.sh"
        if not download_script.exists():
            print_error(f"依赖下载脚本未找到: {download_script}")
            return False

        try:
            subprocess.run(
                ["bash", str(download_script)],
                cwd=third_party,
                check=True
            )
            print_success("依赖下载完成")
        except subprocess.CalledProcessError as e:
            print_error(f"依赖下载失败: {e}")
            return False

    # Build
    build_dir = project_root / "build"
    build_dir.mkdir(exist_ok=True)

    print_info("开始编译...")
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
        print_success("编译完成")
        return True
    except subprocess.CalledProcessError as e:
        print_error(f"编译失败: {e}")
        return False


def select_models() -> List[str]:
    """Interactive model selection"""
    print_header("选择 ASR 模型")

    print_info("请选择要安装的 ASR 模型:")
    print()

    options = list(MODELS.keys())
    for i, (key, info) in enumerate(MODELS.items(), 1):
        print(f"  {i}. {info['name']}")
        print(f"     {info['description']}")
        print(f"     语言: {info['languages']}")
        print(f"     内存: {info['memory_mb']}MB")
        print(f"     磁盘: {info['disk_mb']}MB")
        print()

    while True:
        try:
            choice = input("请输入选项 (1-4) [默认: 1]: ").strip() or "1"
            idx = int(choice) - 1
            if 0 <= idx < len(options):
                selected = options[idx]
                print_success(f"已选择: {MODELS[selected]['name']}")
                return MODELS[selected]['models']
            else:
                print_error("无效选项，请重新输入")
        except (ValueError, KeyboardInterrupt):
            print_error("输入无效")
            return []


def install_zasr(install_dir: Path, models: List[str], from_source: bool = False) -> bool:
    """Install zasr to target directory"""

    # Build if needed
    if from_source or not check_build():
        if not build_zasr():
            return False

    print_header("安装 ZASR 服务")

    project_root = get_zasr_project_root()

    # Prepare install script arguments
    install_script = project_root / "scripts" / "install.sh"
    cmd = [
        "bash",
        str(install_script),
        "--dir", str(install_dir),
        "--from-binary"
    ]

    print_info(f"安装目录: {install_dir}")
    print_info(f"运行: {' '.join(cmd)}")

    try:
        subprocess.run(cmd, check=True)
        print_success("ZASR 服务安装完成")
        return True
    except subprocess.CalledProcessError as e:
        print_error(f"安装失败: {e}")
        return False


def download_models(install_dir: Path, models: List[str]) -> bool:
    """Download ASR models"""
    if not models:
        print_warning("未选择模型，跳过模型下载")
        return True

    print_header("下载 ASR 模型")

    download_script = install_dir / "scripts" / "download-models.sh"
    if not download_script.exists():
        print_error(f"模型下载脚本未找到: {download_script}")
        return False

    # Run download script
    # Note: We'll download models interactively or use --type all
    print_info("准备下载模型...")
    print_warning("模型下载可能需要较长时间和较多网络流量")
    print()

    try:
        # For now, just show instructions
        print_info("请运行以下命令下载模型:")
        print()
        print(f"  {download_script} --type all")
        print()
        print_info("或者手动选择模型:")
        print(f"  {download_script}")
        print()

        # TODO: Implement automatic download
        # subprocess.run([str(download_script), "--type", "all"], check=True)

        return True
    except subprocess.CalledProcessError as e:
        print_error(f"模型下载失败: {e}")
        return False


def verify_installation(install_dir: Path) -> bool:
    """Verify zasr installation"""
    print_header("验证安装")

    binary = install_dir / "bin" / "zasr-server"
    if not binary.exists():
        print_error(f"zasr-server 二进制文件未找到: {binary}")
        return False

    ctl_script = install_dir / "scripts" / "zasrctl"
    if not ctl_script.exists():
        print_error(f"zasrctl 脚本未找到: {ctl_script}")
        return False

    print_success("ZASR 服务安装验证成功")
    print()
    print_info("安装位置:")
    print(f"  二进制: {binary}")
    print(f"  控制脚本: {ctl_script}")
    print()
    print_info("使用方法:")
    print(f"  启动服务: {ctl_script} start")
    print(f"  停止服务: {ctl_script} stop")
    print(f"  查看状态: {ctl_script} status")
    print()

    return True


def main():
    """Main installation flow"""
    print_header("ZAI.VIM - ZASR 服务安装程序")

    # Check zasr project
    if not check_zasr_project():
        return 1

    # Check if binary exists
    has_binary = check_build()

    # Interactive installation
    print()
    print_info("欢迎使用 ZASR 服务安装程序")
    print()

    # Select installation directory
    install_dir_str = input(
        f"安装目录 [默认: {DEFAULT_INSTALL_DIR}]: "
    ).strip() or str(DEFAULT_INSTALL_DIR)
    install_dir = Path(install_dir_str)

    # Select models
    models = select_models()
    if not models:
        print_warning("未选择模型，退出")
        return 1

    # Show memory warning
    total_memory = sum(
        MODELS[key]['memory_mb']
        for key in MODELS.keys()
        if any(m in models for m in MODELS[key]['models'])
    )
    print()
    print_warning(f"预计内存占用: {total_memory}MB")
    print()

    confirm = input("继续安装? (y/N): ").strip().lower()
    if confirm != 'y':
        print_info("安装已取消")
        return 0

    # Install zasr
    if not install_zasr(install_dir, models, from_source=not has_binary):
        return 1

    # Download models
    if not download_models(install_dir, models):
        return 1

    # Verify
    if not verify_installation(install_dir):
        return 1

    print_header("安装完成")
    print_success("ZASR 服务已成功安装")
    print()
    print_info("下一步:")
    print("  1. 下载 ASR 模型")
    print("  2. 在 .vimrc 中设置: let g:zai_auto_enable_asr = 1")
    print("  3. 启动 Vim，ASR 将自动启用")
    print()

    # Clean up temporary directory
    cleanup_zasr_project()

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n\n安装已取消")
        # Clean up on interrupt
        cleanup_zasr_project()
        sys.exit(1)
    finally:
        # Ensure cleanup happens even on error
        cleanup_zasr_project()

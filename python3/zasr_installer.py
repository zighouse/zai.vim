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
# Maps to download-models.sh types: vad, sense-voice, streaming-zipformer, punctuation, all
MODELS = {
    "sense-voice": {
        "name": "SenseVoice (多语言)",
        "description": "支持中英日韩粤语，适合多语言场景",
        "languages": "中英日韩粤语",
        "memory_mb": 500,
        "disk_mb": 300,
        "download_type": "sense-voice",
        "needs_vad": True
    },
    "streaming-zipformer": {
        "name": "Streaming Zipformer (英文)",
        "description": "低延迟，高精度，仅支持英文",
        "languages": "英文",
        "memory_mb": 400,
        "disk_mb": 200,
        "download_type": "streaming-zipformer",
        "needs_vad": False
    },
    "streaming-zipformer-bilingual": {
        "name": "Streaming Zipformer (中英) - 手动下载",
        "description": "低延迟，中英双语（需要手动下载）",
        "languages": "中英",
        "memory_mb": 450,
        "disk_mb": 250,
        "download_type": None,  # Not supported by download-models.sh
        "needs_vad": False,
        "manual_download": {
            "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2",
            "target_dir": "streaming-zipformer",
            "instructions": [
                "下载中英双语模型:",
                f"  cd {DEFAULT_INSTALL_DIR}/models",
                "  wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2",
                "  mkdir -p streaming-zipformer",
                "  tar -xjf sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2 -C streaming-zipformer/",
                "  rm sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2"
            ]
        }
    },
    "all": {
        "name": "所有模型",
        "description": "安装所有可用模型（多语言 + 英文 + 标点）",
        "languages": "全部",
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


def fix_yaml_cpp_download(third_party: Path) -> bool:
    """Fix yaml-cpp download issue by using correct tag name"""
    yaml_cpp_dir = third_party / "yaml-cpp"
    if yaml_cpp_dir.exists():
        return True  # Already exists

    print_warning("尝试修复 yaml-cpp 下载...")
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

        print_success("yaml-cpp 下载修复成功")
        return True
    except subprocess.CalledProcessError as e:
        print_error(f"yaml-cpp 下载修复失败: {e}")
        return False


def download_and_build_sherpa_onnx(third_party: Path) -> bool:
    """Download and build sherpa-onnx"""
    sherpa_dir = third_party / "sherpa-onnx"

    # Check if already built
    if (sherpa_dir / "build" / "lib" / "libsherpa-onnx-core.a").exists():
        print_info("sherpa-onnx 已编译，跳过")
        return True

    # Clone if needed
    if not sherpa_dir.exists():
        print_warning("下载 sherpa-onnx...")
        print_info("注意：sherpa-onnx 仓库较大（约 300MB+），下载可能需要一些时间...")
        try:
            subprocess.run(
                ["git", "clone", "--depth", "1", "--branch", "master",
                 "https://github.com/k2-fsa/sherpa-onnx.git"],
                cwd=third_party,
                check=True
            )
            print_success("sherpa-onnx 克隆完成")
        except subprocess.CalledProcessError as e:
            print_error(f"sherpa-onnx 克隆失败: {e}")
            return False

    # Build sherpa-onnx
    print_header("编译 sherpa-onnx")
    print_warning("sherpa-onnx 编译可能需要 10-30 分钟，请耐心等待...")

    sherpa_build_dir = sherpa_dir / "build"
    sherpa_build_dir.mkdir(exist_ok=True)

    try:
        # Configure sherpa-onnx
        print_info("配置 sherpa-onnx...")
        subprocess.run(
            ["cmake", "..", "-DCMAKE_BUILD_TYPE=Release",
             "-DSHERPA_ONNX_ENABLE_PYTHON=OFF",
             "-DSHERPA_ONNX_ENABLE_TESTS=OFF",
             "-DSHERPA_ONNX_ENABLE_C_API=ON"],
            cwd=sherpa_build_dir,
            check=True
        )

        # Build sherpa-onnx
        print_info("编译 sherpa-onnx（使用 {} 线程）...".format(os.cpu_count() or 2))
        subprocess.run(
            ["make", f"-j{os.cpu_count() or 2}"],
            cwd=sherpa_build_dir,
            check=True
        )

        print_success("sherpa-onnx 编译完成")
        return True
    except subprocess.CalledProcessError as e:
        print_error(f"sherpa-onnx 编译失败: {e}")
        return False


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

    # Try using download_deps.sh first
    if not (third_party / "sherpa-onnx").exists():
        print_info("下载第三方依赖...")
        download_script = third_party / "download_deps.sh"
        if download_script.exists():
            try:
                subprocess.run(
                    ["bash", str(download_script)],
                    cwd=third_party,
                    check=True,
                    timeout=600  # 10 minutes timeout
                )
                print_success("依赖下载完成")
            except subprocess.CalledProcessError as e:
                print_warning(f"依赖下载脚本失败: {e}")
                print_info("尝试自动修复 yaml-cpp 下载...")
                if not fix_yaml_cpp_download(third_party):
                    print_error("依赖下载失败且自动修复失败")
                    return False
                print_success("依赖下载完成（使用备用方案）")
            except subprocess.TimeoutExpired:
                print_warning("依赖下载超时")

    # Download other small dependencies (asio, websocketpp, json.hpp)
    for dep_name, dep_url, dep_extract_cmd in [
        ("asio", "https://github.com/chriskohlhoff/asio/archive/refs/tags/asio-1-28-2.tar.gz", "asio-asio-1-28-2"),
        ("websocketpp", "https://github.com/zaphoyd/websocketpp/archive/refs/tags/0.8.2.tar.gz", "websocketpp-0.8.2"),
    ]:
        if not (third_party / dep_name).exists():
            print_info(f"下载 {dep_name}...")
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
        print_info("下载 nlohmann/json...")
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

    print_info("开始编译 zasr-server...")
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
        print_success("zasr-server 编译完成")
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
                return [selected]  # Return model key instead of model names
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

    # Check if install directory exists and is not empty
    if install_dir.exists() and list(install_dir.iterdir()):
        print_warning(f"安装目录已存在且不为空: {install_dir}")
        print_info("将清空并重新安装...")
        try:
            shutil.rmtree(install_dir)
        except Exception as e:
            print_error(f"清理目录失败: {e}")
            return False

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
        # Set environment to skip interactive prompts
        env = os.environ.copy()
        env['DEBIAN_FRONTEND'] = 'noninteractive'
        subprocess.run(cmd, check=True, env=env)
        print_success("ZASR 服务安装完成")
        return True
    except subprocess.CalledProcessError as e:
        print_error(f"安装失败: {e}")
        return False


def download_vad_model(install_dir: Path) -> bool:
    """Download Silero VAD model directly"""
    vad_dir = install_dir / "models" / "vad"
    vad_model = vad_dir / "silero_vad.onnx"

    # Check if VAD model already exists
    if vad_model.exists() and vad_model.stat().st_size > 0:
        print_info("VAD 模型已存在")
        return True

    # Create directory
    vad_dir.mkdir(parents=True, exist_ok=True)

    # Download VAD model
    vad_url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"

    print_info("下载 Silero VAD 模型...")
    print_info(f"  URL: {vad_url}")

    try:
        subprocess.run(
            ["wget", "-O", str(vad_model), vad_url],
            check=True
        )
        print_success("VAD 模型下载完成")
        return True
    except subprocess.CalledProcessError as e:
        print_error(f"VAD 模型下载失败: {e}")
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
        print_warning("未选择模型，跳过模型下载")
        return True

    print_header("下载 ASR 模型")

    download_script = install_dir / "scripts" / "download-models.sh"
    if not download_script.exists():
        print_error(f"模型下载脚本未找到: {download_script}")
        return False

    # Process each model selection
    has_manual_download = False
    downloaded_something = False

    for model_key in model_keys:
        model_info = MODELS.get(model_key)
        if not model_info:
            print_warning(f"未知模型: {model_key}")
            continue

        # Check if this model requires manual download
        if model_info.get("manual_download"):
            has_manual_download = True
            print_info(f"模型 '{model_info['name']}' 需要手动下载")
            for instruction in model_info["manual_download"]["instructions"]:
                print(f"  {instruction}")
            print()
            continue

        # Download using download-models.sh
        download_type = model_info.get("download_type")
        if download_type:
            print_info(f"下载 {model_info['name']}...")
            print_warning("模型下载可能需要较长时间和较多网络流量")

            try:
                subprocess.run(
                    [str(download_script), "--type", download_type,
                     "--dir", str(install_dir / "models"),
                     "--non-interactive"],
                    check=True
                )
                print_success(f"{model_info['name']} 下载完成")
                downloaded_something = True
            except subprocess.CalledProcessError as e:
                print_error(f"{model_info['name']} 下载失败: {e}")
                return False

    # Always download VAD and Punctuation models (they are small and essential)
    print_header("下载辅助模型")
    print_info("下载 Punctuation（标点符号）和 VAD（语音活动检测）模型...")
    print_info("这些模型体积小但功能重要，建议总是下载")

    # Download Punctuation model using download-models.sh
    try:
        print_info("下载 punctuation 模型...")
        subprocess.run(
            [str(download_script), "--type", "punctuation",
             "--dir", str(install_dir / "models"),
             "--non-interactive"],
            check=True,
            timeout=180
        )
        print_success("punctuation 模型下载完成")
        downloaded_something = True
    except subprocess.TimeoutExpired:
        print_warning("punctuation 模型下载超时")
    except subprocess.CalledProcessError as e:
        # Check if model files exist and are valid
        punctuation_dir = install_dir / "models" / "punctuation"
        if punctuation_dir.exists():
            files = list(punctuation_dir.rglob("*"))
            non_empty_files = [f for f in files if f.is_file() and f.stat().st_size > 0]
            if non_empty_files:
                print_info("punctuation 模型已存在")
                downloaded_something = True
            else:
                print_warning("punctuation 模型下载失败")
        else:
            print_warning("punctuation 模型下载失败")

    # Download VAD model directly using correct URL
    print()
    if download_vad_model(install_dir):
        downloaded_something = True
    else:
        print_warning("VAD 模型下载失败")
        print_info("提示: VAD 模型对于 SenseVoice 是必需的，对于 Streaming Zipformer 是可选的")

    # Show manual download instructions if needed
    if has_manual_download:
        print_header("手动下载说明")
        print_warning("以下模型需要手动下载:")
        print()

        for model_key in model_keys:
            model_info = MODELS.get(model_key)
            if model_info and model_info.get("manual_download"):
                print(f"模型: {model_info['name']}")
                print(f"语言: {model_info['languages']}")
                print(f"下载地址: {model_info['manual_download']['url']}")
                print()
                print("下载步骤:")
                for step in model_info["manual_download"]["instructions"]:
                    print(f"  {step}")
                print()

    if downloaded_something or has_manual_download:
        print_header("模型下载完成")
        if has_manual_download:
            print_info("请按照上述说明手动下载其他模型")
            print()

        # Show how to download models later
        print_info("后续下载模型的方法:")
        print()
        print(f"  交互式选择: {download_script}")
        print(f"  下载特定模型: {download_script} --type <sense-voice|streaming-zipformer|vad|punctuation|all>")
        print(f"  指定目录: {download_script} --type all --dir {install_dir}/models")
        print()

        # Show sherpa-onnx official website for more models
        print_header("更多模型")
        print_info("您可以从 sherpa-onnx 官网下载更多预训练模型:")
        print()
        print("  🌐 Online Transducer 模型（流式识别，低延迟）:")
        print("     https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/index.html")
        print()
        print("  🌐 Offline Transducer 模型（非流式识别，高精度）:")
        print("     https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/index.html")
        print()
        print("  🌐 语音活动检测 (VAD) 模型:")
        print("     https://k2-fsa.github.io/sherpa/onnx/pretrained_models/vad/index.html")
        print()
        print("  🌐 标点符号模型:")
        print("     https://k2-fsa.github.io/sherpa/onnx/pretrained_models/punctuation/index.html")
        print()
        print("  🌐 所有预训练模型:")
        print("     https://k2-fsa.github.io/sherpa/onnx/pretrained_models/index.html")
        print()
        print_info("手动添加模型:")
        print(f"  1. 下载模型到: {install_dir}/models/")
        print(f"  2. 更新配置文件: {install_dir}/config/default.yaml")
        print(f"  3. 重启服务: {install_dir}/scripts/zasrctl restart")
        print()

    return True


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
    model_keys = select_models()
    if not model_keys:
        print_warning("未选择模型，退出")
        return 1

    # Show memory warning
    total_memory = sum(MODELS[key]['memory_mb'] for key in model_keys)
    print()
    print_warning(f"预计内存占用: {total_memory}MB")
    print()

    confirm = input("继续安装? (y/N): ").strip().lower()
    if confirm != 'y':
        print_info("安装已取消")
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

    print_header("安装完成")
    print_success("ZASR 服务已成功安装")
    print()
    print_info("下一步:")
    print("  1. 按照上述说明下载模型（如果需要）")
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

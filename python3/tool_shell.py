#!/usr/bin/env python3
"""
Shell工具集 - 使用taskbox Docker容器安全地执行shell和Python命令
完全基于Docker Python SDK，避免subprocess注入风险
基于taskbox镜像：ubuntu/debian + Python 3.12 + C/C++工具链 + ccache
支持持久化容器，跨调用保持状态（安装的依赖、文件等）
"""

import json
import os
import sys
import tempfile
import time
import base64
from pathlib import Path
from typing import Dict, Any, Optional, List

from toolcommon import sandbox_home

try:
    import docker
    DOCKER_AVAILABLE = True
except ImportError:
    DOCKER_AVAILABLE = False
    DOCKER_ERROR = "Docker Python SDK not installed, please run: pip install docker"

DEFAULT_IMAGE = "taskbox:latest"
DEFAULT_WORKDIR = "/sandbox"
DEFAULT_TIMEOUT = 60
CONTAINER_NAME = "zai-tool-shell-taskbox"


class TaskboxExecutor:
    """使用taskbox Docker容器执行命令，完全基于Docker SDK，支持持久化容器"""
    
    def __init__(self, image: str = DEFAULT_IMAGE, persistent: bool = True):
        if not DOCKER_AVAILABLE:
            raise RuntimeError(DOCKER_ERROR)
        
        self.image = image
        self.client = docker.from_env()
        self.persistent = persistent
        self.container = None  # 持久化容器实例
        self.container_name = CONTAINER_NAME
        
        # 验证Docker连接
        try:
            self.client.ping()
        except Exception as e:
            raise RuntimeError(f"Docker connection failed: {e}\nPlease ensure Docker service is running and current user has permission to access Docker")
    
    def _image_exists(self) -> bool:
        try:
            self.client.images.get(self.image)
            return True
        except docker.errors.ImageNotFound:
            return False
        except Exception as e:
            print(f"Error checking image: {e}", file=sys.stderr)
            return False

    def _build_image_if_needed(self):
        if self._image_exists():
            return
        
        print(f"Image {self.image} doesn't exist, trying to build...", file=sys.stderr)
        
        dockerfile_path = os.path.join(os.path.dirname(__file__), "Dockerfile.taskbox")
        dockerfile_content = None
        
        if os.path.exists(dockerfile_path):
            try:
                with open(dockerfile_path, 'r', encoding='utf-8') as f:
                    dockerfile_content = f.read()
                print(f"Using external Dockerfile: {dockerfile_path}", file=sys.stderr)
            except Exception as e:
                print(f"Failed to read external Dockerfile: {e}, using built-in default configuration", file=sys.stderr)
        
        # 如果没有外部文件，使用内置的默认 Dockerfile（已更新支持用户映射）
        if dockerfile_content is None:
            dockerfile_content = f"""
# 使用 2025 年主流的 Python 3.12 镜像
FROM python:3.12-slim

# 设置环境变量，防止交互式弹窗阻塞构建
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=Asia/Shanghai

# --- 步骤 1: 安装基础软件，可能需要替换阿里 APT 源 ---
# 3.12-slim 目前基于 Debian 12 (bookworm)
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        make cmake \
        gcc \
        g++ \
        ccache \
        curl \
        git \
        wget \
        vim \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- 步骤 2: 更新 pip，可能需要替换阿里 PIP 源 ---
RUN pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/ \
    && pip config set install.trusted-host mirrors.aliyun.com \
    && pip install --upgrade pip

# --- 步骤 3: 配置 ccache 环境 ---
# 将 ccache 路径加入 PATH 顶层，使其接管编译命令
ENV PATH="/usr/lib/ccache:$PATH"
# 预设 ccache 目录到规划的 volume 中
ENV CCACHE_DIR=/ccache

WORKDIR /sandbox

# 保持运行
CMD ["tail", "-f", "/dev/null"]
"""
        
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            df_path = os.path.join(tmpdir, "Dockerfile")
            with open(df_path, "w") as f:
                f.write(dockerfile_content)
            
            try:
                image, logs = self.client.images.build(
                    path=tmpdir,
                    tag=self.image,
                    rm=True,
                    forcerm=True
                )
                for log in logs:
                    if 'stream' in log:
                        print(log['stream'], end='', file=sys.stderr)
                print(f"\nImage {self.image} built successfully", file=sys.stderr)
            except Exception as e:
                raise RuntimeError(f"Failed to build image: {e}\n\nYou can build manually:\n1. Save the Dockerfile content above\n2. Run: docker build -t taskbox:latest -f Dockerfile .")
    
    def _prepare_mounts(self) -> Dict[str, Dict[str, str]]:
        mounts = {}
        
        sandbox_root = sandbox_home()
        sandbox_root.mkdir(parents=True, exist_ok=True)
        
        mounts[str(sandbox_root)] = {
            "bind": "/sandbox",
            "mode": "rw"
        }
        
        return mounts
    
    def _prepare_python_command(self, code: str) -> List[str]:
        """准备Python命令列表，安全地执行Python代码"""
        # 如果代码是单行且简单，直接使用python3 -c
        if "\n" not in code and len(code) < 1000 and '"' not in code and "'" not in code:
            # 简单代码，直接传递
            return ["python3", "-c", code]
        
        # 多行或复杂代码使用base64编码，避免引号转义问题
        encoded = base64.b64encode(code.encode()).decode()
        # 注意：这里我们使用单引号包裹base64字符串，因为双引号在JSON中可能需要转义
        return ["python3", "-c", f"import base64; exec(base64.b64decode('{encoded}').decode())"]
    
    def _prepare_shell_command(self, command: str, libraries: List[str] = None) -> List[str]:
        libraries = libraries or []
        parts = []
        
        if libraries:
            # 安装库的命令
            # 使用 || echo "Installation may have failed, continuing..." 来确保即使安装失败也继续
            install_cmd = f"apt-get update && apt-get install -y {' '.join(libraries)} || echo 'Package installation may have failed, continuing execution...'"
            parts.append(install_cmd)
        
        if command:
            parts.append(command)
        
        if len(parts) == 0:
            # 没有命令，返回一个无害的命令
            return ["echo", "No command provided"]
        
        full_command = " && ".join(parts)
        return ["sh", "-c", full_command]
    
    def ensure_container_running(self) -> bool:
        """
        确保持久化容器正在运行。
        如果容器不存在，则创建并启动一个容器（使用 tail -f /dev/null 保持运行）。
        如果容器存在但已停止，则启动它。
        返回容器是否已成功运行。
        """
        if not self.persistent:
            return False
        
        try:
            self.container = self.client.containers.get(self.container_name)
            
            if self.container.status != "running":
                print(f"Container {self.container_name} status is {self.container.status}, starting...", file=sys.stderr)
                self.container.start()
                time.sleep(1)
            
            return True
            
        except docker.errors.NotFound:
            print(f"Container {self.container_name} doesn't exist, creating...", file=sys.stderr)
            
            if not self._image_exists():
                self._build_image_if_needed()
            
            mounts = self._prepare_mounts()
            
            container_config = {
                "image": self.image,
                "command": ["tail", "-f", "/dev/null"],  # Empty command to keep container running
                "name": self.container_name,
                "working_dir": DEFAULT_WORKDIR,
                "volumes": mounts,
                "mem_limit": "4g",
                "cpu_period": 100000,
                "cpu_quota": 50000,  # 限制CPU为0.5核
                "detach": True,
                "auto_remove": False
            }
            
            self.container = self.client.containers.create(**container_config)
            self.container.start()
            
            time.sleep(2)
            print(f"Persistent container {self.container_name} has been started and is running", file=sys.stderr)
            return True
            
        except Exception as e:
            print(f"Error ensuring container is running: {e}", file=sys.stderr)
            return False
    
    def stop_container(self):
        """停止并移除持久化容器"""
        if not self.persistent:
            return
        
        try:
            container = self.client.containers.get(self.container_name)
            container.stop(timeout=1)
            container.remove(force=True)
            print(f"Stopped and removed container {self.container_name}", file=sys.stderr)
            self.container = None
        except docker.errors.NotFound:
            pass  # 容器不存在，无需操作
        except Exception as e:
            print(f"Error stopping container: {e}", file=sys.stderr)
    
    def _exec_in_container(self, cmd_list: List[str], timeout: int, working_dir: str = None) -> Dict[str, Any]:
        """
        在持久化容器中执行命令。
        假设容器已经运行。
        使用 container.exec_run() 简化操作。
        注意：docker Python SDK 的 exec_run() 不支持 timeout 参数，
        我们在命令层面使用 timeout 命令实现超时控制。
        """
        if not self.container:
            raise RuntimeError("Container not initialized")
        
        try:
            # 如果 timeout > 0，使用 timeout 命令包装
            # timeout 命令在超时时返回退出码 124
            if timeout > 0:
                # 简单地在原命令列表前添加 timeout 命令
                # 格式: timeout [秒数] 原命令...
                final_cmd_list = ["timeout", str(timeout)] + cmd_list
            else:
                final_cmd_list = cmd_list
            
            # 使用 exec_run 执行命令
            # exec_run 返回 (exit_code, output)，其中 output 是合并的 stdout 和 stderr
            # 注意：docker Python SDK 的 exec_run() 不支持 timeout 参数
            result = self.container.exec_run(
                cmd=final_cmd_list,
                workdir=working_dir or DEFAULT_WORKDIR,
                stdout=True,
                stderr=True,
                demux=False  # 不分离 stdout/stderr，返回合并的输出
            )
            
            exit_code = result.exit_code
            output = result.output.decode('utf-8', errors='replace') if isinstance(result.output, bytes) else result.output
            
            # 检查是否因 timeout 命令而退出（退出码 124）
            # timeout 命令在超时时返回退出码 124
            if timeout > 0 and exit_code == 124:
                return {
                    "exit_code": exit_code,
                    "stdout": "",
                    "stderr": f"Command execution timeout ({timeout} seconds)",
                    "success": False
                }
            
            # 由于 demux=False，output 包含合并的 stdout 和 stderr
            # 我们无法分离它们，所以将全部输出作为 stdout，stderr 留空
            # 但我们可以通过检查 exit_code 来判断是否出错
            stdout = output
            stderr = ""
            
            return {
                "exit_code": exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "success": exit_code == 0
            }
            
        except docker.errors.APIError as e:
            return {
                "exit_code": 1,
                "stdout": "",
                "stderr": f"Docker API error: {e}",
                "success": False
            }
        except Exception as e:
            return {
                "exit_code": 1,
                "stdout": "",
                "stderr": f"Execution error: {e}",
                "success": False
            }
    
    def execute_command(
        self,
        command: str,
        timeout: int = DEFAULT_TIMEOUT,
        working_dir: str = DEFAULT_WORKDIR,
        enable_network: bool = True,
        language: str = "shell",
        libraries: List[str] = None,
        persistent: bool = None
    ) -> Dict[str, Any]:
        """
        在taskbox容器中执行命令。
        
        Args:
            command: 要执行的命令
            timeout: 超时时间（秒）
            working_dir: 容器内工作目录
            enable_network: 是否启用网络
            language: 命令语言（shell/python）
            libraries: 需要安装的库列表
            persistent: 是否使用持久化容器（覆盖实例的persistent设置）
            
        Returns:
            执行结果字典
        """
        start_time = time.time()
        
        use_persistent = self.persistent if persistent is None else persistent
        
        if not enable_network and use_persistent:
            print("Warning: Cannot use persistent container when network is disabled, falling back to temporary container", file=sys.stderr)
            use_persistent = False
        
        try:
            if not self._image_exists():
                self._build_image_if_needed()
            
            if language == "python":
                cmd_list = self._prepare_python_command(command)
                if libraries:
                    pip_cmd = ["pip", "install"] + libraries
                    pip_install = " ".join(pip_cmd)
                    python_cmd = " ".join(cmd_list)
                    full_cmd = f"{pip_install} && {python_cmd}"
                    cmd_list = ["sh", "-c", full_cmd]
            elif language == "shell":
                cmd_list = self._prepare_shell_command(command, libraries)
            else:
                cmd_list = self._prepare_shell_command(command, libraries)
            
            if use_persistent:
                if not self.ensure_container_running():
                    print("Warning: Unable to start persistent container, falling back to temporary container", file=sys.stderr)
                    return self._execute_in_temp_container(cmd_list, timeout, working_dir, enable_network)
                
                result = self._exec_in_container(cmd_list, timeout, working_dir)
                
                # 注意：持久化容器默认启用网络，但我们可以在创建容器时控制网络。
                # 目前我们假设容器已经创建并具有网络设置。
                # 如果需要动态启用/禁用网络，可能需要更复杂的逻辑。
                # 为了简化，我们假设容器创建时启用了网络。
                
                return result
            else:
                return self._execute_in_temp_container(cmd_list, timeout, working_dir, enable_network)
                
        except Exception as e:
            return {
                "exit_code": 1,
                "stdout": "",
                "stderr": f"Execution failed: {e}",
                "success": False
            }
        finally:
            end_time = time.time()
    
    def _execute_in_temp_container(self, cmd_list: List[str], timeout: int, working_dir: str, enable_network: bool) -> Dict[str, Any]:
        mounts = self._prepare_mounts()
        
        container_config = {
            "image": self.image,
            "command": cmd_list,
            "working_dir": working_dir,
            "volumes": mounts,
            "mem_limit": "4g",
            "cpu_period": 100000,
            "cpu_quota": 50000,
            "detach": True,
            "auto_remove": False
        }
        
        if not enable_network:
            container_config["network_mode"] = "none"
        
        container = None
        try:
            container = self.client.containers.create(**container_config)
            container.start()
            
            result = container.wait(timeout=timeout)
            exit_code = result["StatusCode"]
            
            stdout = container.logs(stdout=True, stderr=False).decode('utf-8', errors='replace')
            stderr = container.logs(stdout=False, stderr=True).decode('utf-8', errors='replace')
            
            return {
                "exit_code": exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "success": exit_code == 0
            }
            
        except docker.errors.APIError as e:
            if "timeout" in str(e).lower():
                if container:
                    container.kill()
                return {
                    "exit_code": 1,
                    "stdout": "",
                    "stderr": f"Command execution timeout ({timeout} seconds)",
                    "success": False
                }
            else:
                return {
                    "exit_code": 1,
                    "stdout": "",
                    "stderr": f"Docker API error: {e}",
                    "success": False
                }
        except Exception as e:
            return {
                "exit_code": 1,
                "stdout": "",
                "stderr": f"Container execution error: {e}",
                "success": False
            }
        finally:
            if container:
                try:
                    container.remove(force=True)
                except:
                    pass
    
    def get_sandbox_info(self) -> Dict[str, Any]:
        container_status = "unknown"
        if self.persistent:
            try:
                container = self.client.containers.get(self.container_name)
                container_status = container.status
            except:
                container_status = "not_exists"
        
        info = {
            "docker_available": DOCKER_AVAILABLE,
            "image": self.image,
            "image_exists": self._image_exists(),
            "supported_languages": ["shell", "python"],
            "persistent_container": {
                "enabled": self.persistent,
                "container_name": self.container_name,
                "status": container_status
            },
            "security": {
                "container_isolation": True,
                "network_access_default": True,
                "resource_limits": True,
                "filesystem_isolation": True,
                "sandbox_mount": True,
                "no_subprocess": True,
                "command_injection_protection": True
            },
            "sandbox_home": str(sandbox_home()),
            "default_working_dir": DEFAULT_WORKDIR,
            "default_timeout": DEFAULT_TIMEOUT,
            "docker_sdk_version": docker.__version__ if DOCKER_AVAILABLE else "Not installed"
        }
        
        return info


# 全局执行器实例
_executor = None

def _get_executor(persistent: bool = True):
    global _executor
    if _executor is None:
        _executor = TaskboxExecutor(persistent=persistent)
    return _executor

def invoke_execute_shell(
    command: str,
    timeout: int = DEFAULT_TIMEOUT,
    working_dir: str = DEFAULT_WORKDIR,
    enable_network: bool = True,
    language: str = "shell",
    libraries: List[str] = None,
    persistent: bool = True
) -> Dict[str, Any]:
    """
    在taskbox容器中执行shell命令
    
    Args:
        command: 要执行的shell命令
        timeout: 超时时间（秒）
        working_dir: 工作目录（容器内路径）
        enable_network: 是否启用网络访问
        language: 语言环境
        libraries: 需要安装的库列表
        persistent: 是否使用持久化容器（跨调用保持状态）
        
    Returns:
        执行结果字典
    """
    try:
        executor = _get_executor(persistent=persistent)
        result = executor.execute_command(
            command=command,
            timeout=timeout,
            working_dir=working_dir,
            enable_network=enable_network,
            language=language,
            libraries=libraries or [],
            persistent=persistent
        )
        
        if "execution_time" not in result:
            result["execution_time"] = 0
        
        output = {
            "command": command,
            "exit_code": result["exit_code"],
            "success": result["success"],
            "execution_time": result.get("execution_time"),
            "output": result["stdout"]
        }
        
        if result["stderr"]:
            output["error"] = result["stderr"]
        
        if not result["success"]:
            output["warning"] = "Command failed or was terminated"
        
        return output
        
    except Exception as e:
        error_msg = str(e)
        if "Docker Python SDK not installed" in error_msg:
            error_msg = (
                "Docker Python SDK is required for secure shell execution.\n\n"
                "Please install it with:\n"
                "    pip install docker\n\n"
                "Also ensure Docker is installed and running:\n"
                "    docker --version\n"
                "    sudo systemctl status docker  # Linux"
            )
        elif "Docker connection failed" in error_msg:
            error_msg = (
                f"Docker connection failed: {error_msg}\n\n"
                "Please ensure:\n"
                "1. Docker service is running\n"
                "2. Current user has permission to access Docker\n"
                "3. Docker socket is accessible (/var/run/docker.sock)"
            )
        elif "Failed to build image" in error_msg:
            error_msg = (
                f"Failed to build taskbox image: {error_msg}\n\n"
                "You can try building manually:\n"
                "    docker build -t taskbox:latest - < <(echo '...Dockerfile content...')"
            )
        
        return {
            "command": command,
            "exit_code": 1,
            "success": False,
            "error": error_msg,
            "recommendation": "Check Docker installation and permissions"
        }

# {
#   "type": "function",
#   "function": {
#     "name": "shell_sandbox_info",
#     "description": "Get information about the Docker sandbox environment, including Docker status, image details, and security settings.",
#     "parameters": {
#       "type": "object",
#       "properties": {},
#       "required": []
#     }
#   }
# },
def invoke_shell_sandbox_info() -> Dict[str, Any]:
    """获取沙盒环境信息"""
    try:
        executor = _get_executor()
        return executor.get_sandbox_info()
    except Exception as e:
        return {
            "error": str(e),
            "docker_available": False,
            "recommendation": "Install Docker Python SDK: pip install docker"
        }

# {
#   "type": "function",
#   "function": {
#     "name": "shell_cleanup",
#     "description": "Clean up the persistent container (if exists). Use this to free resources or reset the environment.",
#     "parameters": {
#       "type": "object",
#       "properties": {},
#       "required": []
#     }
#   }
# }
def invoke_shell_cleanup():
    """清理持久化容器（如果存在）"""
    try:
        executor = _get_executor()
        executor.stop_container()
        return {
            "success": True,
            "message": f"Persistent container {CONTAINER_NAME} has been cleaned up"
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }


if __name__ == "__main__":
    if len(sys.argv) > 1:
        if sys.argv[1] == "test":
            print("Testing taskbox shell execution (Docker SDK only)...")
            info = invoke_shell_sandbox_info()
            print(json.dumps(info, indent=2))
            
            if info.get("docker_available", False):
                print("\nTesting shell command execution with persistent container...")
                result = invoke_execute_shell(
                    command="echo 'Hello from taskbox' && pwd && ls -la",
                    working_dir="/sandbox",
                    persistent=True
                )
                print(json.dumps(result, indent=2))
                
                print("\nTesting Python execution...")
                result = invoke_execute_shell(
                    command="print('Hello from Python')\nimport sys\nprint(f'Python {sys.version}')",
                    language="python",
                    persistent=True
                )
                print(json.dumps(result, indent=2))
                
                print("\nTesting with libraries (shell)...")
                result = invoke_execute_shell(
                    command="curl --version",
                    language="shell",
                    libraries=["curl"],
                    persistent=True
                )
                print(json.dumps(result, indent=2))
                
                print("\nTesting with libraries (Python)...")
                result = invoke_execute_shell(
                    command="import numpy; print(f'numpy version: {numpy.__version__}')",
                    language="python",
                    libraries=["numpy"],
                    persistent=True
                )
                print(json.dumps(result, indent=2))
                
                print("\nTesting cleanup...")
                result = invoke_shell_cleanup()
                print(json.dumps(result, indent=2))
            else:
                print("\nDocker Python SDK not available. Please install:")
                print("    pip install docker")
        elif sys.argv[1] == "cleanup":
            result = invoke_shell_cleanup()
            print(json.dumps(result, indent=2))
        elif sys.argv[1] == "info":
            result = invoke_shell_sandbox_info()
            print(json.dumps(result, indent=2))
    else:
        print("Taskbox shell tool module loaded (Docker SDK only).")
        print("Use 'python tool_shell.py test' to test the environment.")
        print("Use 'python tool_shell.py cleanup' to clean up persistent container.")
        print("Use 'python tool_shell.py info' to get sandbox info.")

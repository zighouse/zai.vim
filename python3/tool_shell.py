#!/usr/bin/env python3
"""
Shell工具集 - 使用taskbox Docker容器安全地执行shell和Python命令
完全基于Docker Python SDK，避免subprocess注入风险
基于taskbox镜像：ubuntu/debian + Python 3.12 + C/C++工具链 + ccache
支持持久化容器，跨调用保持状态（安装的依赖、文件等）
支持项目级配置：通过zai_project.json文件配置Docker容器参数
"""

import json
import os
import sys
import time
import base64
from pathlib import Path
from typing import Dict, Any, Optional, List

from toolcommon import sandbox_home, get_project_config

try:
    import docker
    DOCKER_AVAILABLE = True
except ImportError:
    DOCKER_AVAILABLE = False
    DOCKER_ERROR = "Docker Python SDK not installed, please run: pip install docker"


def get_host_uid_gid():
    """获取主机用户的UID和GID"""
    import os
    try:
        uid = os.getuid()
        gid = os.getgid()
        return uid, gid
    except (AttributeError, ValueError):
        # Windows系统或其他异常情况，使用默认值
        return 1000, 1000


# 全局默认配置
DEFAULT_IMAGE = "taskbox:latest"
DEFAULT_WORKDIR = "/sandbox"
DEFAULT_TIMEOUT = 60
DEFAULT_CONTAINER_NAME = "zai-tool-shell-taskbox"


class TaskboxExecutor:
    """
    使用taskbox Docker容器执行命令，完全基于Docker SDK，支持持久化容器
    支持从zai_project.json加载项目级配置
    """
    
    def __init__(self, image: str = DEFAULT_IMAGE, persistent: bool = True):
        """
        初始化TaskboxExecutor
        
        Args:
            image: 容器镜像名称
            persistent: 是否使用持久化容器
        """
        if not DOCKER_AVAILABLE:
            raise RuntimeError(DOCKER_ERROR)
        
        self.client = docker.from_env()
        self.persistent = persistent
        self.container = None  # 持久化容器实例
        
        # 获取主机UID/GID
        self.host_uid, self.host_gid = get_host_uid_gid()
        
        # 加载项目配置
        self.project_config = self._load_project_config()
        
        # 应用项目配置中的shell_container设置
        self.shell_container_config = self._get_shell_container_config()
        
        # 确定最终配置
        self.image = self._get_config_value('image', image)
        self.container_name = self._get_config_value('name', DEFAULT_CONTAINER_NAME)
        self.working_dir = self._get_config_value('working_dir', DEFAULT_WORKDIR)
        
        # 用户配置：默认为主机用户UID:GID
        self.user = self._get_user_config()
        
        # 验证Docker连接
        try:
            self.client.ping()
        except Exception as e:
            raise RuntimeError(
                f"Docker connection failed: {e}\n"
                "Please ensure Docker service is running and current user has permission to access Docker"
            )
    
    def _load_project_config(self) -> Optional[Dict[str, Any]]:
        """加载项目配置"""
        return get_project_config()
    
    def _get_shell_container_config(self) -> Dict[str, Any]:
        """获取shell_container配置"""
        if not self.project_config:
            return {}
        
        # 从项目配置中提取shell_container
        shell_container = self.project_config.get('shell_container')
        if isinstance(shell_container, dict):
            return shell_container
        return {}
    
    def _get_config_value(self, key: str, default: Any) -> Any:
        """从shell_container配置中获取值，如果不存在则使用默认值"""
        return self.shell_container_config.get(key, default)
    
    def _get_user_config(self) -> str:
        """获取用户配置"""
        user_config = self.shell_container_config.get('user')
        if user_config is None:
            # 默认使用主机用户UID:GID
            return f"{self.host_uid}:{self.host_gid}"
        
        if isinstance(user_config, str):
            return user_config
        elif isinstance(user_config, int):
            return str(user_config)
        else:
            return f"{self.host_uid}:{self.host_gid}"
    
    def _image_exists(self) -> bool:
        """检查镜像是否存在"""
        try:
            self.client.images.get(self.image)
            return True
        except docker.errors.ImageNotFound:
            return False
        except Exception as e:
            print(f"Error checking image: {e}", file=sys.stderr)
            return False
    
    def _build_image_if_needed(self):
        """如果镜像不存在，尝试构建默认taskbox镜像"""
        if self._image_exists():
            return
        
        print(f"Image {self.image} doesn't exist, trying to build...", file=sys.stderr)
        
        # 从配置获取Dockerfile路径
        dockerfile_path = self.shell_container_config.get('Dockerfile', 'Dockerfile.taskbox')
        
        # 首先尝试读取指定的Dockerfile文件
        dockerfile_content = None
        if os.path.exists(dockerfile_path):
            try:
                with open(dockerfile_path, 'r', encoding='utf-8') as f:
                    dockerfile_content = f.read()
                print(f"Using external Dockerfile: {dockerfile_path}", file=sys.stderr)
            except Exception as e:
                print(f"Failed to read external Dockerfile: {e}, using built-in default configuration", file=sys.stderr)
        
        # 如果没有外部文件，使用内置的默认Dockerfile
        if dockerfile_content is None:
            dockerfile_content = f"""
# 使用 2025 年主流的 Python 3.12 镜像
FROM python:3.12-slim

# 设置环境变量，防止交互式弹窗阻塞构建
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC

# 允许在构建时传递主机用户ID和组ID
ARG HOST_UID={self.host_uid}
ARG HOST_GID={self.host_gid}

# --- 步骤 1: 替换阿里 APT 源 ---
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
        sudo \
    && rm -rf /var/lib/apt/lists/*

# --- 步骤 2: 创建与主机用户同UID/GID的用户，并赋予sudo权限（无需密码）---
RUN groupadd -g $HOST_GID sandbox \
    && useradd -m -u $HOST_UID -g $HOST_GID -s /bin/bash sandbox \
    && echo "sandbox ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/sandbox \
    && chmod 0440 /etc/sudoers.d/sandbox

# --- 步骤 3: 替换阿里 PIP 源 ---
RUN pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/ \
    && pip config set install.trusted-host mirrors.aliyun.com \
    && pip install --upgrade pip

# --- 步骤 3: 配置 ccache 环境 ---
# 将 ccache 路径加入 PATH 顶层，使其接管编译命令
ENV PATH="/usr/lib/ccache:$PATH"
# 预设 ccache 目录到规划的 volume 中
ENV CCACHE_DIR=/ccache

# 创建项目依赖目录，并设置为可被sandbox写入
RUN mkdir -p /opt/project && chown -R $HOST_UID:$HOST_GID /opt/project

WORKDIR /sandbox

# 默认以root用户运行，但可以通过docker run -u $HOST_UID:$HOST_GID切换
# 为了保持兼容性，默认保持root身份，但确保/sandbox目录权限正确
# 注意：如果以sandbox身份运行，某些需要特权的操作可能失败
# 因此建议在启动容器时决定使用root还是sandbox

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
                    buildargs={
                        'HOST_UID': str(self.host_uid),
                        'HOST_GID': str(self.host_gid),
                        'TZ': 'UTC'
                    },
                    rm=True,
                    forcerm=True
                )
                for log in logs:
                    if 'stream' in log:
                        print(log['stream'], end='', file=sys.stderr)
                print(f"\nImage {self.image} built successfully", file=sys.stderr)
            except Exception as e:
                raise RuntimeError(
                    f"Failed to build image: {e}\n\n"
                    "You can build manually:\n"
                    "1. Save the Dockerfile content above\n"
                    "2. Run: docker build -t taskbox:latest -f Dockerfile ."
                )
    
    def _prepare_mounts(self) -> Dict[str, Dict[str, str]]:
        """
        准备挂载配置
        
        默认挂载：
        1. sandbox_home() -> /sandbox
        2. /etc/localtime -> /etc/localtime:ro
        3. /etc/timezone -> /etc/timezone:ro
        
        如果项目配置中有volumes字段，则合并使用：
        - 项目配置中的挂载会添加到默认挂载之后
        - 如果项目配置中的源路径与默认挂载相同，则项目配置会覆盖默认挂载
        """
        mounts = {}
        
        # 默认挂载：沙盒目录
        sandbox_root = sandbox_home()
        sandbox_root.mkdir(parents=True, exist_ok=True)
        mounts[str(sandbox_root)] = {
            "bind": "/sandbox",
            "mode": "rw"
        }
        
        # 默认挂载：主机时区
        mounts["/etc/localtime"] = {
            "bind": "/etc/localtime",
            "mode": "ro"
        }
        mounts["/etc/timezone"] = {
            "bind": "/etc/timezone",
            "mode": "ro"
        }
        
        # 从项目配置中获取额外的挂载
        volumes = self.shell_container_config.get('volumes', [])
        if isinstance(volumes, list):
            for vol_spec in volumes:
                if isinstance(vol_spec, str):
                    parts = vol_spec.split(':')
                    if len(parts) >= 2:
                        source = parts[0].strip()
                        target = parts[1].strip()
                        mode = parts[2].strip() if len(parts) > 2 else 'rw'
                        mounts[source] = {
                            "bind": target,
                            "mode": mode
                        }
                        print(f"项目配置挂载: {source} -> {target} ({mode})", file=sys.stderr)
        
        return mounts
    
    def _prepare_python_command(self, code: str) -> List[str]:
        """准备Python命令列表，安全地执行Python代码"""
        # 如果代码是单行且简单，直接使用python3 -c
        if "\n" not in code and len(code) < 1000 and '"' not in code and "'" not in code:
            return ["python3", "-c", code]
        
        # 多行或复杂代码使用base64编码
        encoded = base64.b64encode(code.encode()).decode()
        return ["python3", "-c", f"import base64; exec(base64.b64decode('{encoded}').decode())"]
    
    def _prepare_shell_command(self, command: str, libraries: List[str] = None) -> List[str]:
        libraries = libraries or []
        parts = []
        
        if libraries:
            install_cmd = f"apt-get update && apt-get install -y {' '.join(libraries)} || echo 'Package installation may have failed, continuing execution...'"
            parts.append(install_cmd)
        
        if command:
            parts.append(command)
        
        if len(parts) == 0:
            return ["echo", "No command provided"]
        
        full_command = " && ".join(parts)
        return ["sh", "-c", full_command]
    
    def _merge_configs(self, base_config: Dict[str, Any], project_config: Dict[str, Any]) -> Dict[str, Any]:
        """
        合并基础配置和项目配置
        
        处理规则：
        1. 简单值（字符串、数字、布尔值）：项目配置覆盖基础配置
        2. 列表：合并两个列表（基础配置在前，项目配置在后）
        3. 字典：合并字典，项目配置的值覆盖基础配置的值
        4. 特殊字段处理：
           - volumes: 已在_prepare_mounts中特殊处理
           - command: 直接替换，不合并（因为是要执行的命令）
           - entrypoint: 直接替换，不合并（Docker容器的入口点）
        """
        result = base_config.copy()
        
        # 需要直接替换而不是合并的字段
        replace_fields = {'command', 'entrypoint'}
        
        for key, project_value in project_config.items():
            # 跳过注释字段
            if key == '//':
                continue
                
            # 如果基础配置中没有这个键，直接使用项目配置的值
            if key not in result:
                result[key] = project_value
                continue
            
            base_value = result[key]
            
            # 检查是否需要直接替换
            if key in replace_fields:
                # 直接替换，不合并
                result[key] = project_value
                print(f"项目配置替换字段 {key}: {base_value} -> {project_value}", file=sys.stderr)
                continue
            
            # 根据类型进行合并
            if isinstance(project_value, list) and isinstance(base_value, list):
                # 列表合并：基础配置在前，项目配置在后
                # 对于某些字段如volumes，已经在_prepare_mounts中特殊处理
                if key == 'volumes':
                    # volumes已经在_prepare_mounts中处理，跳过
                    continue
                # 合并列表
                merged_list = base_value + project_value
                result[key] = merged_list
                print(f"合并列表字段 {key}: 基础配置{len(base_value)}项 + 项目配置{len(project_value)}项 = 总计{len(merged_list)}项", file=sys.stderr)
                
            elif isinstance(project_value, dict) and isinstance(base_value, dict):
                # 字典合并：项目配置的值覆盖基础配置的值
                merged_dict = base_value.copy()
                merged_dict.update(project_value)
                result[key] = merged_dict
                print(f"合并字典字段 {key}: 基础配置{len(base_value)}项 + 项目配置{len(project_value)}项 = 总计{len(merged_dict)}项", file=sys.stderr)
                
            else:
                # 简单值：项目配置覆盖基础配置
                if base_value != project_value:
                    result[key] = project_value
                    print(f"项目配置覆盖字段 {key}: {base_value} -> {project_value}", file=sys.stderr)
        
        return result
    
    def _create_container_config(self, cmd_list: List[str] = None, is_persistent: bool = True) -> Dict[str, Any]:
        """
        创建容器配置
        
        基础配置 + 项目配置中的shell_container设置
        项目配置中的设置会覆盖基础配置
        
        注意：项目配置中的任何有效Docker SDK参数都会被传递，
        让Docker SDK处理参数验证。
        """
        # 基础配置
        base_config = {
            "image": self.image,
            "name": self.container_name,
            "working_dir": self.working_dir,
            "volumes": self._prepare_mounts(),
            "mem_limit": "4g",
            "cpu_period": 100000,
            "cpu_quota": 50000,
            "detach": True,
            "auto_remove": False
        }
        
        # 确定命令
        # 如果有显式命令列表，使用它
        if cmd_list is not None:
            base_config["command"] = cmd_list
        # 否则如果是持久化容器，使用项目配置中的命令或默认tail命令
        elif is_persistent:
            # 优先使用项目配置中的command
            project_command = self.shell_container_config.get('command')
            if project_command:
                base_config["command"] = project_command
                print(f"使用项目配置的持久化容器命令: {project_command}", file=sys.stderr)
            else:
                base_config["command"] = ["tail", "-f", "/dev/null"]
        
        # 设置用户
        base_config["user"] = self.user
        
        # 合并项目配置中的其他Docker SDK参数
        # 排除已经在基础配置中显式处理的字段和非Docker SDK字段
        exclude_fields = {'Dockerfile', '//', 'image', 'name', 'working_dir', 'user', 'command', 'volumes'}
        
        # 创建要合并的项目配置子集
        project_config_to_merge = {}
        for key, value in self.shell_container_config.items():
            if key not in exclude_fields:
                project_config_to_merge[key] = value
        
        # 合并配置
        if project_config_to_merge:
            print(f"合并项目配置字段: {list(project_config_to_merge.keys())}", file=sys.stderr)
            container_config = self._merge_configs(base_config, project_config_to_merge)
        else:
            container_config = base_config
        
        return container_config
    
    def ensure_container_running(self) -> bool:
        """
        确保持久化容器正在运行
        
        如果容器不存在，则创建并启动一个容器
        如果容器存在但已停止，则启动它
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
            
            # 创建持久化容器配置
            container_config = self._create_container_config(is_persistent=True)
            
            try:
                # 创建并启动容器
                self.container = self.client.containers.create(**container_config)
                self.container.start()
                
                time.sleep(2)
                print(f"Persistent container {self.container_name} has been started and is running", file=sys.stderr)
                return True
            except Exception as e:
                print(f"Failed to create container: {e}", file=sys.stderr)
                return False
                
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
        在持久化容器中执行命令
        """
        if not self.container:
            raise RuntimeError("Container not initialized")
        
        try:
            # 如果timeout > 0，使用timeout命令包装
            if timeout > 0:
                final_cmd_list = ["timeout", str(timeout)] + cmd_list
            else:
                final_cmd_list = cmd_list
            
            result = self.container.exec_run(
                cmd=final_cmd_list,
                workdir=working_dir or self.working_dir,
                user=self.user,
                stdout=True,
                stderr=True,
                demux=False  # 不分离 stdout/stderr，返回合并的输出
            )
            
            exit_code = result.exit_code
            output = result.output.decode('utf-8', errors='replace') if isinstance(result.output, bytes) else result.output
            
            # 检查是否因timeout命令而退出（退出码124）
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
        working_dir: str = None,
        enable_network: bool = True,
        language: str = "shell",
        libraries: List[str] = None,
        persistent: bool = None
    ) -> Dict[str, Any]:
        """
        在taskbox容器中执行命令
        
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
        use_persistent = self.persistent if persistent is None else persistent
        
        if not enable_network and use_persistent:
            print("Warning: Cannot use persistent container when network is disabled, falling back to temporary container", file=sys.stderr)
            use_persistent = False
        
        try:
            if not self._image_exists():
                self._build_image_if_needed()
            
            # 准备命令
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
                
                return self._exec_in_container(cmd_list, timeout, working_dir)
            else:
                return self._execute_in_temp_container(cmd_list, timeout, working_dir, enable_network)
                
        except Exception as e:
            return {
                "exit_code": 1,
                "stdout": "",
                "stderr": f"Execution failed: {e}",
                "success": False
            }
    
    def _execute_in_temp_container(self, cmd_list: List[str], timeout: int, working_dir: str, enable_network: bool) -> Dict[str, Any]:
        """在临时容器中执行命令"""
        # 创建临时容器配置
        container_config = self._create_container_config(cmd_list=cmd_list, is_persistent=False)
        
        # 网络设置：优先考虑enable_network参数
        if not enable_network:
            # 禁用网络，覆盖项目配置中的任何网络设置
            container_config["network_mode"] = "none"
            print("临时容器网络已禁用（network_mode=none）", file=sys.stderr)
        else:
            # 启用网络，使用项目配置中的network_mode（如果指定）
            network_mode = self.shell_container_config.get('network_mode')
            if network_mode:
                container_config["network_mode"] = network_mode
                print(f"使用项目配置的网络模式: {network_mode}", file=sys.stderr)
        
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
        """获取沙盒环境信息"""
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
                "status": container_status,
                "user": self.user,
                "host_uid": self.host_uid,
                "host_gid": self.host_gid
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
            "working_dir": self.working_dir,
            "default_timeout": DEFAULT_TIMEOUT,
            "docker_sdk_version": docker.__version__ if DOCKER_AVAILABLE else "Not installed",
            "project_config_loaded": bool(self.project_config),
            "shell_container_config": self.shell_container_config
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
    working_dir: str = None,
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
            "message": f"Persistent container {DEFAULT_CONTAINER_NAME} has been cleaned up"
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }


if __name__ == "__main__":
    if len(sys.argv) > 1:
        if sys.argv[1] == "test":
            print("Testing taskbox shell execution with project configuration...")
            info = invoke_shell_sandbox_info()
            print(json.dumps(info, indent=2))
            
            if info.get("docker_available", False):
                print("\nProject configuration loaded:", info.get("project_config_loaded"))
                if info.get("shell_container_config"):
                    print("Shell container config:", info.get("shell_container_config"))
        elif sys.argv[1] == "cleanup":
            result = invoke_shell_cleanup()
            print(json.dumps(result, indent=2))
        elif sys.argv[1] == "info":
            result = invoke_shell_sandbox_info()
            print(json.dumps(result, indent=2))
    else:
        print("Taskbox shell tool module loaded (with project configuration support).")
        print("Use 'python tool_shell.py test' to test the environment.")
        print("Use 'python tool_shell.py cleanup' to clean up persistent container.")
        print("Use 'python tool_shell.py info' to get sandbox info.")

#!/usr/bin/env python3
import sys
import subprocess
import importlib
import argparse
import platform
from typing import List, Tuple

# 核心依赖 - 必须安装
CORE_DEPS = [
    "openai>=1.0.0",
    "requests>=2.28.0", 
    "appdirs>=1.4.0",
    "chardet>=5.0.0",
    "PyYAML>=6.0.0",
    "tiktoken>=0.5.0",
]

# 可选依赖 - 按需安装
OPTIONAL_DEPS = {
    "web": [
        "beautifulsoup4>=4.12.0",  # bs4
        "selenium>=4.10.0",
        "undetected-chromedriver>=3.5.0",
        "html-to-markdown>=1.0.0",  # HTML转Markdown转换
    ],
    "file": [
        "python-magic>=0.4.27",  # 文件类型检测
    ],
    "system": [
        "distro>=1.8.0",  # Linux发行版检测
        "docker>=6.0.0",  # Docker Python SDK
    ],
    "ai": [
        "transformers>=4.30.0",  # Hugging Face Transformers
    ],
    "utils": [
        "lunarcalendar>=0.0.9",  # 农历日历
    ]
}

# 系统依赖提示
SYSTEM_DEPS_NOTES = {
    "web": """
    ⚠ Web搜索功能需要额外的系统依赖：
    
    对于Linux (Ubuntu/Debian):
      sudo apt install chromium-browser
      # 或从官网安装Google Chrome
    
    对于Windows:
      - 安装Google Chrome浏览器
      - ChromeDriver会自动管理，但需要Chrome浏览器
      
    注意：Web搜索功能在Linux上体验最佳，Windows可能需额外配置。
    """,
    
    "system": """
    ⚠ Docker容器功能需要额外的系统依赖：
    
    对于Linux (Ubuntu/Debian):
      sudo apt install docker.io docker-compose
      sudo usermod -aG docker $USER
      sudo systemctl restart docker
      # 注销并重新登录使docker组生效
      
    对于Windows:
      - 安装Docker Desktop
      - 启用WSL2集成（推荐）
      - 配置共享驱动器
      
    注意：Docker功能在Linux上最稳定，Windows需要Docker Desktop。
    """,
    
    "file": """
    ⚠ 文件类型检测可能需要系统库：
    
    对于Linux (Ubuntu/Debian):
      sudo apt install libmagic1
      
    对于Windows:
      - 可能需要安装magic DLL
      - 或使用python-magic-bin替代包
    """
}

def check_dependency(package_name: str) -> bool:
    """检查依赖是否已安装"""
    try:
        # 特殊处理带连字符的包名
        if package_name == "html-to-markdown":
            import html_to_markdown
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
            # 尝试直接导入包名
            importlib.import_module(package_name.split('>=')[0].split('[')[0])
        return True
    except ImportError:
        return False

def install_dependencies(deps: List[str], optional: bool = False) -> Tuple[int, int]:
    """安装依赖列表"""
    installed = 0
    failed = 0
    
    for dep in deps:
        package_name = dep.split('>=')[0].split('[')[0]
        
        if check_dependency(package_name):
            print(f"✓ {package_name} 已安装")
            installed += 1
            continue
            
        print(f"正在安装 {dep}...")
        try:
            # 使用pip安装
            subprocess.check_call([sys.executable, "-m", "pip", "install", dep])
            print(f"✓ 成功安装 {package_name}")
            installed += 1
        except subprocess.CalledProcessError as e:
            if optional:
                print(f"⚠ 可选依赖 {package_name} 安装失败: {e}")
            else:
                print(f"✗ 核心依赖 {package_name} 安装失败: {e}")
            failed += 1
            
    return installed, failed

def install_all_optional():
    """安装所有可选依赖"""
    total_installed = 0
    total_failed = 0
    
    print("安装所有可选依赖...")
    for category, deps in OPTIONAL_DEPS.items():
        print(f"\n安装 {category} 相关依赖:")
        
        # 显示系统依赖提示
        if category in SYSTEM_DEPS_NOTES:
            print(SYSTEM_DEPS_NOTES[category])
        
        installed, failed = install_dependencies(deps, optional=True)
        total_installed += installed
        total_failed += failed
    
    return total_installed, total_failed

def install_specific_optional(categories: List[str]):
    """安装指定的可选依赖类别"""
    total_installed = 0
    total_failed = 0
    
    for category in categories:
        if category not in OPTIONAL_DEPS:
            print(f"⚠ 未知的依赖类别: {category}")
            continue
            
        print(f"\n安装 {category} 相关依赖:")
        
        # 显示系统依赖提示
        if category in SYSTEM_DEPS_NOTES:
            print(SYSTEM_DEPS_NOTES[category])
        
        installed, failed = install_dependencies(OPTIONAL_DEPS[category], optional=True)
        total_installed += installed
        total_failed += failed
    
    return total_installed, total_failed

def show_platform_info():
    """显示平台信息"""
    print(f"操作系统: {platform.system()} {platform.release()}")
    print(f"Python版本: {platform.python_version()}")
    print(f"平台架构: {platform.machine()}")
    print()

def show_system_deps_summary():
    """显示系统依赖总结"""
    print("\n" + "=" * 60)
    print("系统依赖安装指南 (Linux Ubuntu/Debian)")
    print("=" * 60)
    
    print("""
1. 安装Docker（用于安全shell执行）:
   sudo apt install docker.io docker-compose
   sudo usermod -aG docker $USER
   sudo systemctl restart docker
   # 注销并重新登录使docker组生效

2. 安装Chrome/Chromium（用于Web搜索）:
   sudo apt install chromium-browser
   # 或从官网安装Google Chrome

3. 安装开发工具:
   sudo apt install build-essential python3-dev

4. 验证安装:
   docker --version
   chromium-browser --version  # 或 google-chrome --version
   """)
    
    print("注意：Windows上也可安装Docker Desktop和Chrome，但配置较复杂。")
    print("Linux环境推荐使用Ubuntu/Debian发行版。")
    print("=" * 60)

def main():
    parser = argparse.ArgumentParser(description="Zai.Vim 依赖安装工具")
    parser.add_argument("--optional", nargs="*", 
                       help="安装指定的可选依赖类别: web, file, system, ai, utils")
    parser.add_argument("--all-optional", action="store_true",
                       help="安装所有可选依赖")
    parser.add_argument("--skip-core", action="store_true",
                       help="跳过核心依赖安装")
    parser.add_argument("--show-system-deps", action="store_true",
                       help="显示系统依赖安装指南")
    
    args = parser.parse_args()
    
    # 显示系统依赖指南
    if args.show_system_deps:
        show_system_deps_summary()
        return
    
    print("=" * 60)
    print("Zai.Vim Python 依赖安装工具")
    print("=" * 60)
    
    # 显示平台信息
    show_platform_info()
    
    # 安装核心依赖
    if not args.skip_core:
        print("\n检查并安装核心依赖...")
        installed, failed = install_dependencies(CORE_DEPS, optional=False)
        print(f"\n核心依赖安装完成: {installed} 个成功, {failed} 个失败")
        
        if failed > 0:
            print("⚠ 部分核心依赖安装失败，可能影响基本功能")
    
    # 安装可选依赖
    if args.all_optional:
        installed, failed = install_all_optional()
        print(f"\n可选依赖安装完成: {installed} 个成功, {failed} 个失败")
    elif args.optional:
        installed, failed = install_specific_optional(args.optional)
        print(f"\n指定可选依赖安装完成: {installed} 个成功, {failed} 个失败")
    
    print("\n" + "=" * 60)
    print("安装完成!")
    print("\n使用说明:")
    print("1. 基本功能只需要核心依赖")
    print("2. Web相关功能需要: --optional web")
    print("3. 文件类型检测需要: --optional file")
    print("4. Docker容器功能需要: --optional system")
    print("5. 完整安装: --all-optional")
    print("6. 系统依赖指南: --show-system-deps")
    print("\n重要提示:")
    print("- Web搜索需要Chrome浏览器（系统依赖）")
    print("- Shell工具需要Docker引擎（系统依赖）")
    print("- html-to-markdown用于HTML转Markdown转换")
    print("- 详细系统依赖安装见: --show-system-deps")
    print("=" * 60)

if __name__ == "__main__":
    main()

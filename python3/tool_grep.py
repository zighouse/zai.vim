#!/usr/bin/env python3
"""
Grep工具集 - 在文件中搜索文本模式，类似于Unix grep命令
支持递归搜索、正则表达式、大小写敏感等选项
搜索范围限制在沙盒主目录内以确保安全，输出路径相对于沙盒根目录
"""

import subprocess
import os
import re
import sys
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

from toolcommon import sanitize_path, sandbox_home
MAX_LEN = 4096


def invoke_grep(
    pattern: str,
    path: str = ".",
    recursive: bool = True,
    case_sensitive: bool = True,
    use_regex: bool = False,
    max_results: int = 10,
    include_pattern: Optional[str] = None,
    exclude_pattern: Optional[str] = None,
    show_line_numbers: bool = True,
    context_lines: int = 0
) -> str:
    """
    在文件中搜索文本模式，返回格式化的搜索结果
    
    注意：
    1. 搜索范围限制在沙盒主目录内以确保安全
    2. 输出路径始终相对于沙盒根目录，便于其他工具（如read_file）使用
    """
    try:
        search_root = sanitize_path(path)
        sandbox_root = sandbox_home()
        
        if not search_root.exists():
            return f"Error: Path '{path}' does not exist"
        
        if not search_root.is_dir():
            return f"Error: '{path}' is not a directory"
        
        if not _check_grep_available():
            return _grep_python(
                pattern, search_root, sandbox_root, recursive, case_sensitive, use_regex,
                max_results, include_pattern, exclude_pattern,
                show_line_numbers, context_lines
            )
        
        cmd_parts = ["grep", "-I"]
        
        if not case_sensitive:
            cmd_parts.append("-i")
        
        if recursive:
            cmd_parts.append("-r")
        
        if use_regex:
            cmd_parts.append("-E")
        
        if show_line_numbers:
            cmd_parts.append("-n")
        
        if context_lines > 0:
            cmd_parts.append(f"-{context_lines}")
        
        if exclude_pattern:
            cmd_parts.extend(["--exclude", exclude_pattern])
        
        if include_pattern:
            cmd_parts.extend(["--include", include_pattern])
        
        rel_search_path = search_root.relative_to(sandbox_root)
        cmd_parts.append(pattern)
        cmd_parts.append(str(rel_search_path) if str(rel_search_path) != "." else ".")
        
        original_cwd = Path.cwd()
        os.chdir(sandbox_root)
        
        try:
            result = subprocess.run(
                cmd_parts,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='ignore',
                timeout=30
            )
        except subprocess.TimeoutExpired:
            os.chdir(original_cwd)
            return f"Error: grep command timed out (30 seconds)"
        except Exception as e:
            os.chdir(original_cwd)
            return f"Error: Failed to execute grep command - {str(e)}"
        finally:
            os.chdir(original_cwd)
        
        output_lines = result.stdout.strip().split('\n')
        error_lines = result.stderr.strip().split('\n')
        
        output_lines = [
            (line[:MAX_LEN] + "..." if len(line) > MAX_LEN else line) 
            for line in output_lines if line.strip()
        ]
        
        if max_results > 0 and len(output_lines) > max_results:
            output_lines = output_lines[:max_results]
            truncated = True
        else:
            truncated = False
        
        result_parts = []
        
        if error_lines and any(line.strip() for line in error_lines):
            result_parts.append("Warning:")
            for err in error_lines:
                if err.strip():
                    result_parts.append(f"  {err}")
            result_parts.append("")
        
        if not output_lines:
            return f"No matches found for '{pattern}' in directory '{path}'"
        
        result_parts.append(f"Found {len(output_lines)} matches in directory '{path}' (paths relative to sandbox root):")
        result_parts.append("")
        
        for i, line in enumerate(output_lines, 1):
            result_parts.append(f"{i:3d}: {line}")
        
        if truncated:
            result_parts.append(f"\n(Showing only first {max_results} results due to max_results limit)")
        
        if result.returncode != 0 and result.returncode != 1:
            result_parts.append(f"\nNote: grep command exited abnormally with return code {result.returncode}")
        
        return '\n'.join(result_parts)
        
    except ValueError as e:
        return f"Security error: {e}"
    except Exception as e:
        return f"Error: {str(e)}"


def _check_grep_available() -> bool:
    """检查系统grep命令是否可用"""
    try:
        subprocess.run(
            ["grep", "--version"],
            capture_output=True,
            text=True,
            timeout=5
        )
        return True
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return False


def _grep_python(
    pattern: str,
    search_root: Path,
    sandbox_root: Path,
    recursive: bool,
    case_sensitive: bool,
    use_regex: bool,
    max_results: int,
    include_pattern: Optional[str],
    exclude_pattern: Optional[str],
    show_line_numbers: bool,
    context_lines: int
) -> str:
    """
    使用Python实现grep功能（回退方案）
    """
    regex_flags = 0 if case_sensitive else re.IGNORECASE
    
    if use_regex:
        try:
            regex = re.compile(pattern, regex_flags)
        except re.error as e:
            return f"Error: Invalid regular expression '{pattern}' - {str(e)}"
    else:
        search_pattern = pattern if case_sensitive else pattern.lower()
    
    results: List[Tuple[Path, int, str]] = []
    
    if recursive:
        file_iterator = search_root.rglob("*")
    else:
        file_iterator = search_root.glob("*")
    
    for file_path in file_iterator:
        if not file_path.is_file():
            continue
        
        if include_pattern and not _matches_pattern(file_path.name, include_pattern):
            continue
        
        if exclude_pattern and _matches_pattern(file_path.name, exclude_pattern):
            continue
        
        try:
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
        except (IOError, OSError, UnicodeDecodeError):
            continue
        
        for line_num, line in enumerate(lines, 1):
            line_text = line.rstrip('\n')
            
            matched = False
            if use_regex:
                if regex.search(line_text):
                    matched = True
            else:
                if case_sensitive:
                    if pattern in line_text:
                        matched = True
                else:
                    if search_pattern in line_text.lower():
                        matched = True
            
            if matched:
                results.append((file_path, line_num, line_text))
                
                if max_results > 0 and len(results) >= max_results:
                    break
        
        if max_results > 0 and len(results) >= max_results:
            break
    
    if not results:
        return f"No matches found for '{pattern}' in directory '{search_root.relative_to(sandbox_root)}'"
    
    result_parts = []
    result_parts.append(f"Found {len(results)} matches in directory '{search_root.relative_to(sandbox_root)}' (paths relative to sandbox root):")
    result_parts.append("")
    
    for i, (file_path, line_num, line_text) in enumerate(results, 1):
        rel_path = file_path.relative_to(sandbox_root)
        if len(line_text) > MAX_LEN:
            line_text = line_text[:MAX_LEN] + "..."
        if show_line_numbers:
            result_parts.append(f"{i:3d}: {rel_path}:{line_num}: {line_text}")
        else:
            result_parts.append(f"{i:3d}: {rel_path}: {line_text}")
    
    if max_results > 0 and len(results) >= max_results:
        result_parts.append(f"\n(Showing only first {max_results} results due to max_results limit)")
    
    return '\n'.join(result_parts)


def _matches_pattern(filename: str, pattern: str) -> bool:
    """
    简单的通配符模式匹配，支持 * 和 ?
    """
    regex_pattern = pattern.replace('.', '\\.').replace('*', '.*').replace('?', '.')
    regex_pattern = f'^{regex_pattern}$'
    
    try:
        return bool(re.match(regex_pattern, filename))
    except re.error:
        return pattern in filename


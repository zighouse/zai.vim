#!/usr/bin/env python3
import json
import os
import random
import re
import requests
import shutil
import subprocess
import sys
import time
import urllib

from pathlib import Path
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from typing import List, Dict, Optional, Literal, Any, Tuple
from urllib.parse import quote_plus, urljoin

from toolcommon import sanitize_path

# 尝试导入 YAML
try:
    import yaml
    HAVE_YAML = True
except ImportError:
    HAVE_YAML = False

_DEFAULT_SEARCH_ENGINE = "https://html.duckduckgo.com/html/"

try:
    import uuid
    _SESSION_ID = uuid.uuid4().hex.upper()
except ImportError:
    _SESSION_ID = '06704B834B262359974E927A4F93EC45'

# 搜索引擎管理器
# 搜索引擎管理器
class SearchEngineManager:
    """搜索引擎管理器，支持多个搜索引擎轮换和频率限制避免"""
    
    def __init__(self, config_path: Optional[str] = None):
        self.config_path = config_path or self._get_default_config_path()
        self.engines: List[Dict[str, Any]] = []
        self.rotation_config: Dict[str, Any] = {}
        self.current_index = 0
        self.error_counts: Dict[str, int] = {}  # 引擎错误计数
        self.last_error_time: Dict[str, float] = {}  # 最后错误时间
        self.call_counts: Dict[str, int] = {}  # 引擎调用计数（用于跨N次调用轮换）
        self.call_timestamps: Dict[str, List[float]] = {}  # 调用时间戳（用于频繁调用检测）
        self.last_rotation_time = time.time()  # 上次轮换时间
        self.total_calls = 0  # 总调用次数
        self.load_config()
        
    def _get_default_config_path(self) -> str:
        """获取默认配置文件路径"""
        # 使用 appdirs 获取用户数据目录
        try:
            from appdirs import user_data_dir
            conf_dir = Path(user_data_dir("zai", "zighouse"))
            conf_dir.mkdir(parents=True, exist_ok=True)
            return str(conf_dir / "search_engines.yaml")
        except ImportError:
            # 回退到当前目录
            return "search_engines.yaml"
    
    def load_config(self) -> bool:
        """加载搜索引擎配置"""
        config_file = Path(self.config_path)
        
        # 如果配置文件不存在，创建默认配置
        if not config_file.exists():
            self._create_default_config(config_file)
            return True
        
        try:
            if HAVE_YAML and self.config_path.endswith(('.yaml', '.yml')):
                with open(config_file, 'r', encoding='utf-8') as f:
                    config_data = yaml.safe_load(f)
            elif self.config_path.endswith('.json'):
                with open(config_file, 'r', encoding='utf-8') as f:
                    config_data = json.load(f)
            else:
                # 尝试作为 YAML 加载
                if HAVE_YAML:
                    with open(config_file, 'r', encoding='utf-8') as f:
                        config_data = yaml.safe_load(f)
                else:
                    # 回退到 JSON
                    with open(config_file, 'r', encoding='utf-8') as f:
                        config_data = json.load(f)
            
            # 解析配置
            self.engines = config_data.get('search_engines', [])
            self.rotation_config = config_data.get('rotation', {})
            
            # 过滤启用的引擎
            self.engines = [engine for engine in self.engines 
                          if engine.get('enabled', True)]
            
            # 按权重排序
            self.engines.sort(key=lambda x: x.get('weight', 1.0), reverse=True)
            
            # 初始化调用计数和时间戳
            for engine in self.engines:
                engine_name = engine.get('name', '')
                self.call_counts[engine_name] = 0
                self.call_timestamps[engine_name] = []
            
            return True
            
        except Exception as e:
            print(f"Failed to load search engine config: {e}", file=sys.stderr)
            # 加载默认引擎
            self._load_default_engines()
            return False
    
    def _create_default_config(self, config_file: Path) -> None:
        """创建默认配置文件"""
        default_config = {
            'search_engines': [
                {
                    'name': 'duckduckgo',
                    'url': 'https://html.duckduckgo.com/html/',
                    'enabled': True,
                    'weight': 1.0
                },
                {
                    'name': 'bing',
                    'url': 'https://cn.bing.com',
                    'enabled': True,
                    'weight': 1.0
                },
                {
                    'name': 'google',
                    'url': 'https://www.google.com',
                    'enabled': True,
                    'weight': 1.0
                },
                #{
                #    'name': 'baidu',
                #    'url': 'https://www.baidu.com',
                #    'enabled': True,
                #    'weight': 0.5
                #}
            ],
            'rotation': {
                'strategy': 'frequency_based',  # none, call_count, frequency_based, round_robin, random, weighted
                'call_count_threshold': 10,      # 跨多少调用轮换
                'frequency_window_seconds': 10,  # 频率检测窗口（秒）
                'frequency_threshold': 3,        # 窗口内最大调用次数
                'fallback_on_error': True,
                'max_retries': 3,
                'cooldown_seconds': 60
            }
        }
        
        try:
            if HAVE_YAML and self.config_path.endswith(('.yaml', '.yml')):
                with open(config_file, 'w', encoding='utf-8') as f:
                    yaml.dump(default_config, f, default_flow_style=False, 
                             allow_unicode=True, indent=2)
            else:
                with open(config_file, 'w', encoding='utf-8') as f:
                    json.dump(default_config, f, indent=2, ensure_ascii=False)
            
            self.engines = default_config['search_engines']
            self.rotation_config = default_config['rotation']
            
            # 初始化调用计数和时间戳
            for engine in self.engines:
                engine_name = engine.get('name', '')
                self.call_counts[engine_name] = 0
                self.call_timestamps[engine_name] = []
            
        except Exception as e:
            print(f"Failed to create default config: {e}", file=sys.stderr)
            self._load_default_engines()
    
    def _load_default_engines(self) -> None:
        """加载默认搜索引擎（无配置文件时）"""
        self.engines = [
            {
                'name': 'duckduckgo',
                'url': 'https://html.duckduckgo.com/html/',
                'enabled': True,
                'weight': 1.0
            },
            {
                'name': 'bing',
                'url': 'https://cn.bing.com',
                'enabled': True,
                'weight': 1.0
            },
            {
                'name': 'google',
                'url': 'https://www.google.com',
                'enabled': True,
                'weight': 1.0
            },
            #{
            #    'name': 'baidu',
            #    'url': 'https://www.baidu.com',
            #    'enabled': True,
            #    'weight': 0.5
            #}
        ]
        self.rotation_config = {
            'strategy': 'frequency_based',
            'call_count_threshold': 10,
            'frequency_window_seconds': 10,
            'frequency_threshold': 3,
            'fallback_on_error': True,
            'max_retries': 3,
            'cooldown_seconds': 60
        }
        
        # 初始化调用计数和时间戳
        for engine in self.engines:
            engine_name = engine.get('name', '')
            self.call_counts[engine_name] = 0
            self.call_timestamps[engine_name] = []
    
    def get_engine_by_name(self, name: str) -> Optional[Dict[str, Any]]:
        """根据名称获取搜索引擎配置"""
        for engine in self.engines:
            if engine.get('name') == name:
                return engine
        return None
    
    def record_call(self, engine_name: str) -> None:
        """记录搜索引擎调用"""
        current_time = time.time()
        self.total_calls += 1
        self.call_counts[engine_name] = self.call_counts.get(engine_name, 0) + 1
        
        # 记录时间戳
        if engine_name not in self.call_timestamps:
            self.call_timestamps[engine_name] = []
        self.call_timestamps[engine_name].append(current_time)
        
        # 清理旧的时间戳（保留最近1小时的数据）
        cutoff_time = current_time - 3600
        self.call_timestamps[engine_name] = [
            ts for ts in self.call_timestamps[engine_name] if ts > cutoff_time
        ]
    
    def get_call_frequency(self, engine_name: str, window_seconds: Optional[int] = None) -> int:
        """获取指定时间窗口内的调用频率"""
        if engine_name not in self.call_timestamps:
            return 0
        
        window_seconds = window_seconds or self.rotation_config.get('frequency_window_seconds', 10)
        current_time = time.time()
        cutoff_time = current_time - window_seconds
        
        # 统计窗口内的调用次数
        recent_calls = [
            ts for ts in self.call_timestamps[engine_name] if ts > cutoff_time
        ]
        return len(recent_calls)
    
    def get_next_engine(self, requested_engine: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """根据策略获取下一个搜索引擎
        
        Args:
            requested_engine: 请求的引擎名称，如果为None则使用策略选择
            
        Returns:
            搜索引擎配置或None
        """
        if not self.engines:
            return None
        
        strategy = self.rotation_config.get('strategy', 'frequency_based')
        
        # 如果指定了引擎，直接返回（但要检查是否可用）
        if requested_engine and requested_engine != 'auto':
            engine = self.get_engine_by_name(requested_engine)
            if engine and engine.get('enabled', True):
                # 检查频率限制
                if self._should_rotate_due_to_frequency(engine.get('name', '')):
                    # 频率过高，需要轮换
                    return self._select_engine_by_strategy(strategy, exclude_engine=engine.get('name', ''))
                return engine
        
        # 根据策略选择引擎
        return self._select_engine_by_strategy(strategy)
    
    def _should_rotate_due_to_frequency(self, engine_name: str) -> bool:
        """检查是否因频率过高需要轮换"""
        frequency_window = self.rotation_config.get('frequency_window_seconds', 10)
        frequency_threshold = self.rotation_config.get('frequency_threshold', 3)
        
        recent_calls = self.get_call_frequency(engine_name, frequency_window)
        return recent_calls >= frequency_threshold
    
    def _should_rotate_due_to_call_count(self, engine_name: str) -> bool:
        """检查是否因调用次数需要轮换"""
        call_count_threshold = self.rotation_config.get('call_count_threshold', 10)
        engine_calls = self.call_counts.get(engine_name, 0)
        return engine_calls >= call_count_threshold
    
    def _select_engine_by_strategy(self, strategy: str, exclude_engine: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """根据策略选择引擎"""
        if strategy == 'none':
            # 不轮换，返回第一个可用引擎
            for engine in self.engines:
                if engine.get('enabled', True) and engine.get('name', '') != exclude_engine:
                    return engine
        
        elif strategy == 'call_count':
            # 跨N次调用轮换
            # 找到调用次数最少的引擎
            available_engines = []
            for engine in self.engines:
                if engine.get('enabled', True) and engine.get('name', '') != exclude_engine:
                    engine_name = engine.get('name', '')
                    # 检查是否需要轮换（达到阈值）
                    if self._should_rotate_due_to_call_count(engine_name):
                        continue  # 这个引擎需要轮换，跳过
                    available_engines.append(engine)
            
            if available_engines:
                # 选择调用次数最少的
                available_engines.sort(key=lambda x: self.call_counts.get(x.get('name', ''), 0))
                return available_engines[0]
            else:
                # 所有引擎都达到阈值，重置计数并返回第一个
                for engine in self.engines:
                    if engine.get('enabled', True):
                        engine_name = engine.get('name', '')
                        self.call_counts[engine_name] = 0
                return self.engines[0] if self.engines else None
        
        elif strategy == 'frequency_based':
            # 10秒内频繁调用时轮换
            current_time = time.time()
            available_engines = []
            
            for engine in self.engines:
                if not engine.get('enabled', True):
                    continue
                    
                engine_name = engine.get('name', '')
                if engine_name == exclude_engine:
                    continue
                
                # 检查冷却期
                cooldown = self.rotation_config.get('cooldown_seconds', 60)
                last_error = self.last_error_time.get(engine_name, 0)
                if current_time - last_error < cooldown:
                    continue
                
                # 检查频率
                if self._should_rotate_due_to_frequency(engine_name):
                    continue
                
                available_engines.append(engine)
            
            if available_engines:
                # 选择调用次数最少的
                available_engines.sort(key=lambda x: self.call_counts.get(x.get('name', ''), 0))
                return available_engines[0]
            else:
                # 所有引擎都频率过高或有错误，返回第一个（忽略频率限制）
                for engine in self.engines:
                    if engine.get('enabled', True) and engine.get('name', '') != exclude_engine:
                        return engine
        
        elif strategy == 'random':
            # 随机选择，考虑权重
            weights = [engine.get('weight', 1.0) for engine in self.engines 
                      if engine.get('enabled', True) and engine.get('name', '') != exclude_engine]
            eligible_engines = [engine for engine in self.engines 
                               if engine.get('enabled', True) and engine.get('name', '') != exclude_engine]
            
            if eligible_engines:
                return random.choices(eligible_engines, weights=weights, k=1)[0]
        
        elif strategy == 'weighted':
            # 加权轮询
            eligible_engines = [engine for engine in self.engines 
                               if engine.get('enabled', True) and engine.get('name', '') != exclude_engine]
            
            if eligible_engines:
                # 简单实现：按权重比例随机选择
                weights = [engine.get('weight', 1.0) for engine in eligible_engines]
                return random.choices(eligible_engines, weights=weights, k=1)[0]
        
        else:  # round_robin or default
            # 轮询，跳过有错误的引擎（在冷却期内）
            cooldown = self.rotation_config.get('cooldown_seconds', 60)
            current_time = time.time()
            
            for _ in range(len(self.engines)):
                engine = self.engines[self.current_index]
                self.current_index = (self.current_index + 1) % len(self.engines)
                
                if not engine.get('enabled', True):
                    continue
                    
                engine_name = engine.get('name', '')
                if engine_name == exclude_engine:
                    continue
                
                # 检查引擎是否在冷却期
                last_error = self.last_error_time.get(engine_name, 0)
                if current_time - last_error > cooldown:
                    return engine
            
            # 如果所有引擎都在冷却期，返回第一个
            return self.engines[0] if self.engines else None
        
        return None
    
    def report_error(self, engine_name: str) -> None:
        """报告搜索引擎错误"""
        self.error_counts[engine_name] = self.error_counts.get(engine_name, 0) + 1
        self.last_error_time[engine_name] = time.time()
    
    def report_success(self, engine_name: str) -> None:
        """报告搜索引擎成功"""
        # 重置错误计数
        if engine_name in self.error_counts:
            self.error_counts[engine_name] = 0
    
    def get_available_engines(self) -> List[str]:
        """获取所有可用引擎的名称列表"""
        return [engine.get('name', '') for engine in self.engines if engine.get('enabled', True)]
    
    def get_engine_stats(self) -> Dict[str, Dict[str, Any]]:
        """获取搜索引擎统计信息"""
        stats = {}
        for engine in self.engines:
            engine_name = engine.get('name', '')
            stats[engine_name] = {
                'calls': self.call_counts.get(engine_name, 0),
                'errors': self.error_counts.get(engine_name, 0),
                'last_error': self.last_error_time.get(engine_name, 0),
                'recent_frequency_10s': self.get_call_frequency(engine_name, 10),
                'recent_frequency_60s': self.get_call_frequency(engine_name, 60),
                'enabled': engine.get('enabled', True),
                'weight': engine.get('weight', 1.0)
            }
        return stats

# 全局搜索引擎管理器实例
_search_engine_manager = None

def get_search_engine_manager() -> SearchEngineManager:
    """获取全局搜索引擎管理器实例"""
    global _search_engine_manager
    if _search_engine_manager is None:
        _search_engine_manager = SearchEngineManager()
    return _search_engine_manager

def _remove_data_images(markdown_text):
    pattern = r'!\[[^\]]*\]\(data:image[^)]+\)'
    cleaned_text = re.sub(pattern, '', markdown_text)
    return cleaned_text

def _remove_images(markdown_text):
    empty_image_link_pattern = re.compile(r"!\[\]\(.*?\)", re.MULTILINE)
    cleaned_text = empty_image_link_pattern.sub("", markdown_text)
    return cleaned_text

def _remove_metas(text):
    lines = text.split('\n')
    cleaned_lines = []
    in_metadata_block = False

    for line in lines:
        # 检测metadata行的开始
        if re.match(r'^(meta-|title:|source_repo=|analytics-)', line.lower()):
            in_metadata_block = True
            continue

        # 检测base64编码的内容行
        if re.match(r'^[A-Za-z0-9+/]{20,}={0,2}$', line.strip()):
            in_metadata_block = True
            continue

        # 检测分隔符
        if line.strip() == '---':
            if in_metadata_block:
                in_metadata_block = False
                continue
            else:
                cleaned_lines.append(line)
                continue

        # 如果不在metadata块中，保留该行
        if not in_metadata_block:
            cleaned_lines.append(line)

    return '\n'.join(cleaned_lines)

def _fix_multiline_links(markdown_text):
    lines = markdown_text.split('\n')
    result_lines = []
    i = 0

    while i < len(lines):
        line = lines[i].rstrip()

        # 检查是否以 "- [" 开头，可能是跨行链接的开始
        if line.strip().startswith('- [') and not line.strip().endswith(']'):
            # 收集链接的所有部分
            link_parts = []
            j = i

            # 收集直到找到闭合的 "]"
            while j < len(lines) and ']' not in lines[j]:
                link_parts.append(lines[j].strip())
                j += 1

            if j < len(lines):
                link_parts.append(lines[j].strip())
                # 现在收集URL部分
                url_line = j
                while url_line < len(lines) and '(' not in lines[url_line]:
                    url_line += 1

                if url_line < len(lines):
                    # 提取URL
                    url_match = re.search(r'\(\s*([^)]+)\s*\)', lines[url_line])
                    if url_match:
                        url = url_match.group(1).strip()
                        # 构建单行链接
                        link_text = ' '.join(' '.join(part.split()) for part in link_parts)
                        # 清理格式
                        link_text = re.sub(r'-\s*\[\s*', '- [', link_text)
                        link_text = re.sub(r'\s*\]\s*', ']', link_text)
                        result_lines.append(f'{link_text}({url})')
                        i = url_line + 1
                        continue

        # 如果不是跨行链接，直接添加该行
        result_lines.append(line)
        i += 1

    return '\n'.join(result_lines)

def _remove_empty_links(markdown_text):
    empty_link_pattern = re.compile(r"\[\]\(.*?\)", re.MULTILINE)
    cleaned_text = empty_link_pattern.sub("", markdown_text)
    return cleaned_text

#_url_pattern = re.compile(r'(https?://\S+)')
_url_pattern = re.compile(r'(https?://[^\s<>(){}"\']+)')
_fragment_url_pattern = re.compile(r'(https?://[^#\s]+)#:~:text=([^\s\)]+)')
_link_or_url_pattern = re.compile(r'\[(.*?)\]\((.*?)\)|(https?://\S+)')
_link_pattern = re.compile(r'\[([^\]]+)\]\(([^)]+)\)')
def _parse_fragment_url(url):
    """ 从 URL 中提取 Text Fragment，移除 Fragment，并返回处理后的 URL 和 Fragment 文本。"""
    fragment_match = _fragment_url_pattern.match(url)
    if fragment_match:
        base_url = fragment_match.group(1)
        fragment_code = fragment_match.group(2)
        fragment = urllib.parse.unquote(fragment_code)
        return base_url, fragment
    return url, None

def _clean_url_labels(text):
    """
    清理 Markdown 链接标签中的 url
    1. [labelhttps://...](url)
    2. [label http://...](url)
    3. [https://...label](url)
    """
    def clean_label(match):
        full_label = match.group(1)
        url = match.group(2)
        def removement(match):
            return ""
        label = _url_pattern.sub(removement, full_label).strip()
        return f'[{label}]({url})'
    return _link_pattern.sub(clean_label, text)

def _process_url_fragment(markdown_text):
    """
    处理 Markdown 文本中的 URL：
    1. [label + url?](url-with-fragment) -> [label](cleaned_url) + fragment_text
    2. standalone_url-with-fragment -> cleaned_url + fragment_text
    """
    def process_match(match):
        if match.group(1) is not None: # Matched [link_text](url)
            link_label = match.group(1)
            link_url = match.group(2)
            cleaned_url, fragment = _parse_fragment_url(link_url)
            if fragment is not None:
                def removement(match):
                    return ""
                clean_link_text = _url_pattern.sub(removement, link_label).strip()
                return f'[{clean_link_text}]({cleaned_url}) {fragment}'
            else:
                return f'[{link_label}]({link_url})'
        elif match.group(3) is not None: # Matched standalone url
            original_url = match.group(3)
            cleaned_url, fragment = _parse_fragment_url(original_url)
            if fragment is not None:
                return f'{cleaned_url} {fragment}'
            else:
                return original_url
        return match.group(0) # Should not happen
    return _link_or_url_pattern.sub(process_match, markdown_text)

def _process_google_url_fragment(markdown_text):
    """
    处理 Google url 文本片段：
    [label](url-with-fragment)\n{next-line} -> [label](cleaned_url) fragment_text
    """
    pattern = re.compile(
        r'\((https?://[^#\s]+)#:~:text=([^\s\)]+)\)'  # 匹配带片段的 URL
        r'(\s*\n\s+)'                                 # 匹配换行及后续缩进
        r'([^\n]+)',                                  # 匹配下一行正文
        re.MULTILINE
    )

    def replacement(match):
        base_url = match.group(1)
        fragment = match.group(2)
        indentation = match.group(3)
        next_line_text = match.group(4)
        # 解码文本片段
        # Google 的格式通常是 start,end 或 prefix-,start,end
        # 这里简单处理：去掉逗号，进行 URL 解码
        decoded_fragment = urllib.parse.unquote(fragment).replace(',', ' ')
        new_text = f"{decoded_fragment}".strip()
        return f"({base_url}){indentation}{new_text}"

    return pattern.sub(replacement, markdown_text)

def _deduplicate_by_url(markdown_text):
    """
    通过URL对段落进行去重，保留内容更长的段落，
    返回段落列表
    """
    paragraphs = markdown_text.split('\n\n')
    url_to_paragraph = {}
    to_remove = set()
    for i, para in enumerate(paragraphs):
        urls = _url_pattern.findall(para)
        if urls:
            # 使用第一个URL作为标识符（通常是最相关的）
            primary_url = urls[0]
            if primary_url in url_to_paragraph:
                # url 相同时，删除短的段落
                existing_idx = url_to_paragraph[primary_url]
                existing_para = paragraphs[existing_idx]
                if len(para) > len(existing_para):
                    to_remove.add(existing_idx)
                    url_to_paragraph[primary_url] = i
                else:
                    to_remove.add(i)
            else:
                url_to_paragraph[primary_url] = i
    deduplicated_paragraphs = []
    for i, para in enumerate(paragraphs):
        if i not in to_remove and para.strip():  # 保留非空段落
            deduplicated_paragraphs.append(para)
    return deduplicated_paragraphs
    return '\n\n'.join(deduplicated_paragraphs)

def _compress_blank_lines_line_by_line(markdown_text):
    lines = markdown_text.split('\n')
    result_lines = []
    previous_line_was_blank = False
    for line in lines:
        if line.strip() == '':
            if not previous_line_was_blank:
                result_lines.append('')
                previous_line_was_blank = True
        else:
            result_lines.append(line.rstrip())  # 移除行尾空白
            previous_line_was_blank = False
    if result_lines and result_lines[-1] == '':
        result_lines.pop()
    return '\n'.join(result_lines)

def _html_to_markdown(content):
    from html_to_markdown import convert, ConversionOptions
    markdown = convert(content)
    markdown = _remove_data_images(markdown)
    markdown = _remove_metas(markdown)
    markdown = _fix_multiline_links(markdown)
    markdown = _remove_empty_links(markdown)
    markdown = _compress_blank_lines_line_by_line(markdown)
    return markdown

def invoke_web_get_content(url: str, return_format: str = "clean_text") -> str:
    """
    获取指定URL的网页内容，优先使用elinks导出干净的文本内容

    Args:
        url: 要获取内容的URL地址
        return_format: 返回内容的格式，'clean_text' 或 'markdown' 或 'html' 或 'links'

    Returns:
        str: 清理后的文本、网页内容或者链接列表的字符串表示
    """
    try:
        # 如果请求clean_text且elinks可用，优先使用elinks
        if return_format == "clean_text" and is_elinks_available():
            return get_content_with_elinks(url)

        # 添加基本的请求头，模拟浏览器访问
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }

        parsed = urlparse(url)
        encoding_from_header = None
        if parsed.scheme in ('http', 'https'):
            response = requests.get(url, headers=headers, timeout=10)
            response.raise_for_status()  # 如果状态码不是200，抛出异常

            raw_content = response.content
            # 优先使用HTTP响应头中的编码
            if 'content-type' in response.headers:
                content_type = response.headers['content-type'].lower()
                charset_match = re.search(r'charset\s*=\s*([^\s;]+)', content_type)
                if charset_match:
                    encoding_from_header = charset_match.group(1).lower()
                    if encoding_from_header == 'gb2312':
                        encoding_from_header = 'gb18030'
        elif parsed.scheme == 'file' or parsed.scheme == '':
            response = urllib.request.urlopen(url)
            #content = response.read().decode('utf-8')
            raw_content = response.read()
        else:
            return f"Unsupported get content from `{url}`"

        # 解码为Unicode字符串
        try:
            if encoding_from_header:
                content = raw_content.decode(encoding_from_header, errors='ignore')
            else:
                # 尝试使用 chardet 来检测
                import chardet
                detected_encoding = chardet.detect(raw_content)['encoding']
                content = raw_content.decode(detected_encoding, errors='ignore')
        except (UnicodeDecodeError, LookupError):
            try:
                content = raw_content.decode('utf-8', errors='ignore')
            except UnicodeDecodeError:
                content = raw_content.decode('latin-1', errors='ignore')

        if return_format == "links":
            links = invoke_parse_links(content)
            if links:
                result = []
                for link in links:
                    caption = link.get('caption', 'No caption')
                    result.append(f"{caption}: {link['url']}")
                return "\n".join(result)
            else:
                return "No links found in the content"
        elif return_format == "clean_text":
            # 返回清理后的纯文本内容
            return extract_clean_text(content)
        elif return_format == "markdown":
            text = _html_to_markdown(content)
            text = _clean_url_labels(text)
            text = _remove_empty_links(text)
            text = _process_url_fragment(text)
            paras = _deduplicate_by_url(text)
            text = '\n\n'.join(paras)
            return text
        else:
            # 返回清理后的HTML内容
            return clean_html_content(content)

    except requests.exceptions.RequestException as e:
        return f"Error fetching content from {url}: {str(e)}"
    except Exception as e:
        return f"Unexpected error: {str(e)}"

def is_elinks_available() -> bool:
    """
    检查系统是否安装了elinks程序
    """
    return shutil.which("elinks") is not None

def get_content_with_elinks(url: str) -> str:
    """
    使用elinks程序获取网页的纯文本内容
    """
    try:
        # 使用elinks以dump模式获取纯文本内容
        # -dump 1: 输出格式化文本后退出
        # -dump-width 120: 输出行按 120 字符换行
        # -no-references: 不显示链接引用编号
        # -no-numbering: 不显示行号
        result = subprocess.run(
            ["elinks", "-dump", "1", "-dump-width", "120", "-no-references", "-no-numbering", url],
            capture_output=True,
            text=True,
            timeout=15,
            check=True
        )

        if result.returncode == 0:
            content = result.stdout.strip()
            # 进一步清理elinks输出的多余空行
            lines = [line.strip() for line in content.split('\n') if line.strip()]
            return '\n'.join(lines)
        else:
            # 如果elinks失败，回退到常规方法
            return get_content_fallback(url)

    except subprocess.TimeoutExpired:
        return f"Error: elinks timeout when fetching {url}"
    except subprocess.CalledProcessError as e:
        return f"Error: elinks failed with return code {e.returncode}"
    except Exception as e:
        return f"Error using elinks: {str(e)}"

def get_content_fallback(url: str) -> str:
    """
    elinks失败时的回退方案
    """
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        parsed = urlparse(url)
        if parsed.scheme in ('http', 'https'):
            response = requests.get(url, headers=headers, timeout=10)
            response.raise_for_status()
            return extract_clean_text(response.text)
        elif parsed.scheme == 'file' or parsed.scheme == '':
            response = urllib.request.urlopen(url)
            content = response.read().decode('utf-8')
            return extract_clean_text(content)
        else:
            return f"Unsupported get content from `{url}`"
    except Exception as e:
        return f"Fallback also failed: {str(e)}"

def preprocess_duckduckgo_html(html_content):
    """预处理DuckDuckGo HTML，移除导航元素"""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html_content, 'html.parser')

    # 移除表单和选择框
    for form in soup.find_all('form'):
        form.decompose()

    # 移除包含区域和时间选择的div
    for div in soup.find_all('div', class_='frm__select'):
        div.decompose()

    # 移除header区域
    header = soup.find('div', id='header')
    if header:
        header.decompose()

    return str(soup)

def process_duckduckgo_markdown(markdown_text):
    """
    简化 duckduckgo 结果 Markdown内容：每节保留标题链接，去除其他重复链接和图标，保留关键描述
    """
    # 分割成不同的部分（每个##开始的部分）
    sections = re.split(r'\n## ', markdown_text)
    simplified_sections = []

    index = 1
    for section in sections:
        if not section.strip():
            continue

        # 提取标题行（第一行）
        lines = section.strip().split('\n')
        if not lines:
            continue

        # 提取标题和链接
        title_match = re.search(r'\[([^\]]+)\]\(([^)]+)\)', lines[0])
        if not title_match:
            # 如果没有链接格式，使用原始标题
            simplified_sections.append("## " + section)
            continue

        title_text = title_match.group(1)
        main_url = title_match.group(2)

        # 构建标题行（保留链接）
        title_line = f"## {index}. [{title_text}]({main_url})"
        index = index + 1

        # 寻找描述性文本
        descriptions = []
        for line in lines[1:]:
            # 跳过图标行
            if re.match(r'^\s*\[<img[^>]+>\].*$', line.strip()):
                continue

            # 提取链接文本（去除链接标记）
            if '](' in line and line.strip().startswith('['):
                link_text_match = re.match(r'^\s*\[([^\]]+)\]\([^)]+\)', line)
                if link_text_match:
                    link_text = link_text_match.group(1)
                    descriptions.append(link_text)
            else:
                # 普通文本行
                descriptions.append(line.strip())

        # 如果有描述文本，添加到结果
        if descriptions:
            # 去重描述文本
            unique_descriptions = []
            seen = set()
            for desc in descriptions:
                if desc not in seen and len(desc) > 10:  # 过滤掉太短的文本
                    seen.add(desc)
                    unique_descriptions.append(desc)

            # 如果找到了描述文本，只保留第一条有意义的描述
            if unique_descriptions:
                # 选择最长的描述文本（通常包含最多信息）
                best_description = max(unique_descriptions, key=len)
                simplified_sections.append(f"{title_line}\n{best_description}")
            else:
                simplified_sections.append(title_line)
        else:
            simplified_sections.append(title_line)

    return "\n\n".join(simplified_sections)

def _google_search_by_uc(query, base_url = "https://www.google.com", timeout=15):
    import undetected_chromedriver as uc

    options = uc.ChromeOptions()
    options.add_argument('--no-sandbox') # 必须，尤其是以 root 或在虚拟机运行时
    #options.add_argument('--disable-dev-shm-usage')

    driver = uc.Chrome(
        #headless=True, # 不要使用无头模型，否则有概率被 google 反爬虫策略阻挡。
        options=options
    )

    content = "Search failed."
    try:
        search_url = f"{base_url.rstrip('/')}/search?q={quote_plus(query)}"
        driver.get(search_url)

        try:
            # 这里我们等待包含 AI 文本的容器出现
            # 搜索结果顶节点: #rcnt
            # 主搜索清单节点: #search
            # 2026年 google AI 概览尾部致谢链接: a[href*="support.google.com/websearch?p=ai_overviews"]
            selector = 'a[href*="support.google.com/websearch?p=ai_overviews"]'
            wait = WebDriverWait(driver, timeout)
            ai_overview = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, selector)))
        except:
            pass

        #search_results_container = driver.find_element(By.ID, "search")
        search_results_container = driver.find_element(By.ID, "rcnt")
        content = search_results_container.get_attribute('innerHTML')

    finally:
        driver.quit() # 关闭浏览器

    return content

def _bing_search_by_uc(query, base_url = "https://cn.bing.com", timeout=15):
    import undetected_chromedriver as uc

    options = uc.ChromeOptions()
    options.add_argument('--no-sandbox') # 必须，尤其是以 root 或在虚拟机运行时
    #options.add_argument('--disable-dev-shm-usage')

    driver = uc.Chrome(
        #headless=True, # 不要使用无头模型，否则有概率被 bing 反爬虫策略阻挡。
        options=options
    )

    content = "Search failed."
    try:
        fields = [
                f'q={quote_plus(query)}', # 搜索关键词
                f'cvid={_SESSION_ID}', # 会话标识符
                f'form=QBLH',          # 请求来源: QBRE(官页), QBLH(导航栏)
                ]
        search_url = f"{base_url.rstrip('/')}/search?{'&'.join(fields)}"
        driver.get(search_url)

        # bing 搜索结果页面 DOM:
        # 结果顶节点: ol#b_results
        # 主搜索节点清单: li.b_algo （多个）
        # 搜索视频节点: li.b_ans.b_vidAns
        # 搜索边栏节点: li.b_ans.b_mop
        # 搜索新闻节点: li.b_ans.b_nwsAns
        # 搜索顶部节点: li.b_ans.b_top (可能有多种类型的内容)

        #time.sleep(3)
        try:
            # 这里我们等待包含 AI 文本的容器出现
            # 2026年 bing AI 概览尾部来源链接:
            #selector = 'li.gs_tkn.gs_cit_stry_item'
            selector = 'div#gs_main'
            wait = WebDriverWait(driver, timeout)
            wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, selector)))
        except:
            pass

        #res_top = driver.find_element(By.ID, "b_results")
        #content = res_top.get_attribute('innerHTML')
        res_ai = driver.find_element(By.CSS_SELECTOR, 'div#gs_main')
        res_list = driver.find_elements(By.CSS_SELECTOR, 'li.b_algo')
        res_news = driver.find_elements(By.CSS_SELECTOR, 'li.b_ans.b_nwsAns')
        htmls = [ res_ai.get_attribute('innerHTML') ]
        for elt in res_list:
            htmls.append(elt.get_attribute('innerHTML'))
        for elt in res_news:
            htmls.append(elt.get_attribute('innerHTML'))
        content = ''.join(htmls)

    finally:
        driver.quit() # 关闭浏览器

    return content

def process_google_markdown(markdown_text):
    text = _remove_images(markdown_text)
    text = _clean_url_labels(text)
    text = _remove_empty_links(text)
    text = _process_google_url_fragment(text)
    text = _process_url_fragment(text)
    paras = _deduplicate_by_url(text)
    text = '\n\n'.join(paras)
    return text

def process_bing_markdown(markdown_text):
    text = _remove_images(markdown_text)
    text = _clean_url_labels(text)
    text = _remove_empty_links(text)
    text = _process_url_fragment(text)
    paras = _deduplicate_by_url(text)
    paras_new = [ p for p in paras if 'Translate this result' not in p ]
    text = '\n\n'.join(paras_new)
    return text

def invoke_web_search(request: str, engine: str = "auto", base_url: str = _DEFAULT_SEARCH_ENGINE, max_results: int = 10, return_format: str = "markdown") -> str:
    """
    执行网络搜索

    Args:
        request: 搜索关键词或查询内容
        engine: 搜索引擎名称，可选值：'duckduckgo', 'bing', 'google', 'auto'。如果未指定，则使用base_url或默认配置
        base_url: 搜索引擎的基础URL（可选，如果指定engine且不为'auto'则忽略此参数）
        max_results: 最大返回结果数量
        return_format: 返回内容的格式，'html' 或 'markdown' 或 'links'

    Returns:
        str: 搜索结果或错误消息
    """
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        }

        # 确定使用哪个搜索引擎
        selected_base_url = base_url
        selected_engine_name = None
        
        if engine and engine != "auto":
            # 使用指定的引擎
            manager = get_search_engine_manager()
            engine_config = manager.get_engine_by_name(engine)
            if engine_config and engine_config.get('enabled', True):
                selected_base_url = engine_config.get('url', base_url)
                selected_engine_name = engine
            else:
                # 引擎不可用，回退到base_url
                print(f"Engine '{engine}' not found or disabled, using base_url", file=sys.stderr)
        elif engine == "auto":
            # 使用引擎管理器自动选择
            manager = get_search_engine_manager()
            engine_config = manager.get_next_engine()
            if engine_config:
                selected_base_url = engine_config.get('url', base_url)
                selected_engine_name = engine_config.get('name', '')
        
        # 记录调用
        if selected_engine_name:
            manager.record_call(selected_engine_name)

        #1. DuckDuckGo：使用 POST 请求，参数在 `data` 中
        #2. Bing：使用 GET 请求，URL 格式为 `/search?q=关键词&form=QBLH`
        #3. Google：使用 GET 请求，URL 格式为 `/search?q=关键词&hl=en&gl=us`
        #4. 百度：使用 GET 请求，URL 格式为 `/s?wd=关键词&ie=utf-8`

        if "duckduckgo.com" in selected_base_url:
            params = {
                'q': request,
                'kl': 'us-en'
            }
            response = requests.post(selected_base_url, data=params, headers=headers, timeout=15)
        elif "bing.com" in selected_base_url or "cn.bing.com" in selected_base_url:
            #search_url = f"{selected_base_url.rstrip('/')}/search"
            #params = {
            #    'q': request,    # 搜索关键词
            #    'cvid': _SESSION_ID,    # 会话标识符
            #    'responseFilter': '-images,-videos', # 过滤掉图片、视频等
            #    'qs': 'n',              # 搜索建议 normal
            #    'sp': '-1',             # 没有使用搜索建议
            #    'lq': '0',              # 是否按字面意思做精确匹配
            #    'form': 'QBRE'          # 请求来源: QBRE(官页), QBLH(导航栏)
            #                            # 这里应该使用 QBRE 而不是 QBLH，因为 requests 会按表单格式
            #                            # 编码搜索关键词，这时 bing 应该按官页的表单提交方式来理解，
            #                            # 否则，当遇到多关键词时，会得到错误的搜索结果。
            #}
            #response = requests.get(search_url, params=params, headers=headers, timeout=15)
            content = _bing_search_by_uc(request, selected_base_url, timeout=10)
            response = None
        elif "google.com" in selected_base_url:
            content = _google_search_by_uc(request, selected_base_url, timeout=10)
            response = None
        elif "baidu.com" in selected_base_url:
            search_url = f"{selected_base_url.rstrip('/')}/s"
            params = {
                'wd': request,    # 百度使用 wd 参数
                'ie': 'utf-8'     # 编码设置
            }
            response = requests.get(search_url, params=params, headers=headers, timeout=15)
        else:
            search_url = selected_base_url
            params = {
                'q': request
            }
            response = requests.get(search_url, params=params, headers=headers, timeout=15)

        if response:
            response.raise_for_status()
            content = preprocess_duckduckgo_html(response.text)

        # 报告成功
        if selected_engine_name:
            manager.report_success(selected_engine_name)

        if return_format == "markdown":
            markdown_content = _html_to_markdown(content)
            if "duckduckgo.com" in selected_base_url:
                return process_duckduckgo_markdown(markdown_content)
            elif "bing.com" in selected_base_url:
                return process_bing_markdown(markdown_content)
            elif "google" in selected_base_url:
                return process_google_markdown(markdown_content)
            return markdown_content
        elif return_format == "links":
            # 直接返回解析后的链接
            links = invoke_parse_links(content)

            # 过滤和格式化结果
            results = []
            for link in links[:max_results]:
                if link.get('url') and not link['url'].startswith('javascript:'):
                    caption = link.get('caption', 'No caption')
                    results.append(f"{caption}: {link['url']}")

            if results:
                return f"Search results for '{request}':\n" + "\n".join(results)
            else:
                return f"No search results found for '{request}'"
        else:
            # 返回原始HTML内容
            return content

    except requests.exceptions.RequestException as e:
        # 报告错误
        if selected_engine_name:
            manager.report_error(selected_engine_name)
        
        # 检查是否应该重试
        manager = get_search_engine_manager()
        if manager.rotation_config.get('fallback_on_error', True):
            # 尝试使用其他引擎
            if selected_engine_name:
                # 排除当前失败的引擎
                fallback_engine = manager._select_engine_by_strategy(
                    manager.rotation_config.get('strategy', 'frequency_based'),
                    exclude_engine=selected_engine_name
                )
                if fallback_engine:
                    fallback_url = fallback_engine.get('url', '')
                    if fallback_url:
                        print(f"Retrying with fallback engine: {fallback_engine.get('name', '')}", file=sys.stderr)
                        # 递归调用，但避免无限递归
                        return invoke_web_search(request, fallback_engine.get('name', ''), '', max_results, return_format)
        
        return f"Search error: {str(e)}"
    except Exception as e:
        if selected_engine_name:
            manager.report_error(selected_engine_name)
        return f"Unexpected search error: {str(e)}"

def invoke_web_parse_links(content: str) -> List[Dict[str, str]]:
    """
    解析HTML内容中的URL链接

    Args:
        content: 要解析的HTML内容

    Returns:
        List[Dict]: 包含URL和可选标题的链接列表
    """
    links = []

    try:
        # 使用正则表达式匹配 <a> 标签
        # 匹配模式：<a href="URL"[^>]*>CAPTION</a>
        pattern = r'<a\s+[^>]*href=["\']([^"\']*)["\'][^>]*>([^<]*)</a>'
        matches = re.findall(pattern, content, re.IGNORECASE)

        for url, caption in matches:
            # 清理标题文本
            caption = re.sub(r'\s+', ' ', caption.strip())

            # 过滤掉空链接和常见的不需要的链接
            if url and not url.startswith('#') and len(caption) > 0:
                links.append({
                    'url': url,
                    'caption': caption
                })

        # 如果没有找到链接，尝试更宽松的匹配
        if not links:
            # 匹配所有 href 属性
            href_pattern = r'href=["\']([^"\'\s>]*)["\']'
            href_matches = re.findall(href_pattern, content, re.IGNORECASE)

            for url in href_matches:
                if url and not url.startswith('#') and not url.startswith('javascript:'):
                    links.append({
                        'url': url,
                        'caption': 'Link'
                    })

    except Exception as e:
        # 如果解析出错，返回空列表
        print(f"Link parsing error: {e}")

    return links

def clean_html_content(html_content: str) -> str:
    """
    清理HTML内容，移除script、style等标签，保留主要内容
    """
    try:
        from bs4 import BeautifulSoup, Comment

        soup = BeautifulSoup(html_content, 'html.parser')

        # 移除script标签
        for script in soup.find_all('script'):
            script.decompose()

        # 移除style标签
        for style in soup.find_all('style'):
            style.decompose()

        # 移除注释
        for comment in soup.find_all(string=lambda text: isinstance(text, Comment)):
            comment.extract()

        # 移除meta、link等元数据标签
        for meta in soup.find_all('meta'):
            meta.decompose()
        for link in soup.find_all('link'):
            link.decompose()

        # 移除noscript标签
        for noscript in soup.find_all('noscript'):
            noscript.decompose()

        # 返回清理后的HTML
        return str(soup)

    except ImportError:
        # 如果没有安装BeautifulSoup，使用简单的正则方法
        import re
        # 移除script标签
        html_content = re.sub(r'<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>', '', html_content, flags=re.IGNORECASE)
        # 移除style标签
        html_content = re.sub(r'<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>', '', html_content, flags=re.IGNORECASE)
        # 移除注释
        html_content = re.sub(r'<!--.*?-->', '', html_content, flags=re.DOTALL)
        return html_content

def extract_clean_text(html_content: str) -> str:
    """
    从HTML中提取干净的文本内容
    """
    try:
        from bs4 import BeautifulSoup, Comment

        soup = BeautifulSoup(html_content, 'html.parser')

        # 移除不需要的标签
        for element in soup(['script', 'style', 'meta', 'link', 'noscript']):
            element.decompose()

        # 移除注释
        for comment in soup.find_all(string=lambda text: isinstance(text, Comment)):
            comment.extract()

        # 获取文本并清理空白字符
        text = soup.get_text()

        # 清理多余的空白字符
        lines = (line.strip() for line in text.splitlines())
        chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
        text = ' '.join(chunk for chunk in chunks if chunk)

        return text

    except ImportError:
        # 如果没有BeautifulSoup，返回清理后的HTML
        clean_html = clean_html_content(html_content)
        # 简单的文本提取
        import re
        text = re.sub(r'<[^>]+>', ' ', clean_html)  # 移除所有标签
        text = re.sub(r'\s+', ' ', text)  # 合并多个空白字符
        return text.strip()

def invoke_web_download_file(
    url: str,
    output_path: Optional[str] = None,
    output_dir: Optional[str] = None,
    filename: Optional[str] = None,
    timeout: int = 60
) -> Dict[str, Any]:
    """
    从URL下载文件

    Args:
        url: 要下载文件的URL地址
        output_path: 完整的输出文件路径（包含文件名）
        output_dir: 输出目录（如果output_path未指定，则在此目录下生成文件）
        filename: 文件名（如果output_path未指定，则使用此文件名）
        timeout: 下载超时时间（秒）

    Returns:
        Dict: 包含下载结果的信息
    """
    try:
        file_path = _get_download_output_path(url, output_path, output_dir, filename)
        file_path.parent.mkdir(parents=True, exist_ok=True)
        downloaded_path = download_file_robust(url, file_path, timeout)

        if downloaded_path:
            return {
                "success": True,
                "message": f"文件下载成功",
                "file_path": str(downloaded_path),
                "url": url,
                "file_size": downloaded_path.stat().st_size if downloaded_path.exists() else 0
            }
        else:
            return {
                "success": False,
                "error": f"所有下载方法都失败了: {url}",
                "url": url
            }

    except Exception as e:
        return {
            "success": False,
            "error": f"下载文件时发生错误: {str(e)}",
            "url": url
        }


def download_file_robust(
    url: str,
    output_path: Path,
    timeout: int,
    headers: Dict[str, str] = {}
) -> Optional[Path]:
    file_path = _download_with_requests(url, output_path, timeout)
    if file_path:
        return file_path

    file_path = _download_with_wget(url, output_path, timeout)
    if file_path:
        return file_path

    file_path = _download_with_curl(url, output_path, timeout)
    if file_path:
        return file_path

    print(f"所有下载方法都失败了: {url}")
    return None


def _download_with_requests(
    url: str,
    output_path: Path,
    timeout: int,
    headers: Dict[str, str] = {}
) -> Optional[Path]:
    try:
        # 尝试不同的请求头组合
        headers_combinations = [
            {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            },
            {
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                "Accept": "*/*",
                "Accept-Language": "en-US,en;q=0.9"
            },
            {}  # 空请求头
        ]
        if headers:
            headers_combinations.insert(0, headers)

        for headers_try in headers_combinations:
            try:
                response = requests.get(url, headers=headers_try, timeout=timeout, stream=True)
                response.raise_for_status()

                with open(output_path, "wb") as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)

                print(f"使用requests下载成功: {output_path}")
                return output_path

            except requests.exceptions.HTTPError as e:
                if e.response.status_code == 403:
                    continue  # 尝试下一个请求头组合
                else:
                    raise

        return None

    except Exception as e:
        print(f"requests下载失败: {str(e)}")
        return None


def _download_with_wget(
    url: str,
    output_path: Path,
    timeout: int
) -> Optional[Path]:
    if not shutil.which("wget"):
        return None

    try:
        cmd = [
            "wget",
            "-O", str(output_path),
            "-T", str(timeout),  # 超时时间
            url
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)

        if result.returncode == 0:
            print(f"使用wget下载成功: {output_path}")
            return output_path
        else:
            print(f"wget下载失败: {result.stderr}")
            return None

    except Exception as e:
        print(f"wget下载失败: {str(e)}")
        return None


def _download_with_curl(
    url: str,
    output_path: Path,
    timeout: int
) -> Optional[Path]:
    if not shutil.which("curl"):
        return None

    try:
        cmd = [
            "curl",
            "-L",  # 跟随重定向
            "-o", str(output_path),
            "--connect-timeout", str(timeout),
            "--max-time", str(timeout),
            url
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)

        if result.returncode == 0:
            print(f"使用curl下载成功: {output_path}")
            return output_path
        else:
            print(f"curl下载失败: {result.stderr}")
            return None

    except Exception as e:
        print(f"curl下载失败: {str(e)}")
        return None


def _get_download_output_path(
    url: str,
    output_path: Optional[str],
    output_dir: Optional[str],
    filename: Optional[str]
) -> Path:
    """获取下载文件的输出路径"""
    if output_path:
        return sanitize_path(output_path)

    # 确定输出目录
    if output_dir:
        output_dir_path = sanitize_path(output_dir)
    else:
        output_dir_path = sanitize_path() / "downloads"

    # 确定文件名
    if filename:
        file_name = filename
    else:
        # 从URL中提取文件名，或使用时间戳
        parsed_url = urlparse(url)
        url_filename = Path(parsed_url.path).name
        if url_filename and url_filename != "/":
            file_name = url_filename
        else:
            timestamp = int(time.time())
            file_name = f"downloaded_file_{timestamp}"

    return output_dir_path / file_name

if __name__ == "__main__":
    #content = _google_search("格林兰岛 压力")
    #content = _google_search_by_uc("AI LLM 新进展")
    content = invoke_web_search("格林兰 局势 新进展", engine='bing')
    text = _html_to_markdown(content)
    text = _remove_images(text)
    text = _remove_empty_links(text)
    text = _process_url_fragment(text)
    with open('/tmp/bing.md', 'w', encoding='utf-8') as f:
        print(f'{text}', file=f)

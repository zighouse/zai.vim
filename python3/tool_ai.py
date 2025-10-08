#!/usr/bin/env python3
"""
图片生成AI功能模块
支持多种AI图片生成服务，包括SiliconFlow、OpenAI DALL-E等
"""
import os
import sys
import json
import requests
import base64
import time
import subprocess
import shutil
from pathlib import Path
from typing import Optional, Dict, Any
from urllib.parse import urlparse
from toolcommon import sanitize_path
from tool_web import download_file_robust


def generate_image(
    prompt: str,
    base_url: str = "https://api.siliconflow.cn/v1/images/generations",
    model: str = "Qwen/Qwen-Image",
    api_key_name: str = "SILICONFLOW_API_KEY",
    output_path: Optional[str] = None,
    output_dir: Optional[str] = None,
    size: str = "1024x1024",
    quality: str = "standard",
    n: int = 1,
    timeout: int = 60
) -> Dict[str, Any]:
    """
    使用AI生成图片

    Args:
        base_url: API服务地址
        model: 模型名称
        api_key_name: 环境变量中的API密钥名称
        prompt: 图片生成提示词
        output_path: 输出图片文件路径
        output_dir: 输出目录（如果output_path未指定，则在此目录下生成图片）
        size: 图片尺寸，如 "1024x1024", "512x512"
        quality: 图片质量，如 "standard", "hd"
        n: 生成图片数量
        timeout: 请求超时时间（秒）

    Returns:
        Dict: 包含生成结果的信息
    """

    # 获取API密钥
    api_key = os.getenv(api_key_name)
    if not api_key:
        return {
            "success": False,
            "error": f"API密钥未找到，请设置环境变量: {api_key_name}"
        }

    # 准备请求头
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }

    # 准备请求数据
    request_data = {
        "model": model,
        "prompt": prompt,
        "n": n,
        "size": size,
        "quality": quality
    }

    # 根据不同的API服务调整请求格式
    if "siliconflow" in base_url.lower():
        # SiliconFlow API格式
        request_data = {
            "model": model,
            "prompt": prompt,
            "n": n,
            "size": size,
            "response_format": "url"  # SiliconFlow支持url格式
        }
    elif "openai" in base_url.lower() or "api.openai.com" in base_url:
        # OpenAI DALL-E API格式
        request_data = {
            "model": model,
            "prompt": prompt,
            "n": n,
            "size": size,
            "quality": quality
        }

    try:
        # 发送请求
        response = requests.post(
            base_url,
            headers=headers,
            json=request_data,
            timeout=timeout
        )

        if response.status_code != 200:
            return {
                "success": False,
                "error": f"API请求失败: {response.status_code} - {response.text}"
            }

        result = response.json()

        # 处理不同的API响应格式
        image_urls = []
        if "data" in result:
            # OpenAI格式
            for item in result["data"]:
                if "url" in item:
                    image_urls.append(item["url"])
                elif "b64_json" in item:
                    # 处理base64编码的图片
                    image_urls.append(f"data:image/png;base64,{item['b64_json']}")
        elif "images" in result:
            # SiliconFlow格式
            image_urls = result["images"]
        else:
            # 其他格式，尝试直接获取URL
            if isinstance(result, list) and len(result) > 0:
                image_urls = result
            else:
                return {
                    "success": False,
                    "error": f"无法解析API响应: {result}"
                }

        # 下载图片
        saved_files = []
        for i, image_url in enumerate(image_urls):
            if image_url.startswith("data:"):
                # 处理base64编码的图片
                file_path = _save_base64_image(
                    image_url,
                    output_path,
                    output_dir,
                    i
                )
            else:
                # 处理URL图片
                file_path = download_file_robust(
                    image_url,
                    _get_output_path(output_path, output_dir, i),
                    timeout,
                    headers
                )

            if file_path:
                saved_files.append(str(file_path))

        return {
            "success": True,
            "message": f"成功生成 {len(saved_files)} 张图片",
            "files": saved_files,
            "prompt": prompt,
            "model": model
        }

    except requests.exceptions.Timeout:
        return {
            "success": False,
            "error": f"请求超时 ({timeout}秒)"
        }
    except requests.exceptions.RequestException as e:
        return {
            "success": False,
            "error": f"网络请求错误: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"生成图片时发生错误: {str(e)}"
        }


def _save_base64_image(
    base64_data: str,
    output_path: Optional[str],
    output_dir: Optional[str],
    index: int
) -> Optional[Path]:
    """保存base64编码的图片"""
    try:
        # 提取base64数据
        if "," in base64_data:
            base64_data = base64_data.split(",")[1]

        # 解码图片数据
        image_data = base64.b64decode(base64_data)

        # 确定输出路径
        file_path = _get_output_path(output_path, output_dir, index)

        # 确保目录存在
        file_path.parent.mkdir(parents=True, exist_ok=True)

        # 保存图片
        with open(file_path, "wb") as f:
            f.write(image_data)

        print(f"图片已保存: {file_path}")
        return file_path

    except Exception as e:
        print(f"保存base64图片失败: {str(e)}")
        return None


def _get_output_path(
    output_path: Optional[str],
    output_dir: Optional[str],
    index: int
) -> Path:
    """获取输出文件路径"""
    if output_path:
        if index == 0:
            return sanitize_path(output_path)
        else:
            path = sanitize_path(output_path)
            return path.parent / f"{path.stem}_{index}{path.suffix}"

    if output_dir:
        output_dir = sanitize_path(output_dir)
    else:
        output_dir = sanitize_path() / "generated_images"

    timestamp = int(time.time())
    filename = f"generated_image_{timestamp}_{index}.png"

    return output_dir / filename


def main():
    """命令行接口"""
    import argparse

    parser = argparse.ArgumentParser(description="AI图片生成工具")
    parser.add_argument("--base_url", required=True, help="API服务地址")
    parser.add_argument("--model", required=True, help="模型名称")
    parser.add_argument("--api_key_name", required=True, help="API密钥环境变量名")
    parser.add_argument("--prompt", required=True, help="图片生成提示词")
    parser.add_argument("--output_path", help="输出图片文件路径")
    parser.add_argument("--output_dir", help="输出目录")
    parser.add_argument("--size", default="1024x1024", help="图片尺寸")
    parser.add_argument("--quality", default="standard", help="图片质量")
    parser.add_argument("--n", type=int, default=1, help="生成图片数量")

    args = parser.parse_args()

    result = generate_image(
        base_url=args.base_url,
        model=args.model,
        api_key_name=args.api_key_name,
        prompt=args.prompt,
        output_path=args.output_path,
        output_dir=args.output_dir,
        size=args.size,
        quality=args.quality,
        n=args.n
    )

    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()


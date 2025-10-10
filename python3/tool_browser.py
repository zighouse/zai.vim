#!/usr/bin/env python3
import subprocess
import shutil
import time
import os
from pathlib import Path
from typing import Optional, Dict, Any
import tempfile

def invoke_open_browser(url: str, browser: str = "auto", headless: bool = False, timeout: int = 30) -> str:
    """
    打开浏览器并访问指定URL
    
    Args:
        url: 要访问的URL地址
        browser: 浏览器类型，'firefox' 或 'chrome'，默认自动选择
        headless: 是否使用无头模式（不显示浏览器界面）
        timeout: 页面加载超时时间（秒）
        
    Returns:
        str: 操作结果信息
    """
    try:
        # 确定要使用的浏览器
        browser_cmd = _get_browser_command(browser)
        if not browser_cmd:
            return "错误：未找到可用的浏览器。请确保系统已安装 Firefox 或 Chrome。"
        
        # 构建命令
        if headless:
            # 无头模式 - 使用Python的selenium库
            return _open_browser_headless(url, browser, timeout)
        else:
            # 图形界面模式 - 使用系统命令
            cmd = [browser_cmd, url]
            
            try:
                # 启动浏览器
                process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                
                # 等待一段时间让浏览器启动
                time.sleep(3)
                
                # 检查进程是否还在运行
                if process.poll() is None:
                    return f"成功打开 {browser_cmd} 浏览器访问: {url}"
                else:
                    stdout, stderr = process.communicate(timeout=5)
                    return f"浏览器启动失败: {stderr.decode('utf-8', errors='ignore')}"
                    
            except subprocess.TimeoutExpired:
                process.kill()
                return "浏览器启动超时"
            except Exception as e:
                return f"启动浏览器时发生错误: {str(e)}"
                
    except Exception as e:
        return f"打开浏览器失败: {str(e)}"

def invoke_get_page_content(url: str, wait_time: int = 5, extract_text: bool = True, browser: str = "auto") -> str:
    """
    使用浏览器获取网页内容，包括动态加载的内容
    
    Args:
        url: 要获取内容的URL地址
        wait_time: 等待页面加载完成的时间（秒）
        extract_text: 是否提取纯文本内容
        browser: 浏览器类型
        
    Returns:
        str: 网页内容或错误信息
    """
    try:
        # 检查是否安装了selenium
        try:
            from selenium import webdriver
            from selenium.webdriver.common.by import By
            from selenium.webdriver.support.ui import WebDriverWait
            from selenium.webdriver.support import expected_conditions as EC
            from selenium.common.exceptions import TimeoutException, WebDriverException
        except ImportError:
            return "错误：未安装selenium。请先运行 'pip install selenium' 安装。"
        
        # 设置浏览器驱动
        driver = None
        try:
            # 确定浏览器类型
            browser_type = _determine_browser_type(browser)
            
            # 创建浏览器选项
            options = _create_browser_options(browser_type)
            
            # 创建驱动
            if browser_type == "firefox":
                driver = webdriver.Firefox(options=options)
            elif browser_type == "chrome":
                driver = webdriver.Chrome(options=options)
            else:
                # 尝试自动选择
                try:
                    driver = webdriver.Chrome(options=options)
                except:
                    try:
                        driver = webdriver.Firefox(options=options)
                    except:
                        return "错误：无法启动任何浏览器驱动。请确保已安装Chrome或Firefox浏览器驱动。"
            
            # 访问URL
            driver.get(url)
            
            # 等待页面加载
            WebDriverWait(driver, wait_time).until(
                EC.presence_of_element_located((By.TAG_NAME, "body"))
            )
            
            # 获取页面内容
            if extract_text:
                # 获取纯文本内容
                content = driver.find_element(By.TAG_NAME, "body").text
                # 清理文本
                lines = [line.strip() for line in content.split('\n') if line.strip()]
                content = '\n'.join(lines)
            else:
                # 获取HTML源码
                content = driver.page_source
            
            return f"成功获取页面内容 (长度: {len(content)}):\n\n{content}"
            
        except TimeoutException:
            return f"错误：页面加载超时 ({wait_time}秒)"
        except WebDriverException as e:
            return f"浏览器驱动错误: {str(e)}"
        except Exception as e:
            return f"获取页面内容时发生错误: {str(e)}"
        finally:
            if driver:
                driver.quit()
                
    except Exception as e:
        return f"获取页面内容失败: {str(e)}"

def invoke_screenshot(url: str, output_path: Optional[str] = None, browser: str = "auto", full_page: bool = False) -> str:
    """
    对网页进行截图
    
    Args:
        url: 要截图的URL地址
        output_path: 截图保存路径
        browser: 浏览器类型
        full_page: 是否截取完整页面
        
    Returns:
        str: 操作结果信息
    """
    try:
        # 检查是否安装了selenium
        try:
            from selenium import webdriver
            from selenium.webdriver.common.by import By
            from selenium.webdriver.support.ui import WebDriverWait
            from selenium.webdriver.support import expected_conditions as EC
        except ImportError:
            return "错误：未安装selenium。请先运行 'pip install selenium' 安装。"
        
        # 设置输出路径
        if not output_path:
            # 生成默认文件名
            timestamp = int(time.time())
            domain = url.split('//')[-1].split('/')[0].replace('.', '_')
            output_path = f"screenshot_{domain}_{timestamp}.png"
        
        output_path = Path(output_path).resolve()
        
        driver = None
        try:
            # 确定浏览器类型
            browser_type = _determine_browser_type(browser)
            
            # 创建浏览器选项
            options = _create_browser_options(browser_type)
            
            # 创建驱动
            if browser_type == "firefox":
                driver = webdriver.Firefox(options=options)
            elif browser_type == "chrome":
                driver = webdriver.Chrome(options=options)
            else:
                # 尝试自动选择
                try:
                    driver = webdriver.Chrome(options=options)
                except:
                    try:
                        driver = webdriver.Firefox(options=options)
                    except:
                        return "错误：无法启动任何浏览器驱动。"
            
            # 访问URL
            driver.get(url)
            
            # 等待页面加载
            WebDriverWait(driver, 10).until(
                EC.presence_of_element_located((By.TAG_NAME, "body"))
            )
            
            # 截图
            if full_page:
                # 截取完整页面
                if browser_type == "firefox":
                    # Firefox完整页面截图
                    driver.find_element(By.TAG_NAME, "body").screenshot(str(output_path))
                else:
                    # Chrome完整页面截图
                    total_height = driver.execute_script("return document.body.scrollHeight")
                    driver.set_window_size(1920, total_height)
                    driver.save_screenshot(str(output_path))
            else:
                # 截取当前视口
                driver.save_screenshot(str(output_path))
            
            return f"截图成功保存到: {output_path}"
            
        except Exception as e:
            return f"截图失败: {str(e)}"
        finally:
            if driver:
                driver.quit()
                
    except Exception as e:
        return f"截图操作失败: {str(e)}"

def _get_browser_command(browser: str) -> Optional[str]:
    """获取浏览器命令行"""
    browsers = {
        "firefox": ["firefox", "mozilla-firefox"],
        "chrome": ["google-chrome", "chrome", "chromium-browser", "chromium"]
    }
    
    if browser == "auto":
        # 尝试所有浏览器
        for browser_list in browsers.values():
            for cmd in browser_list:
                if shutil.which(cmd):
                    return cmd
    else:
        # 指定浏览器
        for cmd in browsers.get(browser, []):
            if shutil.which(cmd):
                return cmd
    
    return None

def _determine_browser_type(browser: str) -> str:
    """确定浏览器类型"""
    if browser in ["firefox", "chrome"]:
        return browser
    
    # 自动选择：优先Chrome，其次Firefox
    if _get_browser_command("chrome"):
        return "chrome"
    elif _get_browser_command("firefox"):
        return "firefox"
    else:
        return "auto"

def _create_browser_options(browser_type: str):
    """创建浏览器选项"""
    try:
        if browser_type == "firefox":
            from selenium.webdriver.firefox.options import Options
            options = Options()
            options.add_argument("--headless")  # 无头模式
            options.add_argument("--no-sandbox")
            options.add_argument("--disable-dev-shm-usage")
        elif browser_type == "chrome":
            from selenium.webdriver.chrome.options import Options
            options = Options()
            options.add_argument("--headless")  # 无头模式
            options.add_argument("--no-sandbox")
            options.add_argument("--disable-dev-shm-usage")
            options.add_argument("--disable-gpu")
            options.add_argument("--window-size=1920,1080")
        else:
            return None
        
        return options
    except:
        return None

def _open_browser_headless(url: str, browser: str, timeout: int) -> str:
    """使用无头模式打开浏览器"""
    try:
        from selenium import webdriver
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
    except ImportError:
        return "错误：未安装selenium。请先运行 'pip install selenium' 安装。"
    
    driver = None
    try:
        # 确定浏览器类型
        browser_type = _determine_browser_type(browser)
        
        # 创建浏览器选项
        options = _create_browser_options(browser_type)
        
        # 创建驱动
        if browser_type == "firefox":
            driver = webdriver.Firefox(options=options)
        elif browser_type == "chrome":
            driver = webdriver.Chrome(options=options)
        else:
            return "错误：无法确定浏览器类型"
        
        # 访问URL
        driver.get(url)
        
        # 等待页面加载
        WebDriverWait(driver, timeout).until(
            EC.presence_of_element_located((By.TAG_NAME, "body"))
        )
        
        # 获取页面标题
        title = driver.title
        
        driver.quit()
        
        return f"无头模式成功访问: {url}\n页面标题: {title}"
        
    except Exception as e:
        if driver:
            driver.quit()
        return f"无头模式访问失败: {str(e)}"

# 测试代码（如果直接运行）
if __name__ == "__main__":
    print("Testing browser tools...")
    
    # 测试获取页面内容
    print("\nTesting get_page_content...")
    result = invoke_get_page_content("https://httpbin.org/html", wait_time=5)
    print(f"Result: {result[:200]}..." if len(result) > 200 else f"Result: {result}")
    
    # 测试截图
    print("\nTesting screenshot...")
    result = invoke_screenshot("https://httpbin.org/html", "test_screenshot.png")
    print(f"Result: {result}")
    
    # 测试打开浏览器
    print("\nTesting open_browser...")
    result = invoke_open_browser("https://httpbin.org/html", headless=True)
    print(f"Result: {result}")


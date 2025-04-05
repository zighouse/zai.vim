#!/usr/bin/env python3
import sys
import subprocess

def check_and_install():
    try:
        import openai
    except ImportError:
        print("Installing dependent libraries...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "appdirs"])
        subprocess.check_call([sys.executable, "-m", "pip", "install", "chardet"])
        subprocess.check_call([sys.executable, "-m", "pip", "install", "openai"])
        print("dependent libraries installed successfully")

if __name__ == "__main__":
    check_and_install()

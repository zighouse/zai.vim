#!/usr/bin/env python3
import sys
import subprocess

def check_and_install():
    try:
        import openai
    except ImportError:
        print("Installing OpenAI library...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "openai"])
        print("OpenAI library installed successfully")

if __name__ == "__main__":
    check_and_install()

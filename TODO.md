| 快捷键          | 命令          | 描述                          | 模式          |
|-----------------|---------------|-------------------------------|---------------|
| `<Leader>zo`    | `:Zai`        | 打开Zai交互界面               | 普通模式      |
| `<Leader>zg`    | `:ZaiGo`      | 发送当前输入到DeepSeek        | 插入模式      |
| `<Leader>zX`    | `:ZaiClose`   | 关闭当前Zai会话               | 普通模式      |
| `<Leader>za`    | `:ZaiAdd`     | 添加可视化选区到输入区        | 可视模式      |
| `<Leader>zl`    | `:ZaiLog`     | 打开最近会话日志              | 普通模式      |

四、发布与推广
    GitHub 优化
        添加 Topics: vim, neovim, vim-plugin
        开启 GitHub Discussions 收集反馈
    插件市场发布
        Vim Awesome 提交
        在 Neovim 社区论坛分享
    技术社区推广
        Reddit: r/vim, r/neovim
        中文社区：Vim 中文社区、知乎专栏
五、持续维护
    Issue 管理
        使用模板（.github/ISSUE_TEMPLATE）
        快速响应问题（48小时内）
    自动化测试
    bash
    复制
    # 示例测试目录结构
    test/
    ├── functional/
    │   └── your-plugin_spec.vim  # Vader 测试框架
    └── README.md
        配置 GitHub Actions 自动化测试
    更新日志
        维护 CHANGELOG.md 记录重要变更
六、高级技巧
    支持包管理器
        添加对 vim-plug/dein 的安装说明
        提供 Lua 配置示例（Neovim 用户）
    CI/CD 集成
    yaml
    复制
    # .github/workflows/test.yml 示例
    name: Test
    on: [push, pull_request]
    jobs:
      test:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v3
          - uses: screendriver/vim-test-action@v2
    文档国际化
        提供中英双语文档（可放 docs/ 目录）
        使用 GitHub Pages 托管文档
七、推荐工具链
    文档生成: vimdoc (生成帮助文档)
    测试框架: Vader.vim
    持续集成: GitHub Actions + Docker
    代码检查: ALE 或 coc.nvim 集成 LSP
通过以上步骤，你的插件将更容易被 Vim 社区接受和使用。记得保持积极的维护态度，及时处理用户反馈！


import requests

url = "https://api.siliconflow.cn/v1/chat/completions"

payload = {
    "model": "Qwen/QwQ-32B",
    "messages": [
        {
            "role": "user",
            "content": "What opportunities and challenges will the Chinese large model industry face in 2025?"
        }
    ],
    "stream": False,
    "max_tokens": 512,
    "stop": None,
    "temperature": 0.7,
    "top_p": 0.7,
    "top_k": 50,
    "frequency_penalty": 0.5,
    "n": 1,
    "response_format": {"type": "text"},
    "tools": [
        {
            "type": "function",
            "function": {
                "description": "<string>",
                "name": "<string>",
                "parameters": {},
                "strict": False
            }
        }
    ]
}
headers = {
    "Authorization": "Bearer <token>",
    "Content-Type": "application/json"
}

response = requests.request("POST", url, json=payload, headers=headers)

print(response.text)

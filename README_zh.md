# Zai.Vim DeepSeek AI助手

![插件截图](screenshot.gif)

Zai.Vim 是一款将 AI 助手直接集成到 Vim 编辑器的插件，管理着同时打开的多个 AI 聊天会话，记录日志，也可以加载日志继续曾经的聊天。切换随意，控制随心。

## 功能特性

- **灵活切换模型和提示词**：在一个聊天会话中允许中途变更使用的模型、提示词等
- **附件支持**：允许附加文本文件作为聊天会话交互的上下文
- **多会话支持**：允许同时进行多个聊天会话
- **会话日志**：保存对话历史记录、可以加载日志并继续历史的会话，可以在浏览器中预览
- **语音输入支持**：使用 zasr-server 实现实时语音识别，解放双手进行文本输入

## 安装指南

### 环境要求

- Vim 8.0+ 或 Neovim
- Python 3.6+
- AI API KEY
  - 例如: DeepSeek API 密钥（设置到`DEEPSEEK_API_KEY`环境变量）

- 必需Python包（核心依赖）：
  - `openai` - OpenAI API客户端
  - `requests` - HTTP请求库
  - `appdirs` - 应用目录管理
  - `chardet` - 字符编码检测
  - `PyYAML` - YAML配置文件解析
  - `tiktoken` - OpenAI token计数

- 可选Python包（按需安装）：
  - Web功能: `beautifulsoup4`, `selenium`, `undetected-chromedriver`, `html2text`
  - 文件操作: `python-magic` (文件类型检测)
  - 系统工具: `distro` (Linux发行版检测), `docker` (Docker Python SDK)
  - AI工具: `transformers` (Hugging Face库)
  - 语音输入（ASR）: `websockets`, `pyaudio`
  - 实用工具: `lunarcalendar` (农历日历)

- 系统依赖（Linux推荐）：
  - Docker引擎（用于安全shell执行）：
    ```bash
    # Ubuntu/Debian
    sudo apt install docker.io docker-compose
    sudo usermod -aG docker $USER
    sudo systemctl restart docker
    # 注销并重新登录使docker组生效
    ```
  - Chrome/Chromium浏览器（用于Web搜索）：
    ```bash
    # Ubuntu/Debian
    sudo apt install chromium-browser
    # 或从官网安装Google Chrome
    ```
  - 其他开发工具：
    ```bash
    sudo apt install build-essential python3-dev
    ```
  注意：Windows上Docker和Chrome也可用，但配置较复杂，建议使用Linux。

- 可选Vim插件：
  - iamcco/markdown-preview.nvim (聊天预览)
  - junegunn/fzf.vim (日志搜索)

- 安装方法：
  - 使用 requirements.txt: `pip install -r requirements.txt`
  - 使用安装脚本: `python3 python3/install.py`
  - 仅安装核心依赖: `python3 python3/install.py --skip-core` (如果已安装)
  - 安装完整功能: `python3 python3/install.py --all-optional`
  - 安装系统依赖（Linux）: 见上方系统依赖部分

### 使用插件管理器

使用 vim-plug:
```vim
Plug 'zighouse/zai'
```

使用 Vundle:
```vim
Plugin 'zighouse/zai'
```

使用 lazy.nvim（Neovim配置示例）:
```lua
return {
    {
        "zighouse/zai.vim",
        config = function()
            vim.g.zai_default_model = "deepseek-chat"
        end
    }
}
```

手动安装:

在 Linux/Mac 上的内嵌终端命令窗口上执行的命令：
```bash
mkdir -p ~/.vim/pack/plugins/start
cd ~/.vim/pack/plugins/start
git clone https://github.com/zighouse/zai.vim.git
pip install -r requirements.txt
# 或者使用脚本 install.py
python python3/install.py
```

在 Windows 上的内嵌终端命令窗口上执行的命令：
```dos
md %USERPROFILE%\vimfiles\pack\plugins\start
cd %USERPROFILE%\vimfiles\pack\plugins\start
git clone https://github.com/zighouse/zai.vim.git
pip install -r requirements.txt
# 或者使用脚本 install.py
python python3\install.py
```

进入安装目录下执行 `git pull` 即可手动更新。

也可以下载 zip 包 [Zai.Vim](https://github.com/zighouse/zai.vim/archive/refs/heads/main.zip)，解压后把 zai.vim-main 文件夹放到对应的目录下。

### 语音输入（ASR）设置

要启用语音输入功能，需要设置 zasr-server（一个实时语音识别服务器）：

1. **安装 zasr-server**：

```bash
# 克隆 zasr 仓库
git clone https://github.com/zighouse/zasr.git
cd zasr

# 下载依赖
cd third_party
bash download_deps.sh

# 编译 zasr-server
cd ..
mkdir -p build && cd build
cmake ..
make -j$(nproc)
```

2. **下载 ASR 模型**（SenseVoice 支持多语言）：

```bash
# 模型将下载到 ~/.cache/sherpa-onnx/
# 访问: https://github.com/k2-fsa/sherpa-onnx/releases
# 下载：
#   - silero_vad.int8.onnx
#   - sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17
```

3. **启动 zasr-server**：

```bash
# 使用启动脚本（推荐）
RECOGNIZER_TYPE=sense-voice ./start-server.sh

# 或手动启动
./build/zasr-server \
  --recognizer-type sense-voice \
  --silero-vad-model ~/.cache/sherpa-onnx/silero_vad.int8.onnx \
  --sense-voice-model ~/.cache/sherpa-onnx/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/model.int8.onnx \
  --tokens ~/.cache/sherpa-onnx/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/tokens.txt \
  --port 2026
```

4. **安装 ASR 所需的 Python 依赖**：

```bash
pip install websockets pyaudio
```

**注意**：在 Linux 上，您可能还需要安装 PortAudio 开发头文件：

```bash
sudo apt install portaudio19-dev python3-pyaudio
```

5. **在 Vim 中启用 ASR**：

**方案 1：插件加载时自动启用**（推荐）

添加到您的 `.vimrc` 或 `init.vim`：

```vim
" 插件加载时自动启用 ASR
let g:zai_auto_enable_asr = 1
```

**方案 2：手动启用**

添加到您的 `.vimrc` 或 `init.vim`：

```vim
" 启用 ASR 功能
call zai#asr#setup()
```

或在 Vim 中运行：`:call zai#asr#setup()`

**环境变量**：
- `ZASR_SERVER_URL`：WebSocket 服务器地址（默认：`ws://localhost:2026``）

更多关于 zasr-server 的信息，请访问：https://github.com/zighouse/zasr

## Zai 配置

### 日志目录

`g:zai_log_dir` 配置日志文件保存路径。

默认配置为:
- Linux/Mac: `~/.local/share/zai/log`
- Windows: `%USERPROFILE%\AppData\Local\zai\log`

推荐：在 Windows 上配置新的日志存放路径。Windows 上的默认日志存放路径被系统隐藏，使用不便利。

### 界面语言

`g:zai_lang` 配置 Zai 的界面语言。
默认使用英语，或者按用户环境自行选择。
如果希望指定使用中文，需要配置为：
```vim
let g:zai_lang = 'zh_CN.UTF-8'
```

### API 配置

`g:zai_base_url` 配置 AI 服务的 `base-url`。

`g:zai_api_key_name` 配置 AI 服务的 `api-key-name`。
连接 AI 服务时需要提供服务接口访问密钥。用户需要在操作系统的环境变量中预先设置可以访问到这个密钥的环境变量。这里的 `api-key-name` 就是这个环境变量的名称。

例如: linux 上可在 `~/.bashrc` 中设置环境变量：
```bash
DEEPSEEK_API_KEY=sk-********************************
```

然后就可以使用 `DEEPSEEK_API_KEY` 来完成这项配置。

`g:zai_default_model` 配置 AI 服务的缺省模型。

`g:zai_use_ai`  从 AI 助手配置文件中选一项作为默认配置。这项配置可以用来替换关于 base-url、key 和 model 的配置，不过需要提供一个 AI 助手配置文件。

如果拥有多个模型，又或者拥有多个 AI 聊天服务可以接入，提供 AI 助手配置文件就可以快速切换。AI 助手配置文件的全路径：

* Linux/Mac: ~/.local/share/zai/assistants.yaml
* Windows: %USERPROFILE%\AppData\Local\Zai\assistants.yaml

一个例子：
```yaml
- name: deepseek                        # AI助理标识/服务商 (自定义)
  base-url: https://api.deepseek.com    # api 调用地址
  api-key-name: DEEPSEEK_API_KEY        # api 调用口令环境变量名
  tokenizer: deepseek-ai/DeepSeek-V3.2  # 统一的分词器 (可选，用于限制请求长度)
  model:                                # 服务商提供的模型清单
  - name: deepseek-chat                       # 模型标识 (要与服务商的清单一致)
    size: 685.40B                             # 模型尺寸 (可选，暂时仅用作展示)
    context: 128K                             # 上下文长度 (建议，非必选，默认 32K)
    out-length: { default: 4K, max: 8K }      # 输出长度 (可选)
    cost: { hit: 0.2, in: 2, out: 3, unit: RMB/MTk } #  (可选) 价格：缓冲命中、输入、输出、单位(人民币每百万词)
    features: json, tool-call, complete, fim         # (可选) 支持特性
  - name: deepseek-reasoner
    size: 685.40B
    context: 128K
    out-length: { default: 32K, max: 64K }
    cost: { hit: 0.2, in: 2, out: 3, unit: RMB/MTk }
    features: json, tool-call, complete

- name: Gemini
  api-key-name: GEMINI_API_KEY
  base-url: https://generativelanguage.googleapis.com/v1beta/openai/
  model:
    - gemini-2.5-flash-lite   # in:$0.1/mtk out:$0.4/mtk free-level no-call
    - gemini-2.5-flash        # in:$0.30/mtk out:$2.5/mtk free-level no-call
    - gemini-2.5-pro          # in:$1.25/mtk out:$10/mtk free-level no-call
    - gemini-3-flash-preview  # in:$0.5/mtk out:$3/mtk free-level no-call
    - gemini-3-pro-preview    # in:$2/mtk out:$12/mtk non-free

- name: 月之暗面
  api-key-name: MOONSHOT_API_KEY
  base-url: https://api.moonshot.cn/v1
  model:
  - name: kimi-k2-0905-preview # tokens:256k, 代码
  - name: kimi-k2-turbo-preview # tokens:256k, 高速版, ~kimi-k2-0905-preview, 输出速度:60~100ps
  - name: moonshot-v1-128k # tokens:128k, 生成超长文本
  - name: moonshot-v1-128k-vision-preview # 图生文
  - name: kimi-latest # 128k 图片理解
  - name: kimi-thinking-preview # ' 长思考'

- name: 火山方舟
  api-key-name: VOLCES_API_KEY
  base-url: https://ark.cn-beijing.volces.com/api/v3
  model:
  - name: doubao-seed-1-6-251015 # 分段计费 2/M 上下文256k 输出32k

- name: 硅基流动
  api-key-name: SILICONFLOW_API_KEY
  base-url: https://api.siliconflow.cn
  model:
  - name: Qwen/Qwen3-30B-A3B      # ￥2.8/M Tokens 对话 Tools 推理模型 MoE 30B 128K
    tokenizer: Qwen/Qwen3-30B-A3B # 独立指定分词器
  - name: Pro/deepseek-ai/DeepSeek-V3.2
    size: 671B
    context: 160K
    out-length: { default: 4K, max: 8K }
    cost: { in: 2, out: 3, unit: RMB/MTk }
    features: talk, prefix, tools, infer, moe
  - name: Pro/zai-org/GLM-4.7
    size: 355B
    active: 32B
    context: 198K
    cost: { hit: 0.8, in: 4.0, out: 16.0, unit: RMB/MTk }
    features: talk, prefix, tools, moe, infer
  - name: Pro/moonshotai/Kimi-K2-Thinking
    size: 1T
    context: 256K
    cost: { in: 4, out: 16, unit: RMB/MTk }
    features: talk, prefix, tools, infer, moe
  - name: zai-org/GLM-4.6V
    size: 106B
    context: 128K
    cost: { in: 1, out: 3, unit: RMB/MTk }
    features: talk, prefix, tools, vision, infer, moe
  - name: MiniMaxAI/MiniMax-M2
    size: 230B
    active: 10B
    context: 192K
    cost: { in: 2.1, out: 8.4, unit: RMB/MTk }
    features: talk, prefix, tools, coder, infer, moe

- name: aliyun
  api-key-name: ALIYUN_API_KEY
  base-url: https://dashscope.aliyuncs.com/compatible-mode/v1
  model:
  - qwen3-max
  - qwen3-max-preview
  - qwen3-coder-plus
```

在按上例提供了 AI 助手配置文件后，下面的例子将缺省应用`硅基流动`的 k2 模型。

```vim
 let g:zai_use_ai = "硅基流动"
 let g:model = "moonshotai/Kimi-K2-Instruct-0905"
```

上面使用了 AI 助手和模型的名称，也可以用从0开始的索引号。

## 使用说明

### VIM 命令

| 命令                | 描述                          | 模式          |
|---------------------|-------------------------------|---------------|
| `:help`             | Open Zai hel        p         | 仅 Zai 界面可用 |
| `:Zai`              | 打开 Zai 聊天交互界面         | -          |
| `<leader>zo`        | 打开 Zai 聊天交互界面         | normal 模式   |
| `:ZaiClose`         | 关闭 Zai 聊天交互界面         | -          |
| `<leader>zX`        | 关闭 Zai 聊天交互界面         | normal 模式   |
| `:q`                | 关闭 Zai 聊天交互界面         | 仅 Zai 界面可用 |
| `:ZaiGo`            | 发送输入窗口中的内容          | -          |
| `<CR>`              | 发送输入窗口中的内容          | 输入窗口 normal 模式 |
| `:ZaiAdd`           | 添加选中内容到输入窗口        | -          |
| `<leader>za`        | 添加选中内容到输入窗口        | visual 模式   |
| `:ZaiNew`           | 新建聊天                      | 仅 Zai 界面可用 |
| `:[count]ZaiPrev`   | 选中前面的聊天                | 仅 Zai 界面可用 |
| `:[count]cp`        | 选中前面的聊天                | 仅 Zai 界面可用 |
| `:[count]ZaiNext`   | 选中后面的聊天                | 仅 Zai 界面可用 |
| `:[count]cn`        | 选中后面的聊天                | 仅 Zai 界面可用 |
| `:ZaiGoto id`       | 选中 id 指定的聊天            | 仅 Zai 界面可用 |
| `:cn id`            | 选中 id 指定的聊天            | 仅 Zai 界面可用 |
| `:ZaiPreview`       | 在浏览器中展示聊天内容        | 仅 Zai 界面可用 |
| `<leader>dp`        | 在浏览器中展示聊天内容        | Zai 界面 normal 模式 |
| `:ZaiOpenLog`       | 打开聊天日志                  | -          |
| `:ZaiGrepLog <pattern>` | 查找聊天日志              | -          |
| `:ZaiRg <pattern> <dir>` | 指定文件夹查找           | -          |
| `:ZaiLoad`          | 加载 Zai 日志作为新的上下文   | -          |
| `<leader>zl`        | 加载 Zai 日志作为新的上下文   | -          |
| `:ZaiConfig`        | 编辑 AI 配置                  | -          |

### 语音输入（ASR）

语音输入允许您在插入模式下使用实时语音识别直接口述文本。

| 命令/按键           | 描述                          | 模式          |
|---------------------|-------------------------------|---------------|
| `<C-G>`             | 开关 ASR                      | 插入模式      |
| `:ASRToggle`        | 开关 ASR                      | -             |
| `:ASRStart`         | 开始语音输入                  | -             |
| `:ASRStop`          | 停止语音输入                  | -             |

**工作原理**：
1. 在插入模式下按 `<C-G>` 启动 ASR
2. 对着麦克风说话
3. 文本会实时显示（部分识别结果）
4. 静音 3 秒后自动停止识别
5. 再次按 `<C-G>` 可手动停止

**使用要求**：
- zasr-server 必须在 `ws://localhost:2026` 上运行
- Python 包：`websockets`、`pyaudio`
- 可用的麦克风

**使用提示**：
- 启动 ASR 前确保 zasr-server 正在运行
- 查看状态消息以了解连接和识别反馈
- 系统会自动检测静音（3 秒）
- 部分识别结果会实时更新，直到确认最终结果

### Zai 界面说明

Zai 聊天交互界面由三部分构成：
- 顶部: 列表窗口，管理聊天会话列表；
- 中间: 展示窗口，显示聊天交互内容；
- 底部: 输入窗口，提问及发送命令。

在 Zai 界面上可以使用 Zai 的编辑命令，聊天会话列表以及聊天内容禁止用户做变更。

打开交互界面默认创建第一个 Zai 聊天会话，会话标识从 0 开始。

当用户在输入窗口中编辑好请求内容后，退出 insert 模式后，通过 `<CR>` (回车键) 发送。发送内容后，输入窗口自动清空并等待用户的再次输入。

Zai 会在展示窗口中同时展示用户发送的请求，以及远程助手服务响应或者错误消息。默认 Zai 打开了日志记录，会在展示内容的最下面提示记录了当前聊天的日志文件的具体路径。

## 会话命令

除了在 Zai 交互界面窗口中使用的 VIM 命令之外，还可以在输入窗口的待发送内容中使用会话命令。

会话命令主要涉及 AI 助手的工作配置。和 VIM 命令不同，会话命令不由 VIM 的窗口或者缓冲区处理，而是发送给 Zai AI 助手让它在后台处理的。会话命令可以单独发送给 Zai AI 助手，也可以和用户的请求合并在一起发送。

会话命令由命令前缀、命令名称、命令参数三部分构成，默认使用半角冒号作会话命令前缀。

### 会话命令列表

- `:->?` - 设置当前会话的命令前缀
- `:help` - 显示会话命令帮助
- `:exit`/`:quit` - 强制退出远程 AI 服务
- `:show <config>` - 显示 AI 助手的配置项
- `:file <file-path>` - 附加指定文本文件
- `:-file` - 清除所有附件
- `:base-url <url>` - 指定当前聊天的 AI 服务 base-url
- `:api-key-name <key-name>` - 指定访问 AI 服务的密钥环境变量
- `:model <model-name>` - 指定当前聊天的 AI 模型
- `:prompt <text>` - 设置当前聊天新的提示词
- `:prompt<<EOF` - 设置多行提示词（以 EOF 结束）
- `:-prompt` - 取消设置过的提示词
- `:temperature <float>` - 设置当前聊天的创造性参数
- `:-temperature` - 取消之前设置过的创造性参数
- `:top_p <float>` - 设置 top-p 采样参数 (0-1)
- `:-top_p` - 取消 top-p 设置
- `:max_tokens <integer>` - 设置最大词元数
- `:-max_tokens` - 取消最大词元数设置
- `:complete_type <str>` - 设置代码补全的文件类型
- `:prefix <str>` - 设置代码补全的前缀
- `:prefix<<EOF` - 设置多行前缀（以 EOF 结束）
- `:suffix <str>` - 设置填充中间补全的后缀
- `:suffix<<EOF` - 设置多行后缀（以 EOF 结束）
- `:talk_mode <mode>` - 设置对话模式 (instant, chain)
- `:logprobs <int>` - 显示顶部词元概率 (0-20)
- `:history_safety_factor <float>` - 设置历史修剪安全系数 (0.1-0.5, 默认 0.25)
- `:history_keep_last_n <int>` - 保留最近 N 轮对话历史 (>=1, 默认 6)
- `:no-log` - 关闭聊天日志
- `:-no-log` - 取消关闭，即打开聊天日志
- `:load <log-file>` - 从 Zai 日志文件加载上下文
- `:-<param>` - 重置任意参数为默认值（例如 `:-temperature`）

关于 AI 助手配置文件的会话命令列表

- `:list ai` - 列出已经配置的 AI 助手
- `:show ai [name|index]` - 显示指定的 AI 助手，如果没有提供 name|index，显示当前所选。
- `:use  ai <name|index>` - 选取当前 AI 助手，并直接完成切换。
- `:model <name|index>` - 当选定了当前的 AI 助手，则只能从限定的模型列表中选取。
- `:use  ai <name|index> model <name|index>` - 组合 use ai 和 model 到一起。

关于 AI 工具调用的会话命令列表

- `:list tool` - 列出已经拥有的可供 AI 调用的工具集。
- `:show tool [name]` - 显示指定的 AI 工具集
- `:use tool [name]` - 加载 AI 工具集供 AI 调用
- `:sandbox path` - 指定 sandbox 路径。在 file 工具集中用来限制允许操作的文件夹。

关于使用 docker 容器 taskbox 的会话命令列表

- `:show taskbox` - 显示 taskbox 容器信息
- `:start taskbox` - 运行 taskbox 容器
- `:stop taskbox` - 停止 taskbox 容器

关于使用 web 工具的会话命令列表

- `:search <key words>` - 搜索网络 (默认使用 google)
- `:goto url`           - 获得 url 的内容
- `:down url`           - 从 url 下载文件


### 可用工具集

Zai 提供了多个工具集供 AI 调用以与系统交互：

1. **file** - 文件操作
   - `ls` - 列出文件和目录
   - `mkdir` - 创建目录
   - `copy_file` - 复制文件或目录
   - `read_file` - 读取文件内容
   - `write_file` - 写入文件
   - `search_in_file` - 在文件中搜索
   - `substitute_file` - 替换文件中的文本
   - `diff_file` - 比较文件差异
   - `patch_file` - 应用补丁

2. **web** - 网页操作
   - `web_get_content` - 获取网页内容
   - `web_search` - 网络搜索（使用 SearXNG 元搜索引擎，支持 DuckDuckGo、Google、Bing、Brave、百度等多个搜索引擎）
   - `web_download_file` - 从 URL 下载文件

3. **shell** - 安全 shell 执行
   - `execute_shell` - 在 Docker 容器（taskbox）中执行命令
   - 支持 Python 和 shell 命令，提供隔离环境

4. **grep** - 文件搜索
   - `grep` - 在文件中搜索模式（类似 Unix grep）

5. **ai** - AI 操作 （实验性功能）
   - `generate_image` - 使用 AI 生成图片

6. **browser** - 浏览器自动化 （实验性功能）
   - `open_browser` - 在浏览器中打开 URL
   - `get_page_content` - 获取动态页面内容
   - `screenshot` - 截取网页截图

7. **os** - 系统信息
   - `get_os_info` - 获取日期、地区、操作系统版本

### 工具使用示例

加载整个工具集：
```
:use tool file
```

加载工具集中的特定函数：
```
:use tool file.read_file
:use tool file: read_file write_file
```

加载多个工具集：
```
:use tool file web
```

查看可用工具：
```
:list tool
```

显示工具集详情：
```
:show tool file
```

### 配置项说明

可以显示的配置项有:
- `api-key-name` - AI API Key Name
- `base-url` - AI API Base URL
- `model` - AI 系统模型
- `prompt` - AI 系统提示词
- `temperature` - 创造性参数，浮点，范围 [0,2]
- `max-tokens` - AI 最大词元，整数
- `logprobs` - 顶部词元概率，浮点，范围[0,20]
- `top-p` - Top-P词元，浮点，范围[0,1]
- `presence-penalty` - 重复惩罚，浮点，范围[-2,2]
- `frequence-panelty` - 高频惩罚，浮点，范围[-2,2]
- `history-safety-factor` - 历史修剪安全系数 (0.1-0.5)
- `history-keep-last-n` - 保留的最近对话轮数 (>=1)
- `log-file` - 记录当前聊天的日志文件全路径
- `prefix` - 会话命令前缀

### 模型配置示例

以 deepseek 提供的服务为例，对应的配置：
```vim
let g:zai_base_url = "https://api.deepseek.com"
let g:zai_api_key_name = "DEEPSEEK_API_KEY"
let g:zai_default_model = "deepseek-chat"
```

之后可以使用 `:model` 会话命令来改变当前聊天的模型：
```
:model deepseek-reasoner
```

硅基流动配置示例：
```vim
let g:zai_base_url = "https://api.siliconflow.cn"
let g:zai_api_key_name = "SILICONFLOW_API_KEY"
let g:zai_default_model = "Pro/moonshotai/Kimi-K2-Instruct-0905"
```

### 提示词设置

单行提示词设置：
```
:prompt 请作为熟悉计算机科技领域的专业翻译为用户提供帮助。
```

多行提示词设置（块状语法）：
```
:prompt<<EOF
作为代码专家助手，请按步骤来分析问题。
在提供解决方案时，请套用格式：
  ### [标题]
  [分步说明]
  ### 总结: [一句话总结核心]
EOF
```

### 参数设置

设置创造性参数：
```
:prompt 请至少从三个角度分析，每个角度均应逐步思考，最后做综合性总结。
```

上面的提示词仅允许设置一行的内容。当希望使用多行内容作为系统提示词时，需要用到 Zai 的块状 `:prompt` 语法。

#### 多行提示词（块状 `:prompt` 语法)

Zai 支持通过特殊块语法实现多行输入，便于向 DeepSeek 提交复杂提示词或代码示例。通过精心设计的块状文本来覆盖默认提示词，这样让您能与 DeepSeek 进行结构化对话，同时保持 Vim 工作流程中的提示词清晰可读。

和其它的 Zai 会话指令一样，块状 `:prompt` 提示词也是允许和用户的咨询内容一同在输入框中编排并一同发送的。建议把块状提示词和其它 Zai 会话指令放到一起，使用多行空行和您的咨询内容分隔开。因为块状提示词占多行，当一并发送的内容中还包含有其它的 Zai 会话指令时，建议把其它指令放到块状提示词的前面。

设置多行系统提示词的方法：

1. 以 `:prompt<<EOF` 开头（`EOF` 可为任意唯一标记）
2. 逐行输入新提示词内容
3. 以 `EOF` 结尾（或您指定的标记）

结构化提示词示例：

```
:model deepseek-reasoner
:prompt<<PROMPT
 - "作为代码专家AI，请分步分析问题。最终答案始终以加粗标题总结解决方案。"
 - 示例输出格式：
   ### [解决方案摘要]
   [分步解释说明]
PROMPT

我想在vim窗口中打开含图片标签的markdown文档时显示内联缩略图，如何实现？
```

又例如：

```
:model deepseek-chat
:temperature 0.3
```

支持的参数设置命令：
- `:top_p float` - Top-P词元，浮点，范围[0,1]
- `:max_tokens integer` - AI 最大词元，整数
- `:presence_penalty float` - 重复惩罚，浮点，范围[-2,2]
- `:frequency_penalty float` - 高频惩罚，浮点，范围[-2,2]
- `:logprobs float` - 顶部词元概率，浮点，范围[0,20]

使用减号前缀取消设置：
```
:-temperature
```

### MCP 服务配置（用于 Claude Code）

Zai 提供了一个模型上下文协议（MCP）服务器，使 Claude Code (claude.ai/code) 能够访问网络搜索、内容获取和文件下载功能。

#### 前置条件

1. **安装 MCP Python 包**：
   ```bash
   pip install mcp
   ```

2. **确保 Docker 已安装并运行**（SearXNG 网络搜索需要）：
   ```bash
   # 验证 Docker 是否可用
   docker --version
   ```

#### 可用的 MCP 工具

MCP 服务器提供以下工具：

1. **web_search** - 基于 SearXNG 元搜索引擎的网络搜索
   - 支持多个搜索引擎：DuckDuckGo、Google、Bing、Brave、百度、Yandex、Qwant、Startpage
   - 参数：
     - `request`（必需）：搜索查询
     - `engine`：指定搜索引擎（留空为自动选择）
     - `category`：搜索分类（如 'general'、'images'、'videos'、'news'）
     - `time_range`：时间范围过滤（'day'、'week'、'month'、'year'）
     - `language`：语言代码（如 'en'、'zh'、'auto'）
     - `safesearch`：安全搜索级别（0=关闭，1=适中，2=严格）
     - `max_results`：最大返回结果数（默认：10）
     - `return_format`：输出格式（'markdown'、'html'、'links'、'json'）

2. **web_get_content** - 获取网页内容
   - 返回纯文本、Markdown、HTML 或提取的链接
   - 参数：
     - `url`（必需）：要获取的 URL
     - `return_format`：输出格式（'clean_text'、'markdown'、'html'、'links'）

3. **web_download_file** - 从 URL 下载文件
   - 适用于下载图片、压缩包等
   - 参数：
     - `url`（必需）：要下载的 URL
     - `output_path`：完整输出路径（可选）
     - `output_dir`：输出目录（可选）
     - `filename`：自定义文件名（可选）
     - `timeout`：下载超时时间，单位秒（默认：60）

#### 配置方法

将 MCP 服务器添加到 Claude Code 配置文件中（通常位于 `~/.config/claude-code/config.json` 或 `~/.claude/config.json`）：

```json
{
  "mcpServers": {
    "zai-web": {
      "command": "python3",
      "args": [
        "/path/to/zai.vim/python3/mcp_web_server.py"
      ],
      "env": {
        "PYTHONPATH": "/path/to/zai.vim/python3"
      }
    }
  }
}
```

将 `/path/to/zai.vim` 替换为您实际的 zai.vim 安装目录路径。

#### 使用方法

配置完成后，Claude Code 将自动拥有网络搜索和内容获取功能。SearXNG 容器将在首次使用时自动启动。

您可以在 Claude Code 中使用的示例提示词：
- "搜索 Python async/await 最佳实践的相关信息"
- "获取 https://example.com 的内容并总结"
- "查找 Vim 插件的最新新闻"

### 命令前缀

默认会话命令前缀字符是 `:`，可以充当前缀的字符有:
```
: / ~ \ ; ! # $ % & ? @ ^ _ * + = , . < > ` ' " ( ) [ ] { }
```

变更命令前缀示例：
```
:->/
```

## 项目配置

Zai 支持通过项目目录中的 `zai.project/zai_project.yaml` 文件进行项目级配置。这允许您定义项目特定的设置，如沙盒目录和 `tool_shell` 工具的 Docker 容器配置。

### 配置文件位置

从当前工作目录向上搜索配置文件：
- `zai.project/zai_project.yaml`（新格式）
- `zai_project.yaml`（旧格式，会显示警告）

### 配置结构

配置文件应包含配置对象列表。第一个对象用于当前项目。

示例 `zai.project/zai_project.yaml`：
```yaml
- sandbox_home: /path/to/project/sandbox
  shell_container:
    # 可以包含自选的 Docker SDK 参数
    # 主要用于 tool_shell 的 docker container，可用项参见 run():
    # https://docker-py.readthedocs.io/en/stable/containers.html
    image: taskbox:latest            # 指定使用的镜像名
    name: my-project-taskbox         # 指定使用的容器名
    Dockerfile: Dockerfile.taskbox   # 如果镜像不存在，使用这个 dockerfile 创建镜像
    working_dir: /sandbox            # 指定容器的默认进入目录
    user: "1000:1000"  # UID:GID 与主机用户匹配，或者用镜像中定义的用户如 "sandbox"
    volumes:
      - "/host/path:/container/path:rw"
      - "/home/for/project/.git:/sandbox/project/.git:ro"
      - "/ccache/for/project:/ccache/.git:ro"
    network_mode: "bridge"
    environment:
      CCACHE_DIR: "/ccache"
      CCACHE_MAXSIZE: "10G"
    mem_limit: "4g"
    cpu_period: 100000
    cpu_quota: 50000
    detach: true
    auto_remove: true
    network_mode: "bridge"
    command: ["tail", "-f", "/dev/null"]
```

### 容器启动后自动安装

Zai 现在支持在 Docker 容器启动时自动安装软件包。您可以在 `zai_project.yaml` 文件中定义要安装的软件包，它们将在容器创建或启动时自动安装。

#### 安装配置字段

在项目配置中添加以下字段：

1. **`pip_install`**: 通过 pip 安装的 Python 包
   - 支持多种格式：
     - 简单列表：`["PyYAML", "appdirs"]`
     - 带选项的结构化格式：
       ```yaml
       - packages: [torch, torchvision, torchaudio]
         options: [--index-url, https://download.pytorch.org/whl/cpu]
       ```
     - 混合格式：`["PyYAML", ["torch", "--index-url", "https://download.pytorch.org/whl/cpu"]]`
   - **权限说明**：如果容器用户不是 root，请在选项中添加 `--user` 标志
     以将包安装到用户目录，避免权限错误：
     ```yaml
     - packages: [requests, numpy]
       options: [--user]
     ```

2. **`apt_install`**: 通过包管理器安装的系统包
   - 支持多种包管理器：`apt`、`dnf`、`yum`、`rpm`、`pacman`
   - 自动处理 `sudo` 权限
   - 支持多种格式：
     - **简单列表**（默认使用 `apt`）：`["vim", "curl", "git"]`
     - **结构化格式（使用 apt）**：
       ```yaml
       - packages: [vim, git, build-essential]
         options: [-y]
       ```
     - **指定包管理器**：
       ```yaml
       package_manager: dnf
       packages: [vim, git, curl]
       options: [-y]
       ```
     - **多个安装规格**：
       ```yaml
       - package_manager: apt
         packages: [vim, curl]
         options: [-y]
       - package_manager: dnf
         packages: [htop, ncdu]
         options: [-y]
       ```

3. **`post_start_commands`**: 要执行的通用命令
   - 包安装后要运行的 shell 命令列表
   - 适用于使用其他包管理器安装工具（cargo、go、npm 等）
   - 示例：
     ```yaml
     - "cargo install bat"
     - "go install github.com/xxx/tool@latest"
     - "echo '安装完成'"
     ```

#### 安装过程

1. 当持久化容器启动时（或首次创建）：
   - **系统包更新**：更新包管理器（如 `apt-get update`、`dnf check-update`）
   - **自动 sudo 处理**：如果容器用户不是 root，Zai 会自动在有 `sudo` 时使用它
   - **包安装**：使用适当的包管理器安装 `apt_install` 中的包
   - **Python 包**：将 `pip` 升级到最新版本
   - **包安装**：安装 `pip_install` 中的包
   - **通用命令**：按顺序执行 `post_start_commands` 中的命令

2. **智能权限处理**：
   - 如果容器用户是 root（UID=0），直接运行命令
   - 如果容器中有 `sudo` 可用，命令会加上 `sudo` 前缀
   - 如果既不是 root 也没有 sudo，直接运行命令（可能会因权限错误而失败）
   - 所有包管理器（`apt`、`dnf`、`yum` 等）都受益于此自动权限处理

3. **错误处理**：
   - 包管理器更新失败会显示警告但继续安装
   - 如果 `pip` 升级失败，显示警告但继续安装
   - 单个包安装失败会被记录但不会停止进程
   - 所有错误都会记录到 stderr 以便调试

#### 完整示例

```yaml
- sandbox_home: /path/to/project/sandbox
  shell_container:
    image: python:3.11-slim
    name: my-project-container
    working_dir: /sandbox
  
  # Python 包安装
  pip_install:
    - packages: [PyYAML, appdirs, requests]
    - packages: [torch, torchvision, torchaudio]
      options: [--index-url, https://download.pytorch.org/whl/cpu]
  
  # Linux 包安装
  apt_install:
    - packages: [vim, curl, git, build-essential]
  
  # 通用命令
  post_start_commands:
    - "cargo install bat exa"
    - "echo '开发环境就绪'"
    - "python3 --version && pip --version"
```

### 配置字段

- `sandbox_home`：沙盒文件操作的目录。默认为 `~/.local/share/zai/sandbox`。
- `shell_container`：`tool_shell` Docker 容器的配置。
  - `image`：Docker 镜像名称（默认：`taskbox:latest`）
  - `name`：容器名称（默认：`zai-tool-shell-taskbox`）
  - `working_dir`：容器工作目录（默认：`/sandbox`）
  - `user`：用户 UID:GID（默认：主机用户的 UID:GID）
  - `volumes`：卷挂载列表，格式为 `host:container:mode`
  - `network_mode`：Docker 网络模式（默认：`bridge`）
  - 其他 Docker SDK 参数直接传递给容器创建。

### 工具 Shell

`tool_shell` 工具在 Docker 容器（taskbox）中提供安全的 shell 执行功能：
- 隔离的环境
- 跨调用的持久化容器
- 项目特定配置
- 网络访问控制
- 资源限制

在 AI 对话中的示例用法：
```
:use tool shell
请列出当前目录中的文件。
**助手：**
  - **tool call**: `execute_shell` ({"command": "ls -la"...)
  - return: `execute_shell`
```

如果可用，该工具自动使用项目配置，否则使用默认值。

### 沙盒目录

沙盒目录被文件相关工具（`tool_file`、`tool_shell`）用作安全工作区。出于安全考虑，无法访问沙盒之外的文件。

## 许可协议

本项目采用 MIT 许可证发布 - 详见 [LICENSE](LICENSE) 文件。

### 第三方依赖

本插件使用多个第三方 Python 包，它们各自有不同的许可证：

- **核心依赖**：openai (MIT)、requests (Apache 2.0)、appdirs (MIT)、chardet (LGPLv3)、PyYAML (MIT)、tiktoken (MIT)
- **Web 功能**（可选）：beautifulsoup4 (MIT)、selenium (Apache 2.0)、undetected-chromedriver (MIT)
- **系统工具**（可选）：docker (Apache 2.0)、python-magic (MIT)、distro (GPLv3)
- **AI 工具**（可选）：transformers (Apache 2.0)
- **语音输入**（ASR）：websockets (MIT)、pyaudio (MIT)

完整的第三方许可证信息请参见 [LICENSE](LICENSE) 文件。

# Zai.Vim DeepSeek AI助手

![插件截图](screenshot.gif)

Zai.Vim 是一款将 AI 助手直接集成到 Vim 编辑器的插件，管理着同时打开的多个 AI 聊天会话，记录日志，也可以加载日志继续曾经的聊天。切换随意，控制随心。

## 功能特性

- **灵活切换模型和提示词**：在一个聊天会话中允许中途变更使用的模型、提示词等
- **附件支持**：允许附加文本文件作为聊天会话交互的上下文
- **多会话支持**：允许同时进行多个聊天会话
- **会话日志**：保存对话历史记录、可以加载日志并继续历史的会话，可以在浏览器中预览

## 安装指南

### 环境要求

- Vim 8.0+ 或 Neovim
- Python 3.6+
- AI API KEY
  - 例如: DeepSeek API 密钥（设置到`DEEPSEEK_API_KEY`环境变量）
- 必需Python包：
  - `openai`（缺失时自动安装）
- 可选 iamcco/markdown-preview.nvim
- 可选 junegunn/fzf.vim
- 可选 apt install rg
- 可选 pip install lunarcalendar

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
pip install appdirs chardet openai
mkdir -p ~/.vim/pack/plugins/start
cd ~/.vim/pack/plugins/start
git clone -n --depth=1 https://github.com/zighouse/zai.vim.git
git checkout
```

在 Windows 上的内嵌终端命令窗口上执行的命令：
```dos
pip install appdirs chardet openai
md %USERPROFILE%\vimfiles\pack\plugins\start
cd %USERPROFILE%\vimfiles\pack\plugins\start
git clone -n --depth=1 https://github.com/zighouse/zai.vim.git
git checkout
```

进入安装目录下执行 `git pull` 即可手动更新。

也可以下载 zip 包 [Zai.Vim](https://github.com/zighouse/zai.vim/archive/refs/heads/main.zip)，解压后把 zai.vim-main 文件夹放到对应的目录下。

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
   - `web_search` - 网络搜索
   - `web_download_file` - 从 URL 下载文件

3. **shell** - 安全 shell 执行
   - `execute_shell` - 在 Docker 容器（taskbox）中执行命令
   - 支持 Python 和 shell 命令，提供隔离环境

4. **grep** - 文件搜索
   - `grep` - 在文件中搜索模式（类似 Unix grep）

5. **ai** - AI 操作
   - `generate_image` - 使用 AI 生成图片

6. **browser** - 浏览器自动化
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
    image: taskbox:latest
    name: my-project-taskbox
    Dockerfile: "Dockerfile.taskbox"
    working_dir: /sandbox
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

MIT 许可证发布，详情见：[https://github.com/zighouse/zai/blob/main/LICENSE](https://github.com/zighouse/zai/blob/main/LICENSE)

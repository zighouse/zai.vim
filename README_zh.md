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

* Linux/Mac: ~/.local/share/zai/assistants.json
* Windows: %USERPROFILE%\AppData\Local\Zai\assistants.json

一个例子：
```json
 [
     {
         "name": "deepseek",
         "base-url": "https://api.deepseek.com",
         "api-key-name" : "DEEPSEEK_API_KEY",
         "model" : ["deepseek-chat", "deepseek-reasoner"]
     },
     {
         "name": "月之暗面",
         "base-url": "https://api.moonshot.cn/v1",
         "api-key-name" : "MOONSHOT_API_KEY",
         "model" : [
             "kimi-k2-0905-preview",
             "kimi-thinking-preview"
         ]
     },
     {
         "name": "火山方舟",
         "base-url": "https://ark.cn-beijing.volces.com/api/v3",
         "api-key-name" : "VOLCES_API_KEY",
         "model" : [
             "doubao-seed-1-6-250615",
             "doubao-seed-1-6-thinking-250715"
         ]
     },
     {
         "name": "硅基流动",
         "base-url": "https://api.siliconflow.cn",
         "api-key-name" : "SILICONFLOW_API_KEY",
         "model" : [
             "deepseek-ai/DeepSeek-V3.1",
             "deepseek-ai/DeepSeek-R1",
             "moonshotai/Kimi-K2-Instruct-0905",
             "tencent/Hunyuan-MT-7B",
             "inclusionAI/Ling-mini-2.0",
             "ByteDance-Seed/Seed-OSS-36B-Instruct",
             "zai-org/GLM-4.5",
             "Qwen/Qwen3-Coder-480B-A35B-Instruct",
             "Qwen/Qwen3-235B-A22B-Thinking-2507",
             "Qwen/Qwen3-235B-A22B-Instruct-2507",
             "baidu/ERNIE-4.5-300B-A47B",
             "tencent/Hunyuan-A13B-Instruct",
             "MiniMaxAI/MiniMax-M1-80k"
         ]
     }
 ]
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
| `:Zai`              | 打开 Zai 聊天交互界面         | 全 VIM 可用   |
| `<leader>zo`        | 打开 Zai 聊天交互界面         | normal 模式   |
| `:ZaiGo`            | 发送输入窗口中的内容          | 全 VIM 可用   |
| `<CR>`              | 发送输入窗口中的内容          | 输入窗口 normal 模式 |
| `:ZaiAdd`           | 添加选中内容到输入窗口        | 全 VIM 可用   |
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
| `:ZaiLoad`          | 加载 Zai 日志作为新的上下文   | 全 VIM 可用   |
| `<leader>zl`        | 加载 Zai 日志作为新的上下文   | 全 VIM 可用   |
| `:ZaiConfig`        | 编辑 AI 配置                  | 全 VIM 可用   |

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
- `:-prompt` - 取消设置过的提示词
- `:temperature <float>` - 设置当前聊天的创造性参数
- `:-temperature` - 取消之前设置过的创造性参数
- `:no-log` - 关闭聊天日志
- `:-no-log` - 取消关闭，即打开聊天日志

关于 AI 助手配置文件的会话命令列表

- `:list ai` - 列出已经配置的 AI 助手
- `:show ai [name|index]` - 显示指定的 AI 助手，如果没有提供 name|index，显示当前所选。
- `:use  ai <name|index>` - 选取当前 AI 助手，并直接完成切换。
- `:model <name|index>` - 当选定了当前的 AI 助手，则只能从限定的模型列表中选取。
- `:use  ai <name|index> model <name|index>` - 组合 use ai 和 model 到一起。

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

## 许可协议

MIT 许可证发布，详情见：[https://github.com/zighouse/zai/blob/main/LICENSE](https://github.com/zighouse/zai/blob/main/LICENSE)

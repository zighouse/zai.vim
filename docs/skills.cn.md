# 技能系统

## 概述

技能（Skills）扩展了 zai.vim 的 AI 助手，提供结构化、可复用的能力。一个技能由一个 `SKILL.md` 文件定义——该文件包含 YAML 前置元数据（frontmatter）合约和描述如何使用它的 Markdown 正文。这种"文本即协议"的设计意味着技能既是人类可读的文档，也是机器可执行的合约。

技能可以来自三个来源：
- **原生（Native）**——随 zai.vim 捆绑提供或由用户创建
- **外部（External）**——从 URL 安装
- **MCP**——从 MCP（模型上下文协议）服务器发现

## 快速开始

### 列出已安装的技能

```vim
:ZaiSkillList
```

按安全域过滤：

```vim
:ZaiSkillList workspace
```

### 查看技能详情

```vim
:ZaiSkillInfo my-skill
```

### 启用/禁用技能

```vim
:ZaiSkillEnable my-skill
:ZaiSkillDisable my-skill
```

### 从 URL 安装技能

```vim
:ZaiSkillInstall https://example.com/skills/my-skill.tar.gz sha256checksum
```

如果未提供校验和，zai.vim 会提示确认。

### 更新技能

```vim
:ZaiSkillUpdate my-skill https://example.com/skills/my-skill-v2.tar.gz sha256checksum
```

### 查看信任历史

```vim
:ZaiSkillHistory my-skill
```

### 卸载技能

```vim
:ZaiSkillUninstall my-skill
```

### 创建新技能

创建技能最简单的方式是直接向 AI 助手提出请求。工作流程如下：

1. **请 AI** 为特定任务创建一个技能（例如："创建一个能将 Markdown 文件翻译成中文的技能"）
2. AI 调用 `skill_read_spec` 了解 SKILL.md 格式，然后在 `.zaivim/skills/<name>/SKILL.md` 下创建技能
3. AI 使用 `skill_validate` 验证格式
4. **调试**项目中的技能——它会自动被发现并立即可用
5. 满意后，**部署**到全局：

```vim
:ZaiSkillDeploy my-skill
" 如果目标已存在则强制覆盖：
:ZaiSkillDeploy! my-skill
```

你也可以让 AI 代为部署——它会调用 `skill_deploy` 并在覆盖前请求确认。

### 部署项目技能

```vim
:ZaiSkillDeploy my-skill           " 部署（如果目标已存在则拒绝）
:ZaiSkillDeploy! my-skill          " 强制覆盖
```

将 `.zaivim/skills/<name>/` 复制到 `~/.zaivim/skills/<name>/`，使其全局可用。
部署前会验证技能——无效的 SKILL.md 文件会被拒绝。

## SKILL.md 格式

每个技能是一个包含 `SKILL.md` 文件的目录。该文件使用 YAML 前置元数据作为结构化元数据，使用 Markdown 正文作为使用说明。

### 最小示例

```
my-skill/
└── SKILL.md
```

```markdown
---
name: my-skill
description: 对该技能功能的简要描述。
---

# 我的技能

AI 应如何使用该技能的说明。

## 用法

描述何时以及如何调用该技能。
```

### 完整前置元数据参考

```markdown
---
# 必填字段
name: my-skill                    # kebab-case 标识符（小写字母、数字、连字符）
description: 该技能的功能说明       # 一行摘要

# 可选字段
version: "1.0.0"                  # 语义化版本号
security_domain: workspace        # local | workspace | personal | public
origin: native                    # native | adapted | external
trust_level: L1                   # L1 | L2 | L3
dependencies:                     # 所需的工具或服务
  python: ">=3.10"
  docker: true
output_schema: |                  # 期望的输出格式（YAML）
  type: object
  properties:
    result:
      type: string

# Claude Code 兼容字段（支持连字符和/或下划线形式）
when_to_use: 当用户要求 X 时        # 自然语言触发描述
arguments: file_path output_format  # 命名位置参数
argument_hint: "<file> <format>"    # 人类可读的参数提示
allowed_tools: read_file write_file # 技能允许使用的工具
disallowed_tools: shell_execute     # 技能禁止使用的工具
tags: documentation, translation    # 分类标签
paths: "*.md" "*.txt"               # 文件路径模式
disable_model_invocation: false     # 从自动模型发现中隐藏
user_invocable: true                # 用户是否可通过 /name 调用
localized_descriptions:             # 国际化描述
  zh: 该技能的功能说明
context: ""                         # 注入提示的额外上下文
agent: ""                           # 目标代理类型
model: ""                           # 目标模型覆盖
effort: ""                          # 推理努力级别
hooks: {}                           # 生命周期钩子（预留）
shell: ""                           # Shell 环境（预留）
---

# 技能正文

描述该技能功能和用法的 Markdown 内容。
```

> **注意**：zai.vim 同时接受连字符形式（`allowed-tools`）和下划线形式（`allowed_tools`）的键名。连字符键会自动映射为下划线形式，以兼容 Claude Code 格式。

### 字段详情

| 字段 | 必填 | 默认值 | 描述 |
|-------|----------|---------|-------------|
| `name` | 否* | — | kebab-case 标识符（`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`） |
| `description` | 否* | — | 一行摘要（缺失时从正文推断） |
| `version` | 否 | `"0.1.0"` | 语义化版本号字符串 |
| `security_domain` | 否 | `workspace` | 权限范围（见安全域） |
| `origin` | 否 | `native` | 技能的引入方式 |
| `trust_level` | 否 | `L1` | 初始信任等级 |
| `dependencies` | 否 | `{}` | 所需的工具或服务 |
| `output_schema` | 否 | `""` | 期望的输出格式 |
| `when_to_use` | 否 | `""` | 自然语言触发描述，用于自动发现 |
| `arguments` | 否 | `[]` | 命名位置参数（空格/逗号分隔或 YAML 列表） |
| `argument_hint` | 否 | `""` | 人类可读的参数提示，如 `"<file> <format>"` |
| `allowed_tools` | 否 | `[]` | 技能允许使用的工具 |
| `disallowed_tools` | 否 | `[]` | 技能禁止使用的工具 |
| `tags` | 否 | `[]` | 分类标签 |
| `paths` | 否 | `[]` | 与此技能相关的文件路径模式 |
| `disable_model_invocation` | 否 | `false` | 从自动模型发现中隐藏（用户仍可通过 `/name` 调用） |
| `user_invocable` | 否 | `true` | 用户是否可通过 `/name` 斜杠命令调用 |
| `localized_descriptions` | 否 | `{}` | 国际化描述（如 `zh: 中文描述`） |
| `context` | 否 | `""` | 注入系统提示的额外上下文 |
| `agent` | 否 | `""` | 目标代理类型覆盖 |
| `model` | 否 | `""` | 目标模型覆盖 |
| `effort` | 否 | `""` | 推理努力级别 |
| `hooks` | 否 | `{}` | 生命周期钩子（预留） |
| `shell` | 否 | `""` | Shell 环境覆盖（预留） |

\* `name` 和 `description` 如果在前置元数据中省略，会自动从目录名和正文文本推断。

## 变量系统

技能支持在 SKILL.md 正文文本中进行变量展开。变量在调用时、内容发送给 AI 模型之前展开。

### 项目根目录

```
@{project-root}
```

展开为项目根目录的绝对路径（通过向上搜索 `.zaivim/`、`zai.project/` 或 `.claude/` 发现）。

### 会话变量

```
${CLAUDE_SESSION_ID}  或  ${ZAI_SESSION_ID}
${CLAUDE_EFFORT}      或  ${ZAI_EFFORT}
${CLAUDE_SKILL_DIR}   或  ${ZAI_SKILL_DIR}
${CLAUDE_PROJECT_ROOT} 或 ${ZAI_PROJECT_ROOT}
```

双名兼容：同时支持 `CLAUDE_*` 和 `ZAI_*` 前缀，使技能可在 Claude Code 和 zai.vim 之间移植。

| 变量 | 描述 |
|----------|-------------|
| `${ZAI_SESSION_ID}` / `${CLAUDE_SESSION_ID}` | 当前会话标识符 |
| `${ZAI_EFFORT}` / `${CLAUDE_EFFORT}` | 推理努力级别 |
| `${ZAI_SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` | 技能 SKILL.md 所在目录 |
| `${ZAI_PROJECT_ROOT}` / `${CLAUDE_PROJECT_ROOT}` | 项目根目录 |

### 位置参数

```
$ARGUMENTS         # 完整参数字符串
$ARGUMENTS[0]      # 第一个位置参数（从 0 开始）
$0                 # $ARGUMENTS[0] 的简写
$1                 # $ARGUMENTS[1] 的简写
```

### 命名参数

当前置元数据中声明 `arguments` 时，位置参数也可通过名称访问：

```yaml
arguments: file_path output_format
```

调用参数为 `"README.md pdf"` 时，`$file_path` 和 `$0` 都展开为 `README.md`。

超出范围的位置参数（如仅有 3 个参数时的 `$50`）会被保留原样，而非静默删除。

## 动态上下文注入

技能可使用 `!`cmd`` 语法执行 shell 命令并将输出注入技能正文。这实现了动态、上下文感知的技能内容。

### 内联形式

```
当前 git 分支是 !`git branch --show-current`。
```

### 块形式

```
```!
ls -la
```
```

### 安全模型

动态注入遵循 zai.vim 的分层安全架构：

1. **域/来源门控**：仅 `public`/`personal` 域的技能，或 `native` 来源的 `workspace` 技能，才允许执行注入命令。外部/不受信任的技能被阻止。
2. **沙箱执行**（默认）：命令在 bwrap 沙箱中运行，配合 seccomp 系统调用过滤——与 `shell_execute` 相同的安全模型。如果沙箱不可用，执行被阻止（故障关闭）。
3. **全局终止开关**：在设置中设置 `disableSkillShellExecution: true` 可禁用所有动态注入。

### Shell 执行配置

通过 `~/.zaivim/settings.json` 中的 `skillShellExecution` 控制注入命令的执行方式：

**全局设置**（适用于所有技能）：
```json
{
  "skillShellExecution": "sandbox"
}
```

**按技能规则**（基于正则表达式，首个匹配生效）：
```json
{
  "skillShellExecution": [
    { "pattern": "^git-", "mode": "host" },
    { "pattern": "^docker-", "mode": "docker" },
    { "pattern": ".*", "mode": "sandbox" }
  ]
}
```

| 模式 | 行为 |
|------|----------|
| `sandbox`（默认） | bwrap 沙箱 + seccomp 过滤——匹配 zai.vim 安全理念 |
| `host` | 直接宿主机执行（需主动选择，绕过沙箱） |
| `docker` | Docker 容器执行（预留，当前回退到沙箱） |

**配置优先级**：
1. 按技能的正则规则（首个匹配获胜）
2. 全局字符串值（`"sandbox"`、`"host"` 或 `"docker"`）
3. 默认：`"sandbox"`

## Claude Code 兼容性

zai.vim 兼容 Claude Code 技能格式。为 Claude Code 编写的技能可直接使用，zai.vim 技能也可包含 CC 特定字段。

### 字段映射

CC 的连字符字段名会自动映射为 zai.vim 的下划线形式：

| Claude Code | zai.vim |
|-------------|---------|
| `allowed-tools` | `allowed_tools` |
| `disallowed-tools` | `disallowed_tools` |
| `user-invocable` | `user_invocable` |
| `disable-model-invocation` | `disable_model_invocation` |

### 项目根目录发现

zai.vim 从当前目录向上搜索项目标记：
- `.zaivim/`（zai.vim 项目配置）
- `zai.project/`（旧版 zai.vim 项目配置）
- `.claude/`（Claude Code 项目配置）

这意味着 zai.vim 会自动发现使用 Claude Code 的 `.claude/skills/` 或 `.claude/commands/` 目录的项目中的技能。

### 导入 Claude Code 技能

#### 从本地 Claude Code 安装

列出可导入的 CC 技能：
```vim
:ZaiSkillImportClaude
```

安装选定的 CC 技能：
```vim
:ZaiSkillImportClaude my-cc-skill another-skill
```

扫描 `~/.claude/commands/*.md` 和 `~/.claude/skills/*/SKILL.md` 以发现可导入的技能。已安装的技能放置在 `~/.zaivim/skills/` 中，并自动添加 zai.vim 治理字段（`security_domain: workspace`、`origin: external`、`trust_level: L1`）。

#### 从 GitHub 仓库

列出 GitHub 仓库中可用的技能：
```vim
:ZaiSkillInstallGithub owner/repo .claude/commands
```

安装选定的技能：
```vim
:ZaiSkillInstallGithub owner/repo .claude/commands skill-name-1 skill-name-2
```

读取 `GITHUB_TOKEN` 或 `GH_TOKEN` 环境变量进行认证 API 访问（将速率限制从每小时 60 次提升至 5000 次）。

## 技能可见性

通过 `~/.zaivim/settings.json` 中的 `skillOverrides` 控制哪些技能对 AI 模型可见：

```json
{
  "skillOverrides": {
    "my-skill": "on",
    "experimental-skill": "name-only",
    "dangerous-skill": "user-invocable-only",
    "deprecated-skill": "off"
  }
}
```

| 可见性 | 模型可见 | 用户可通过 `/name` 调用 | 描述 |
|------------|---------------|----------------------------|-------------|
| `on`（默认） | 是 | 是 | 完全可见和可调用 |
| `name-only` | 仅名称（无描述） | 是 | 模型知道其存在但不知道其功能 |
| `user-invocable-only` | 否 | 是 | 对模型列表隐藏，仅用户可调用 |
| `off` | 否 | 否 | 完全禁用（等同于 `:ZaiSkillDisable`） |

## 目录结构

技能从多个位置发现。项目级技能优先于用户级技能。

### 用户级技能

```
~/.zaivim/skills/
├── my-skill/
│   ├── SKILL.md
│   └── ...
└── another-skill/
    ├── SKILL.md
    └── ...
```

系统的所有用户共享这些技能。从 URL 安装和适配的技能存储在此处。

### 项目级技能

```
.zaivim/skills/
├── project-skill/
│   ├── SKILL.md
│   └── ...
```

### Claude Code 目录（自动发现）

zai.vim 自动扫描项目根目录中的 Claude Code 技能目录：

```
.claude/skills/           # 现代 CC 格式（每个技能一个目录）
└── cc-skill/
    └── SKILL.md

.claude/commands/          # 旧版 CC 格式（单个 .md 文件）
├── cc-command-1.md
└── cc-command-2.md
```

来自 `.claude/` 目录的技能以 `origin: external` 和 `trust_level: L1` 注册。

### 优先级

当技能存在于多个位置时：

1. 项目 `.zaivim/skills/`——优先，遮蔽所有其他版本
2. 项目 `.claude/skills/` 和 `.claude/commands/`——CC 兼容的项目技能
3. 用户 `~/.zaivim/skills/`——如果不存在项目版本则使用此目录

## 安全模型

### 安全域

技能通过 `security_domain` 声明其预期范围：

| 域 | 范围 | 示例 |
|--------|-------|---------|
| `local` | 单个文件或缓冲区 | 代码格式化、代码检查 |
| `workspace` | 项目目录 | 文件搜索、项目级重构 |
| `personal` | 用户的个人数据 | Git 操作、配置编辑 |
| `public` | 外部网络访问 | 网络搜索、API 调用 |

### 信任等级

技能通过人在回路（HITL）确认机制逐步提升信任等级：

| 等级 | 行为 | 如何达到 |
|-------|----------|-------------|
| **L1** | 每次调用都需要确认 | 所有新技能的初始等级 |
| **L2** | 在声明的域内自动批准 | 同一域内连续 3 次安全使用 |
| **L3** | 完全信任自动批准 | 连续 20 次安全使用（L2+，无安全事件） |

信任等级可随时手动降级。安全相关变更（域、schema）会自动将信任重置为 L1。

### L0 意图验证

技能系统在现有 shell 安全链之上增加了一个 L0 验证层：

- **意图边界**：运行时行为必须保持在声明的意图范围内
- **信任隔离**：信任不传播——子技能始终自动降级
- **解析一致性**：AI 解释与版本绑定缓存，防止漂移

### MCP 安全

MCP 发现的工具经过增强的 HITL 流程：

- 首次调用任何 MCP 工具都会触发确认
- 重新连接时的 schema 变更会触发重新确认
- 从 MCP 服务器移除的工具会被标记为不可用

## 技能链

多个技能可以通过 `SkillChain` 顺序执行：

```
技能 A → 技能 B → 技能 C
```

特性：
- 前一个技能的输出传递给下一个技能
- 每一步之间设置安全检查点（子技能信任自动降级）
- 可恢复故障的指数退避重试（1 秒、2 秒、4 秒）
- 部分成功保留——即使后续步骤失败，已完成步骤的结果也予以保留

## 技能安装

### 从 URL 安装

```vim
:ZaiSkillInstall <url> [sha256-checksum]
```

支持的归档格式：`.tar.gz`、`.tgz`、`.tar.bz2`、`.tar.xz`、`.zip`。

安全措施：
- SHA256 校验和验证（推荐）
- 路径遍历防护（归档条目中不允许 `..`）
- 符号链接/硬链接过滤
- 100MB 下载大小限制
- 原子安装，失败时自动回滚

### 从 Claude Code（本地）

从本地 Claude Code 安装导入技能：

```vim
" 列出可导入的 CC 技能
:ZaiSkillImportClaude

" 安装选定的技能
:ZaiSkillImportClaude skill-1 skill-2
```

扫描 `~/.claude/commands/*.md` 和 `~/.claude/skills/*/SKILL.md`。已安装的技能放置在 `~/.zaivim/skills/` 中，并自动添加 zai.vim 治理字段。

### 从 GitHub 仓库

从任何 GitHub 仓库的 `.claude/commands/` 或类似路径安装技能：

```vim
" 列出 GitHub 仓库中的可用技能
:ZaiSkillInstallGithub owner/repo .claude/commands

" 安装选定的技能
:ZaiSkillInstallGithub owner/repo .claude/commands skill-1 skill-2
```

设置 `GITHUB_TOKEN` 或 `GH_TOKEN` 环境变量进行认证 API 访问（将速率限制从每小时 60 次提升至 5000 次）。

### 从 MCP 服务器

配置 MCP 服务器后，MCP 工具会自动被发现。无需手动安装——工具以 `mcp-` 名称前缀作为技能出现。

## 技能更新

```vim
:ZaiSkillUpdate <name> <url> [sha256-checksum]
```

更新程序：
1. 下载并验证新版本
2. 比较前置元数据（版本、描述、域、schema、依赖）
3. 显示变更的差异摘要
4. 执行原子目录交换（旧版 → `.bak`，新版就位）
5. 如果安全相关字段发生变更，自动将信任降级为 L1
6. 失败时回滚

## 技能创建工具

AI 助手拥有三个专用工具用于创建和管理技能。这些工具在启动时自动发现。

### skill_read_spec

返回完整的 SKILL.md 格式规范（本文档）及创建指南。AI 首先调用此工具以了解如何构建技能。

**输出**：完整的 `docs/skills.md` 内容及逐步创建说明。

**AI 使用时机**：当用户要求创建新技能或定制现有技能时。

### skill_validate

使用解析器验证项目技能的 `SKILL.md` 文件。检查前置元数据、必填字段、名称格式和字段类型。

**参数**：
- `name` — `.zaivim/skills/` 下的技能目录名称

**输出**：成功时返回解析后的元数据摘要，或描述解析错误。

**AI 使用时机**：创建或编辑 SKILL.md 后，在测试前验证正确性。

### skill_deploy

将项目技能复制到用户级目录（`~/.zaivim/skills/`），使其全局可用。

**参数**：
- `name` — 要部署的技能名称
- `force`（可选，默认 `false`）——如果目标已存在则覆盖

**行为**：
- 部署前验证 SKILL.md（拒绝无效技能）
- 除非 `force=True`，否则拒绝覆盖
- 部署后刷新技能注册表

**AI 使用时机**：当用户对项目技能满意并希望全局安装时。

## 审计跟踪

所有技能调用都记录到 `~/.zaivim/skill-audit.jsonl`（JSONL 格式）。每条记录包括：

- 时间戳、会话 ID
- 技能名称、调用链
- 安全域、信任等级
- 验证决策
- 执行时间（毫秒）
- 结果摘要

使用 `jq` 查询：

```bash
jq '.skill_name == "my-skill"' ~/.zaivim/skill-audit.jsonl
```

## 模式建议

系统会监控审计日志中频繁重复的技能链。当某个链模式超过阈值（默认：7 天内使用 5 次）时，系统会建议创建一个新技能来捕获该模式。

生成的建议包括一个预填充了链描述的 SKILL.md 草稿。

## Vim 命令参考

| 命令 | 描述 |
|---------|-------------|
| `:ZaiSkillList [domain]` | 列出已安装的技能，可按域过滤 |
| `:ZaiSkillInfo <name>` | 显示详细的技能信息 |
| `:ZaiSkillEnable <name>` | 启用一个已禁用的技能 |
| `:ZaiSkillDisable <name>` | 禁用一个技能（不移除） |
| `:ZaiSkillInstall <url> [checksum]` | 从 URL 安装技能 |
| `:ZaiSkillUpdate <name> <url> [checksum]` | 从 URL 更新技能 |
| `:ZaiSkillImportClaude [names...]` | 从本地 `~/.claude/` 安装导入 CC 技能 |
| `:ZaiSkillInstallGithub <repo> <path> [names...]` | 列出/安装 GitHub 仓库中的技能 |
| `:ZaiSkillHistory <name> [limit]` | 显示信任演化时间线 |
| `:ZaiSkillUninstall <name>` | 移除技能（需确认） |
| `:ZaiSkillDeploy[!] <name>` | 将项目技能部署到用户级（`!` = 强制覆盖） |

所有接受 `<name>` 参数的命令都支持 Tab 补全。

## 配置参考

### 用户目录覆盖

用户级技能目录可以覆盖：

- **环境变量**：`ZAI_USER_DIR=/custom/path`
- **Vim 配置**：`let g:zai_user_dir = '/custom/path'`

如果两者都未设置，zai.vim 优先使用 `~/.zaivim/`（如果存在），否则回退到平台默认路径（Linux 上为 `~/.local/share/zai/`）。

### 设置文件 (`~/.zaivim/settings.json`)

所有技能相关设置存储在 `~/.zaivim/settings.json` 中：

```json
{
  "disableSkillShellExecution": false,
  "skillShellExecution": "sandbox",
  "skillOverrides": {}
}
```

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `disableSkillShellExecution` | boolean | `false` | 全局终止开关——禁用所有 `!`cmd`` 动态注入 |
| `skillShellExecution` | string 或 array | `"sandbox"` | Shell 执行模式：`"sandbox"`、`"host"`、`"docker"`，或按技能的正则规则 |
| `skillOverrides` | object | `{}` | 按技能可见性：`"on"`、`"name-only"`、`"user-invocable-only"`、`"off"` |

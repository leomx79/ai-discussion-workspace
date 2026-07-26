# 模型与API配置指南 — 不同模型 / 同模型不同API

> Kilo Code 支持为每个 Agent 独立配置模型和 API。
> 本文档说明三种配置方式。

---

## 方式一：每个Agent用不同模型（最推荐）

在 `.kilo/agents/` 下的每个 Agent 文件中，修改 YAML frontmatter 的 `model` 字段：

### tech-lead.md — 用 Claude（推理强，适合验证和裁决）
```yaml
---
name: tech-lead
model: anthropic/claude-sonnet-4-20250514
---
```

### staff-engineer.md — 用 GPT-4o（创造力强，适合提方案）
```yaml
---
name: staff-engineer
model: openai/gpt-4o
---
```

### qa-engineer.md — 用 DeepSeek（性价比高，适合大量审查）
```yaml
---
name: qa-engineer
model: deepseek/deepseek-chat
---
```

> 💡 模型ID格式：`提供商/模型名`
> 常见提供商：openai、anthropic、deepseek、google、mistral、groq 等
> 在 Kilo Code 设置 → API Configuration 中查看可用模型列表

---

## 方式二：同模型不同API Key（独立上下文）

三个Agent都用同一个模型（如 claude-sonnet-4），但通过不同的 API Key 获得独立上下文。

### 配置步骤

1. 打开 Kilo Code → ⚙️ 设置 → **API Configuration**
2. 添加多个 Provider 配置：

| 配置名 | Provider | API Key | Base URL | 用途 |
|---|---|---|---|---|
| Anthropic-1 | Anthropic | sk-key-1 | https://ne.60002.cn | Tech Lead |
| Anthropic-2 | Anthropic | sk-key-2 | https://ne.60002.cn | QA Engineer |
| DeepSeek-1 | DeepSeek | sk-key-3 | https://api.deepseek.com | Staff Engineer |

3. 在 Agent 文件中指定模型：

```yaml
# tech-lead.md
---
name: tech-lead
model: anthropic/claude-sonnet-4-20250514
---

# staff-engineer.md
---
name: staff-engineer
model: deepseek/deepseek-chat
---

# qa-engineer.md
---
name: qa-engineer
model: anthropic/claude-sonnet-4-20250514
---
```

> ⚠️ 同模型不同API Key的意义：
> - 独立的上下文窗口，避免"同一个大脑"问题
> - 如果一个Key有速率限制，多个Key可以并行
> - 不同Key可能走不同的服务器节点

---

## 方式三：用代理/中转站（你的当前配置）

你已有 Anthropic 代理：
- Base URL: `https://ne.60002.cn`
- API Key: `sk-hgrC6Y...`

### 配置方法

在 Kilo Code 设置中：
1. Provider 选 **Anthropic**（或 **OpenAI Compatible**）
2. Base URL 填 `https://ne.60002.cn`
3. API Key 填你的 Key
4. Model 填 `claude-sonnet-4-20250514`

### 如果想用多个代理

| Agent | Provider | Base URL | API Key | Model |
|---|---|---|---|---|
| tech-lead | Anthropic | https://ne.60002.cn | sk-key-1 | claude-sonnet-4-20250514 |
| staff-engineer | OpenAI Compatible | https://另一个代理 | sk-key-2 | gpt-4o |
| qa-engineer | DeepSeek | https://api.deepseek.com | sk-key-3 | deepseek-chat |

---

## 推荐配置方案

### 方案A：全部用同一个代理（最简单）
```
三个Agent都用：anthropic/claude-sonnet-4-20250514
通过 https://ne.60002.cn 代理
一个API Key
```
✅ 最简单，先跑起来再说

### 方案B：不同模型（效果更好）
```
tech-lead:       anthropic/claude-sonnet-4-20250514  （推理强，验证准）
staff-engineer:  openai/gpt-4o                       （创造力强，方案多）
qa-engineer:     deepseek/deepseek-chat               （性价比高，审查细）
```
✅ 不同模型有不同"思维模式"，防幻觉效果更好

### 方案C：同模型不同Key（折中）
```
三个Agent都用 claude-sonnet-4
但用3个不同的API Key（独立上下文）
```
✅ 比方案A好，比方案B简单

---

## 在Agent文件中修改模型

直接编辑 `.kilo/agents/` 下的 .md 文件，改第一行的 `model:` 即可：

```bash
# 文件位置
F:\codex\ai群讨论\.kilo\agents\tech-lead.md
F:\codex\ai群讨论\.kilo\agents\staff-engineer.md
F:\codex\ai群讨论\.kilo\agents\qa-engineer.md
```

每个文件的结构：
```markdown
---
name: tech-lead                    ← Agent名称（不变）
description: "技术负责人..."       ← 描述（不变）
model: anthropic/claude-sonnet-4-20250514  ← 改这里！
tools:                             ← 可用工具（不变）
  - read_file
  - write_file
  - execute_command
  - search_files
  - list_files
  - browser_action
---

（下面是System Prompt，不用改）
```

---

## 常见模型ID参考

| 提供商 | 模型ID | 特点 |
|---|---|---|
| Anthropic | `anthropic/claude-sonnet-4-20250514` | 推理强，适合验证 |
| Anthropic | `anthropic/claude-opus-4-20250514` | 最强，但贵 |
| OpenAI | `openai/gpt-4o` | 均衡，创造力好 |
| OpenAI | `openai/gpt-4o-mini` | 便宜，速度快 |
| DeepSeek | `deepseek/deepseek-chat` | 性价比极高 |
| Google | `google/gemini-2.5-pro` | 长上下文 |
| Mistral | `mistral/mistral-large-latest` | 欧洲模型 |
| Groq | `groq/llama-3.3-70b-versatile` | 速度极快 |

> 具体可用模型取决于你在 Kilo Code 中配置了哪些 Provider。

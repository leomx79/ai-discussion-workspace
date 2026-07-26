# Pi-Agent 深度分析 & 鞍钢宪法改造方案

> 分析日期：2026-07-22
> 分析对象：[earendil-works/pi](https://github.com/earendil-works/pi) (Pi Agent Harness)
> 改造目标：将鞍钢宪法式AI防幻觉讨论协议（V3.1）移植到 Pi 的扩展生态中

---

## 一、Pi-Agent 架构全景

### 1.1 Monorepo 结构

```
pi-agent/
├── packages/
│   ├── agent/          # 核心 Agent 运行时
│   │   └── src/
│   │       ├── agent-loop.ts      # 核心循环：LLM→工具→结果→重复
│   │       ├── types.ts           # AgentMessage, ToolCall 等类型
│   │       └── harness/           # Session, Compaction, Skills
│   ├── ai/             # 统一多提供商 LLM API
│   │   └── (OpenAI, Anthropic, Google, 自定义 Provider)
│   ├── coding-agent/   # 交互式编码代理 CLI（主入口）
│   │   ├── src/core/
│   │   │   ├── extensions/        # 扩展系统（核心改造面）
│   │   │   │   ├── types.ts       # ExtensionAPI 完整类型定义
│   │   │   │   ├── loader.ts      # 扩展加载器
│   │   │   │   └── runner.ts      # 扩展运行时
│   │   │   ├── tools/             # 内置工具 (read, bash, edit, write, grep, find, ls)
│   │   │   ├── system-prompt.ts   # 系统提示词构建
│   │   │   ├── session-manager.ts # 会话持久化
│   │   │   └── model-registry.ts  # 模型注册表
│   │   ├── docs/
│   │   │   ├── extensions.md      # 扩展开发文档（~3000行）
│   │   │   ├── custom-provider.md # 自定义 Provider 文档
│   │   │   └── skills.md          # Skills 文档
│   │   └── examples/extensions/
│   │       └── subagent/          # 子代理示例（关键参考）
│   ├── tui/            # 终端 UI 库（差分渲染）
│   ├── server/         # 服务器模式
│   └── storage/        # 会话存储（sqlite-node, jsonl）
```

### 1.2 核心 Agent Loop（agent-loop.ts）

```
agentLoop() → runLoop()
  外循环：处理 steering messages（用户中途插入的消息）
  内循环：每个 turn
    1. 调用 LLM（带完整上下文）
    2. 解析 tool_calls
    3. 执行工具（sequential 或 parallel 模式）
    4. 将工具结果追加到上下文
    5. 重复直到 LLM 不再调用工具
```

**关键 Hook 点**（`AgentLoopConfig`）：
- `beforeToolCall` — 工具执行前拦截
- `afterToolCall` — 工具执行后处理
- `shouldStopAfterTurn` — 每轮结束判断是否停止
- `getSteeringMessages` — 获取用户中途插入的消息
- `prepareNextTurnContext` — 准备下一轮上下文

### 1.3 扩展系统（核心改造面）

**位置**：`~/.pi/agent/extensions/`（全局）或 `.pi/extensions/`（项目级）

**入口**：TypeScript 模块，导出 `default function(pi: ExtensionAPI)`

**能力矩阵**：

| 能力 | API | 说明 |
|------|-----|------|
| 生命周期事件 | `pi.on(event, handler)` | 30+ 事件（session_start, tool_call, context, input 等） |
| 注册工具 | `pi.registerTool(definition)` | LLM 可调用的自定义工具，TypeBox schema |
| 注册命令 | `pi.registerCommand(name, opts)` | 斜杠命令（/discuss, /analyze） |
| 注册快捷键 | `pi.registerShortcut(key, opts)` | 键盘快捷键 |
| 注册 Provider | `pi.registerProvider(name, config)` | 自定义 LLM 提供商（OpenAI 兼容） |
| 消息渲染 | `pi.registerMessageRenderer()` | 自定义 TUI 渲染 |
| 注入消息 | `pi.sendMessage()` / `pi.sendUserMessage()` | 向对话注入消息 |
| 运行时控制 | `pi.setActiveTools()` / `pi.setModel()` | 动态切换工具和模型 |
| 持久化 | `pi.appendEntry()` | 会话内持久状态 |
| UI 交互 | `ctx.ui.select/confirm/input/editor` | 完整 TUI 交互 |

### 1.4 子代理系统（subagent 示例）

**机制**：通过 `spawn` 启动独立 `pi` 进程，`--mode json -p --no-session`

**三种模式**：
- **Single**：`{ agent: "name", task: "..." }` — 单任务委派
- **Parallel**：`{ tasks: [...] }` — 最多 8 任务，4 并发
- **Chain**：`{ chain: [...] }` — 顺序执行，`{previous}` 占位符传递上下文

**Agent 定义**：`~/.pi/agent/agents/*.md`（YAML frontmatter + Markdown body）
```yaml
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
model: claude-haiku-4-5
---
You are a scout. Quickly investigate...
```

**Workflow Prompts**：`~/.pi/agent/prompts/*.md`（`$@` 参数替换）

---

## 二、Gap Analysis：鞍钢宪法 vs Pi 现有能力

| 鞍钢宪法需求 | Pi 现有能力 | Gap |
|---|---|---|
| 3 角色（TL/SE/QA）不同模型 | subagent 支持 per-agent model | ✅ 可直接用 |
| 角色工具权限差异（QA 无 run_command） | subagent 支持 per-agent tools | ✅ 可直接用 |
| 3 轮讨论编排（发散→收敛→定稿） | chain 模式只支持线性传递 | ⚠️ 需要自定义编排逻辑 |
| L1-L4 置信度标注 | 无 | ❌ 需要 system prompt 注入 |
| QA 否决权 → 回到修正环节 | chain 无分支/回退 | ❌ 需要自定义流程控制 |
| 四方 Sign-off | 无 | ❌ 需要自定义 |
| 跨模型制衡（GLM/DeepSeek/Claude） | registerProvider 支持 OpenAI 兼容 API | ✅ 可直接用 |
| 项目记忆（.ansteel/） | pi 有 session 持久化，但无跨 session 记忆 | ⚠️ 需要自定义工具 |
| 讨论记录归档（.md 文件） | pi 有 session export | ⚠️ 需要自定义格式 |
| 项目预扫描（弱模型辅助） | 无 | ❌ 需要自定义 |
| 工具调用预算限制 | 无 | ⚠️ 可通过 beforeToolCall hook |
| 中文输出 | 无特殊处理 | ✅ system prompt 指定即可 |

---

## 三、改造方案：纯扩展实现（无需 Fork）

### 核心思路

**不 fork pi-agent**，而是创建一个 `ansteel-discussion` 扩展包，利用 Pi 的扩展 API 实现全部鞍钢宪法功能。

```
~/.pi/agent/extensions/ansteel-discussion/
├── index.ts              # 扩展入口
├── orchestrator.ts       # 3轮讨论编排器（核心）
├── confidence.ts         # L1-L4 置信度解析与验证
├── memory.ts             # 项目记忆系统（.ansteel/）
├── providers.ts          # 中国 LLM Provider 注册
├── renderers.ts          # 讨论记录 TUI 渲染
└── agents/               # 角色定义
    ├── tech-lead.md
    ├── staff-engineer.md
    └── qa-engineer.md
```

### 3.1 Provider 注册（providers.ts）

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerProviders(pi: ExtensionAPI) {
  // 智谱 GLM
  pi.registerProvider("zhipu", {
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKey: "$ZHIPU_API_KEY",
    api: "openai-completions",
    models: [
      { id: "glm-4-plus", name: "GLM-4 Plus", reasoning: false,
        input: ["text", "image"], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0.05, output: 0.05, cacheRead: 0, cacheWrite: 0 } },
    ]
  });

  // DeepSeek
  pi.registerProvider("deepseek", {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "$DEEPSEEK_API_KEY",
    api: "openai-completions",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat", reasoning: false,
        input: ["text"], contextWindow: 64000, maxTokens: 8192,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 } },
    ]
  });

  // 通义千问（Token Plan）
  pi.registerProvider("qwen", {
    name: "通义千问",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    apiKey: "$QWEN_API_KEY",
    api: "openai-completions",
    models: [
      { id: "qwen3.8-max-preview", name: "Qwen3.8 Max", reasoning: true,
        input: ["text", "image"], contextWindow: 128000, maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]
  });

  // Claude 代理
  pi.registerProvider("claude-proxy", {
    name: "Claude Proxy",
    baseUrl: "https://ne.60002.cn/v1",
    apiKey: "$CLAUDE_PROXY_KEY",
    api: "openai-completions",
    models: [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", reasoning: false,
        input: ["text", "image"], contextWindow: 200000, maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]
  });
}
```

### 3.2 角色定义（agents/*.md）

**tech-lead.md**:
```yaml
---
name: tech-lead
description: "技术负责人（干部）：定义问题、亲自验证、排优先级、裁决"
tools: read, bash, edit, write, grep, find, ls
model: qwen/qwen3.8-max-preview
---

你是 Tech Lead（技术负责人），鞍钢宪法中的"干部"。

## 职责
- 定义问题范围、关键约束、验收标准
- 亲自验证争议点（干部参加劳动，不能只指挥不动手）
- 排优先级、做架构评估、最终裁决
- 主持三方合议，形成结论

## 置信度规则（必须遵守）
每个事实性断言必须标注置信度：
- L1 🟢 已验证：有明确来源、可交叉验证（必须给出具体来源）
- L2 🟡 高可信：基于可靠知识但无法即时验证（必须说明推理依据）
- L3 🟠 待验证：不确定，需要进一步核查（必须标注并建议验证方法）
- L4 🔴 存疑/未知：不确定或可能错误（必须明确说"我不确定"）

## 纪律
- 不知道就说不知道，绝不编造
- 有工具就用工具验证，不要空谈
- 回复用中文，技术术语保留英文
```

**qa-engineer.md**:
```yaml
---
name: qa-engineer
description: "质量保证（工人，有否决权）：质疑、验证、发现遗漏"
tools: read, grep, find, ls
model: claude-proxy/claude-sonnet-4-20250514
---

你是 QA Engineer（质量保证工程师），鞍钢宪法中的"工人"，拥有否决权。

## 职责
- 逐条质疑方案中的每个技术断言
- 发现遗漏：边界条件、异常处理、资源竞争
- 死锁检测、优先级反转审查、故障传播分析
- 验证修正是否到位

## 否决权
如果你认为方案有致命缺陷，必须明确说"我行使否决权"并给出理由。
不行使否决权就是失职。

## 置信度规则
（同 TL）

## 限制
- 你没有 bash 工具（安全考虑），不能执行命令
- 质疑必须具体（不能只说"可能有问题"，要指出哪里有问题、为什么）
```

### 3.3 讨论编排器（orchestrator.ts）— 核心

这是改造的核心。Pi 的 subagent chain 模式是线性的，不支持：
- 条件分支（QA 否决 → 回到修正）
- 多轮迭代（最多 N 轮修正）
- 上下文累积（每轮看到之前所有讨论）

**方案**：注册一个 `ansteel_discuss` 工具，内部实现完整编排逻辑。

```typescript
import { spawn } from "node:child_process";
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface DiscussionConfig {
  maxRounds: number;        // 最大修正轮数（默认 3）
  workdir: string;          // 项目工作目录
  mode: "A" | "B";         // A=方案生成, B=项目分析
}

export function registerOrchestrator(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ansteel_discuss",
    description: "启动鞍钢宪法式多角色讨论。3个AI角色（TL/SE/QA）用不同模型进行3轮讨论，输出带置信度标注的结论。",
    parameters: Type.Object({
      topic: Type.String({ description: "讨论议题" }),
      mode: Type.Optional(Type.Union([
        Type.Literal("A", { description: "方案生成" }),
        Type.Literal("B", { description: "项目分析" }),
      ]), { description: "讨论模式，默认 A" }),
      workdir: Type.Optional(Type.String({ description: "项目工作目录" })),
    }),
    async execute(toolCallId, params, signal, onUpdate) {
      const topic = params.topic;
      const mode = params.mode ?? "A";
      const workdir = params.workdir ?? process.cwd();
      
      const log: string[] = [];
      let vetoed = false;
      let round = 0;
      const maxRounds = 3;

      // ═══ 第1轮：发散 ═══
      // 1. TL 立项
      const tlR1 = await runAgent("tech-lead", 
        `【第1轮-立项】议题：${topic}\n\n请定义问题范围、关键约束、验收标准。用工具验证你的假设。`,
        workdir, signal);
      log.push(`### Tech Lead（立项）\n\n${tlR1}`);
      onUpdate?.({ content: [{ type: "text", text: formatProgress(log, "第1轮：TL立项完成") }] });

      // 2. SE 初步方案
      const seR1 = await runAgent("staff-engineer",
        `【第1轮-方案】议题：${topic}\n\n${contextSoFar(log)}\n\n请提出具体技术方案（带代码示例）。标注置信度。`,
        workdir, signal);
      log.push(`### Staff Engineer（初步方案）\n\n${seR1}`);
      onUpdate?.({ content: [{ type: "text", text: formatProgress(log, "第1轮：SE方案完成") }] });

      // 3. QA 质疑
      const qaR1 = await runAgent("qa-engineer",
        `【第1轮-质疑】议题：${topic}\n\n${contextSoFar(log)}\n\n请逐条质疑方案中的技术断言。如有致命缺陷，行使否决权。`,
        workdir, signal);
      log.push(`### QA Engineer（质疑）\n\n${qaR1}`);
      vetoed = checkVeto(qaR1);

      // ═══ 第2轮：收敛（如果 QA 否决，可能多轮）═══
      while (vetoed && round < maxRounds) {
        round++;
        // SE 修正
        const seFix = await runAgent("staff-engineer",
          `【第${round+1}轮-修正】QA 行使了否决权，请回应质疑并修正方案。\n\n${contextSoFar(log)}`,
          workdir, signal);
        log.push(`### Staff Engineer（修正 R${round}）\n\n${seFix}`);

        // TL 亲自验证
        const tlVerify = await runAgent("tech-lead",
          `【第${round+1}轮-验证】请亲自验证争议点（用工具跑命令）。\n\n${contextSoFar(log)}`,
          workdir, signal);
        log.push(`### Tech Lead（亲自验证 R${round}）\n\n${tlVerify}`);

        // QA 审核修正
        const qaReview = await runAgent("qa-engineer",
          `【第${round+1}轮-审核】请审核修正是否到位。如仍有致命缺陷，再次否决。\n\n${contextSoFar(log)}`,
          workdir, signal);
        log.push(`### QA Engineer（审核 R${round}）\n\n${qaReview}`);
        vetoed = checkVeto(qaReview);
      }

      // ═══ 第3轮：定稿 ═══
      const tlFinal = await runAgent("tech-lead",
        `【定稿】请主持三方合议，形成最终结论。包含：\n1. 最终方案\n2. 各方置信度\n3. 遗留问题\n4. Sign-off\n\n${contextSoFar(log)}`,
        workdir, signal);
      log.push(`### Tech Lead（最终结论）\n\n${tlFinal}`);

      // 生成讨论记录
      const record = formatDiscussionRecord(topic, mode, log, vetoed, round);
      
      return {
        content: [{ type: "text", text: record }],
        details: { topic, mode, rounds: round + 1, vetoed, log }
      };
    }
  });
}

// 启动独立 pi 进程运行子代理
async function runAgent(agentName: string, prompt: string, 
                        cwd: string, signal?: AbortSignal): Promise<string> {
  const args = ["--mode", "json", "-p", "--no-session",
                "--append-system-prompt", getAgentPromptPath(agentName)];
  
  // 根据角色设置模型和工具
  const agentConfig = AGENT_CONFIGS[agentName];
  if (agentConfig.model) args.push("--model", agentConfig.model);
  if (agentConfig.tools) args.push("--tools", agentConfig.tools.join(","));
  
  args.push(prompt);
  
  return new Promise((resolve, reject) => {
    const proc = spawn(getPiCommand(), args, {
      cwd, shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    
    let output = "";
    proc.stdout.on("data", (chunk) => {
      // 解析 JSON 流，提取 assistant 文本
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message?.role === "assistant") {
            for (const part of event.message.content) {
              if (part.type === "text") output += part.text;
            }
          }
        } catch {}
      }
    });
    
    proc.on("close", (code) => {
      resolve(output || `[Agent ${agentName} 无输出, exit=${code}]`);
    });
    
    signal?.addEventListener("abort", () => proc.kill());
  });
}

function checkVeto(text: string): boolean {
  return /行使否决权|否决|VETO/i.test(text);
}

function contextSoFar(log: string[], maxChars = 12000): string {
  const full = log.join("\n\n---\n\n");
  if (full.length <= maxChars) return full;
  return full.slice(-maxChars) + "\n\n...(早期讨论已截断)";
}
```

### 3.4 命令注册（index.ts 入口）

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProviders } from "./providers.ts";
import { registerOrchestrator } from "./orchestrator.ts";
import { registerMemoryTools } from "./memory.ts";

export default function(pi: ExtensionAPI) {
  // 1. 注册中国 LLM Providers
  registerProviders(pi);

  // 2. 注册讨论编排工具
  registerOrchestrator(pi);

  // 3. 注册项目记忆工具
  registerMemoryTools(pi);

  // 4. 注册斜杠命令
  pi.registerCommand("discuss", {
    description: "启动鞍钢宪法3轮讨论",
    async handler(args, ctx) {
      const topic = args.join(" ");
      if (!topic) {
        ctx.ui.notify("请提供讨论议题", "warning");
        return;
      }
      // 注入用户消息触发讨论
      pi.sendUserMessage(`请使用 ansteel_discuss 工具讨论：${topic}`);
    }
  });

  pi.registerCommand("quick-ask", {
    description: "快速问一个角色（不走完整讨论）",
    async handler(args, ctx) {
      const role = await ctx.ui.select("选择角色", 
        ["tech-lead", "staff-engineer", "qa-engineer"]);
      if (!role) return;
      const question = args.join(" ");
      pi.sendUserMessage(`请以 ${role} 身份回答：${question}`);
    }
  });

  // 5. 系统提示词注入（强制置信度标注）
  pi.on("before_agent_start", async (ctx) => {
    ctx.systemPromptOptions.promptGuidelines = [
      ...(ctx.systemPromptOptions.promptGuidelines ?? []),
      "每个事实性断言必须标注置信度：L1🟢已验证 / L2🟡高可信 / L3🟠待验证 / L4🔴存疑",
      "不知道就说不知道，绝不编造",
      "回复用中文，技术术语保留英文",
    ];
  });

  // 6. 会话开始时加载项目记忆
  pi.on("session_start", async (ctx) => {
    const memory = await loadProjectMemory(process.cwd());
    if (memory) {
      pi.appendEntry({ type: "custom", data: { kind: "ansteel-memory", content: memory } });
    }
  });
}
```

### 3.5 项目记忆系统（memory.ts）

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function registerMemoryTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ansteel_memory_read",
    description: "读取项目记忆（.ansteel/ 目录中的累积知识）",
    parameters: Type.Object({
      category: Type.Union([
        Type.Literal("project"),
        Type.Literal("history"),
        Type.Literal("knowledge"),
        Type.Literal("evolution"),
      ], { description: "记忆类别" }),
    }),
    async execute(_id, params) {
      const memDir = path.join(process.cwd(), ".ansteel");
      const fileMap: Record<string, string> = {
        project: "project.json",
        history: "history.json",
        knowledge: "knowledge.md",
        evolution: "evolution.md",
      };
      const filePath = path.join(memDir, fileMap[params.category]);
      if (!fs.existsSync(filePath)) {
        return { content: [{ type: "text", text: `[${params.category}] 暂无记录` }] };
      }
      const content = fs.readFileSync(filePath, "utf-8");
      return { content: [{ type: "text", text: content.slice(0, 6000) }] };
    }
  });

  pi.registerTool({
    name: "ansteel_memory_save",
    description: "保存发现到项目记忆",
    parameters: Type.Object({
      category: Type.Union([
        Type.Literal("project"),
        Type.Literal("history"),
        Type.Literal("knowledge"),
        Type.Literal("evolution"),
      ]),
      content: Type.String({ description: "要保存的内容" }),
      append: Type.Optional(Type.Boolean({ description: "是否追加，默认 true" })),
    }),
    async execute(_id, params) {
      const memDir = path.join(process.cwd(), ".ansteel");
      fs.mkdirSync(memDir, { recursive: true });
      const fileMap: Record<string, string> = {
        project: "project.json", history: "history.json",
        knowledge: "knowledge.md", evolution: "evolution.md",
      };
      const filePath = path.join(memDir, fileMap[params.category]);
      const append = params.append ?? true;
      if (append && fs.existsSync(filePath)) {
        fs.appendFileSync(filePath, "\n\n" + params.content, "utf-8");
      } else {
        fs.writeFileSync(filePath, params.content, "utf-8");
      }
      return { content: [{ type: "text", text: `[SAVED] ${params.category} 已保存` }] };
    }
  });
}
```

---

## 四、进阶改造方向

### 4.1 实时讨论 TUI 渲染（renderers.ts）

利用 `pi.registerMessageRenderer()` 为讨论过程提供美观的 TUI 展示：
- 每个角色用不同颜色标识
- 置信度标签用 emoji 高亮
- 否决权用红色醒目显示
- 讨论进度条

### 4.2 工具调用预算控制

```typescript
pi.on("tool_call", async (ctx) => {
  // 统计当前 session 工具调用次数
  const count = ctx.getSessionEntries()
    .filter(e => e.type === "tool_call").length;
  if (count > 30) {
    // 注入提醒
    pi.sendMessage({
      role: "user",
      content: [{ type: "text", text: "⚠️ 工具调用预算已用 30 次，请基于已有信息给出结论。" }]
    });
  }
});
```

### 4.3 讨论记录自动归档

```typescript
pi.on("agent_end", async (ctx) => {
  // 检测是否有讨论记录需要归档
  const entries = ctx.getSessionEntries();
  const discussResult = entries.find(e => 
    e.type === "custom" && e.data?.kind === "ansteel-discussion");
  if (discussResult) {
    const filename = `ansteel-solution-${date}-${topic}.md`;
    fs.writeFileSync(path.join(SCRIPT_DIR, filename), discussResult.data.record);
  }
});
```

### 4.4 与现有 ansteel_agents.py 的兼容

保留 Python 脚本作为 CLI 后备方案，Pi 扩展作为主力交互界面：
- 两者共享 `.ansteel/` 记忆目录
- 两者共享 `llm-config.json` 配置（扩展读取同一文件）
- 讨论记录格式兼容

---

## 五、实施路线图

| 阶段 | 内容 | 工作量 | 优先级 |
|------|------|--------|--------|
| P0 | Provider 注册（GLM/DeepSeek/Qwen/Claude代理） | 0.5天 | 🔴 最高 |
| P1 | 角色定义（3个 .md 文件） | 0.5天 | 🔴 最高 |
| P2 | 讨论编排器（ansteel_discuss 工具） | 2天 | 🔴 最高 |
| P3 | 项目记忆工具 | 1天 | 🟡 高 |
| P4 | 斜杠命令（/discuss, /quick-ask） | 0.5天 | 🟡 高 |
| P5 | 系统提示词注入（置信度规则） | 0.5天 | 🟡 高 |
| P6 | TUI 渲染美化 | 1天 | 🟢 中 |
| P7 | 工具预算控制 | 0.5天 | 🟢 中 |
| P8 | 讨论记录归档 | 0.5天 | 🟢 中 |
| P9 | 与 Codex AGENTS.md 集成 | 1天 | 🔵 低 |

**总计**：~8 天工作量，核心功能（P0-P5）约 5 天。

---

## 六、关键决策点

### Q1: 纯扩展 vs Fork？
**推荐：纯扩展**。Pi 的扩展 API 足够强大，无需 fork。好处：
- 跟随上游更新
- 不维护分支
- 安装简单（复制到 `~/.pi/agent/extensions/`）

### Q2: 子代理用 pi 进程 vs 直接调 API？
**推荐：用 pi 进程**（subagent 模式）。好处：
- 每个角色有独立上下文窗口（不互相污染）
- 自动获得 pi 的所有工具（read, bash, grep...）
- 工具调用循环由 pi 管理（不用自己写）
- 天然支持 per-agent model/tools

### Q3: 讨论编排放在哪？
**推荐：注册为 LLM 工具**（`ansteel_discuss`）。好处：
- 主代理可以自主决定何时启动讨论
- 支持 `onUpdate` 实时进度反馈
- 与 pi 的工具系统无缝集成

### Q4: 置信度验证是强制还是建议？
**推荐：system prompt 强制 + 后处理检查**。
- `before_agent_start` 注入规则
- 讨论记录归档时检查是否包含 L1-L4 标签
- 缺失时在记录中标注"⚠️ 未标注置信度"

---

## 七、与现有系统的对比优势

| 维度 | ansteel_agents.py (现有) | Pi 扩展 (改造后) |
|------|---|---|
| 交互方式 | CLI 一次性输出 | **交互式 TUI，实时进度** |
| 工具能力 | 4个基础工具 | **pi 全部工具 + 自定义** |
| 上下文管理 | 手动截断拼接 | **pi 自动管理 + compaction** |
| 会话持久化 | 无（每次从零开始） | **sqlite 持久化，可恢复** |
| 多模型支持 | 手动配置 | **Provider 注册，/model 切换** |
| 可扩展性 | 改 Python 代码 | **热加载扩展，无需重启** |
| 代码质量 | 单文件 1171 行 | **模块化 TypeScript** |
| 生态 | 独立脚本 | **融入 pi 生态（skills, themes, keybindings）** |

---

## 八、下一步行动

1. **立即可做**：创建扩展目录结构，写 Provider 注册
2. **需要确认**：你的 pi 安装方式（npm global? 从源码构建?）
3. **需要确认**：是否要保留 Python 脚本作为后备，还是完全迁移到 Pi
4. **需要确认**：讨论编排是否需要支持"中途人工介入"（pi 的 steering messages 天然支持）

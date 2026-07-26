# Cline 改造方案：鞍钢宪法式多模型防幻觉讨论系统

> **版本**: V1.0
> **日期**: 2026-07-22
> **基线**: Cline v3.18.0 (`F:\cline-v3`)
> **目标**: 将 Cline 从"单模型编码助手"改造为"多模型协作讨论+编码平台"
> **参考原型**: `F:\codex\ai群讨论\ansteel_agents.py` (V3.3)

---

## 〇、改造总纲：你到底要做什么

### 你的核心需求（我的理解）

你不是要做一个"外部调用 Cline 的脚本"，也不是要做一个 MCP 插件。你要的是：

**把 Cline 本身改造成一个"鞍钢宪法讨论平台"**——

1. **多模型真制衡**：TL/SE/QA 三个角色分别用不同的模型（GLM、DeepSeek、Qwen、Claude），不是同一个模型假装三个角色
2. **真智能体**：每个角色都能读代码、搜代码、跑命令，不是空谈
3. **结构化讨论**：3轮讨论（发散→收敛→定稿），L1-L4 置信度标注，QA 否决权，四方 Sign-off
4. **持久记忆**：项目级 `.ansteel/` 目录，讨论历史、知识库、进化日志，跨会话保持
5. **IDE 原生体验**：在 VS Code 里直接触发讨论、看到多角色对话、审查结论，不用切到命令行

### 为什么选 Cline v3.18.0 作为基线

| 对比项 | Cline v3.18.0 (`F:\cline-v3`) | Cline 新版 SDK (`F:\cline-fork`) |
|--------|-------------------------------|----------------------------------|
| 架构复杂度 | 单体，`src/` 一个目录 | monorepo + SDK 抽象层 |
| 改造难度 | ⭐⭐ 直接改源码 | ⭐⭐⭐⭐⭐ 要穿透 SDK 层 |
| Agent 循环 | `recursivelyMakeClineRequests()` 清晰可控 | 委托给 `@cline/core`，黑盒 |
| 工具系统 | XML 解析 + switch-case，加新工具简单 | 枚举 + 动态注册，复杂 |
| 已有 Qwen 支持 | ✅ `src/api/providers/qwen.ts` | ✅ |
| 已有 Subagent | ❌ 无 | ✅ 有，但耦合 SDK |
| 适合深度改造 | ✅ 是 | ❌ 不适合 |

**结论：用 v3.18.0 做深度改造，参考新版的 subagent 设计思路。**


---

## 一、架构设计

### 1.1 改造后的整体架构

```
VS Code Extension (改造后的 Cline)
│
├── 原有功能（保留）
│   ├── Plan 模式：规划
│   ├── Act 模式：编码执行
│   └── 所有原有工具（read_file, write_to_file, execute_command...）
│
├── 新增：Discussion 模式（鞍钢宪法讨论）
│   │
│   ├── DiscussionOrchestrator（讨论编排器）
│   │   ├── 3轮讨论流程控制
│   │   ├── QA 否决 → 修正循环（最多2次）
│   │   ├── 四方 Sign-off 收集
│   │   └── 讨论记录归档
│   │
│   ├── RoleAgent（角色智能体）× 3
│   │   ├── Tech Lead  → 可配模型A（如 GLM-4-Plus）
│   │   ├── Staff Engineer → 可配模型B（如 DeepSeek-Chat）
│   │   └── QA Engineer → 可配模型C（如 Qwen3.8-Max）
│   │   每个角色：
│   │   ├── 独立的 ApiHandler 实例（不同 base_url/api_key/model）
│   │   ├── 独立的 system prompt（角色职责 + 鞍钢宪法规则）
│   │   ├── 独立的工具权限（QA 无 execute_command）
│   │   └── 独立的 temperature 设置
│   │
│   ├── AnsteelMemory（记忆系统）
│   │   ├── .ansteel/project.json  — 项目画像
│   │   ├── .ansteel/history.json  — 讨论历史
│   │   ├── .ansteel/knowledge.md  — 知识库
│   │   └── .ansteel/evolution.md  — 进化日志
│   │
│   └── AnsteelConfig（配置系统）
│       └── .ansteel/config.json — 角色/模型/API 配置
│
└── 新增：UI 组件
    ├── DiscussionView — 多角色对话视图
    ├── ConfidenceBadge — L1🟢 L2🟡 L3🟠 L4🔴 标签
    ├── SignOffPanel — 四方签署面板
    ├── RoundIndicator — 轮次指示器
    └── AnsteelSettings — 鞍钢配置界面
```

### 1.2 数据流

```
用户输入议题
    │
    ▼
DiscussionOrchestrator.runDiscussion(topic, mode)
    │
    ├── 第1轮：发散
    │   ├── TL.run(立项prompt) → 调用工具验证 → 输出立项报告
    │   ├── SE.run(方案prompt + TL报告) → 调用工具读码 → 输出方案(L1-L4)
    │   └── QA.run(质疑prompt + TL报告 + SE方案) → 调用工具验证 → 输出质疑
    │
    ├── 第2轮：收敛
    │   ├── SE.run(回应prompt + QA质疑) → 修正方案
    │   ├── TL.run(验证prompt + 争议点) → 用工具亲自验证
    │   └── QA.run(审核prompt + 修正方案) → 通过/否决
    │       └── 如果否决 → 回到 SE 修正（最多2次）
    │
    ├── 第3轮：定稿
    │   ├── TL.run(合议prompt) → 形成最终结论
    │   └── 输出讨论记录 .md
    │
    └── Codex/用户 补充第4方 Sign-off
```

### 1.3 与原有 Cline 的关系

**核心原则：Discussion 模式是一个新的"模式"，和 Plan/Act 并列，不破坏原有功能。**

```typescript
// 改造前
type ChatMode = "plan" | "act"

// 改造后
type ChatMode = "plan" | "act" | "discussion"
```

- Plan/Act 模式完全不动，原有用户不受影响
- Discussion 模式复用 Cline 的工具执行基础设施（ToolExecutor）
- Discussion 模式复用 Cline 的消息系统（ClineMessage）
- Discussion 模式有自己的编排逻辑（DiscussionOrchestrator）


---

## 二、分阶段改造计划

### 阶段总览

| 阶段 | 内容 | 工作量 | 依赖 |
|------|------|--------|------|
| P1 | 多模型 Provider 层 | 2-3天 | 无 |
| P2 | Discussion 模式骨架 | 3-4天 | P1 |
| P3 | 角色智能体 + 工具权限 | 3-4天 | P2 |
| P4 | 3轮讨论流程 + QA否决 | 2-3天 | P3 |
| P5 | 记忆系统 | 2-3天 | P3 |
| P6 | UI 改造 | 3-4天 | P4 |
| P7 | 配置系统 + 归档 | 1-2天 | P5 |
| P8 | 测试 + 调优 | 2-3天 | 全部 |

**总计：约 18-26 天（一人全职）**

---

## 三、P1：多模型 Provider 层

### 3.1 目标

让 Cline 能同时持有多个 API 连接，每个角色用不同的模型。

### 3.2 新增文件

#### `src/api/providers/ansteel.ts`（新建，~200行）

核心类：

```typescript
/**
 * 单角色 API Handler
 * 每个角色（TL/SE/QA）各持有一个实例
 */
export class AnsteelRoleHandler implements ApiHandler {
    private client: OpenAI
    private roleConfig: AnsteelRoleConfig
    private roleId: string

    constructor(roleId: string, config: AnsteelRoleConfig) {
        this.roleId = roleId
        this.roleConfig = config
        this.client = new OpenAI({
            baseURL: config.baseUrl,
            apiKey: config.apiKey,
        })
    }

    getModel(): { id: string; info: ModelInfo } {
        return {
            id: this.roleConfig.model,
            info: {
                maxTokens: this.roleConfig.maxTokens,
                contextWindow: 128_000,
                supportsPromptCache: false,
            },
        }
    }

    getTemperature(): number { return this.roleConfig.temperature }
    getAllowedTools(): string[] { return this.roleConfig.tools }

    async *createMessage(systemPrompt, messages): ApiStream {
        // 参考 QwenHandler 的实现
        // 支持 qwen3 的 enable_thinking / reasoning_content
        // 支持标准 OpenAI 兼容 API 的流式输出
    }
}

/**
 * 鞍钢讨论管理器 — 持有 3 个角色的 Handler
 */
export class AnsteelDiscussionManager {
    private handlers: Map<string, AnsteelRoleHandler>

    constructor(config: AnsteelConfig) {
        for (const [roleId, roleConfig] of Object.entries(config.roles)) {
            this.handlers.set(roleId, new AnsteelRoleHandler(roleId, {
                ...config.default, ...roleConfig
            }))
        }
    }

    getHandler(roleId: string): AnsteelRoleHandler | undefined
    getAllRoles(): string[]
}
```

**设计要点**：
- 参考 `src/api/providers/qwen.ts` 的 `QwenHandler` 实现（已验证可用）
- 复用 `convertToOpenAiMessages()` 做消息格式转换
- 复用 `@withRetry()` 装饰器做重试
- 支持 `reasoning_content`（qwen3 思考链）

### 3.3 修改文件

#### `src/shared/api.ts`（+40行）

```typescript
// 在 ApiProvider 类型中新增
export type ApiProvider = ... | "ansteel"

// 新增配置类型
export interface AnsteelRoleApiConfig {
    ansteelBaseUrl?: string
    ansteelApiKey?: string
    ansteelModel?: string
    ansteelTemperature?: number
    ansteelMaxTokens?: number
    ansteelMaxToolRounds?: number
    ansteelTools?: string[]
}
```

#### `src/api/index.ts`（+15行）

在 `createHandlerForProvider()` 的 switch 中新增 `case "ansteel"`。

### 3.4 配置文件格式

工作区 `.ansteel/config.json`（兼容现有 `llm-config.json`）：

```json
{
    "default": {
        "base_url": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        "api_key": "sk-sp-xxx",
        "model": "qwen3.8-max-preview",
        "temperature": 0.2,
        "max_tokens": 8192,
        "max_tool_rounds": 30
    },
    "roles": {
        "tech-lead": {
            "temperature": 0.1,
            "tools": ["read_file", "list_files", "search_files", "execute_command"]
        },
        "staff-engineer": {
            "base_url": "https://api.deepseek.com/v1",
            "api_key": "sk-ds-xxx",
            "model": "deepseek-chat",
            "temperature": 0.3
        },
        "qa-engineer": {
            "base_url": "https://open.bigmodel.cn/api/paas/v4",
            "api_key": "xxx.glm-xxx",
            "model": "glm-4-plus",
            "temperature": 0.5,
            "tools": ["read_file", "list_files", "search_files"]
        }
    }
}
```


---

## 四、P2：Discussion 模式骨架

### 4.1 目标

在 Cline 中新增第三种模式 "discussion"，用户可以在 Plan/Act/Discussion 之间切换。

### 4.2 修改文件

#### `src/shared/ChatSettings.ts`（+5行）

```typescript
export interface ChatSettings {
    mode: "plan" | "act" | "discussion"  // ← 新增 "discussion"
    preferredLanguage?: string
    openAIReasoningEffort?: OpenAIReasoningEffort
    discussionMode?: "A" | "B"           // A=方案生成, B=项目分析
    discussionSubMode?: "A"|"B"|"C"|"D"|"E"  // B模式的5种子模式
}
```

#### `src/core/task/index.ts`（+30行）

在 `initiateTaskLoop()` 中检测模式：

```typescript
private async initiateTaskLoop(userContent: UserContent): Promise<void> {
    // 讨论模式走专用编排器
    if (this.chatSettings.mode === "discussion") {
        await this.initiateDiscussionLoop(userContent)
        return
    }
    // 原有逻辑不变 ...
}

private async initiateDiscussionLoop(userContent: UserContent): Promise<void> {
    const orchestrator = new DiscussionOrchestrator(this, this.chatSettings)
    await orchestrator.run(userContent)
}
```

### 4.3 新增核心文件

#### `src/core/discussion/DiscussionOrchestrator.ts`（新建，~800行，核心）

从 `ansteel_agents.py` 的 `run_discussion()` 移植。核心方法：

```typescript
export class DiscussionOrchestrator {
    private task: Task
    private manager: AnsteelDiscussionManager
    private memory: AnsteelMemory
    private record: DiscussionRecord

    async run(userContent: UserContent): Promise<void> {
        const topic = extractTopic(userContent)
        const projectProfile = await this.memory.loadProjectProfile()
        const recentHistory = await this.memory.searchHistory(topic)

        // === 第1轮：发散 ===
        const tlReport = await this.runAgentTurn("tech-lead",
            buildTlKickoffPrompt(topic, projectProfile, recentHistory))
        const seProposal = await this.runAgentTurn("staff-engineer",
            buildSeProposalPrompt(topic, tlReport))
        const qaChallenge = await this.runAgentTurn("qa-engineer",
            buildQaChallengePrompt(topic, tlReport, seProposal))

        // === 第2轮：收敛 ===
        const seRevision = await this.runAgentTurn("staff-engineer",
            buildSeRevisionPrompt(qaChallenge, seProposal))
        const tlVerification = await this.runAgentTurn("tech-lead",
            buildTlVerificationPrompt(qaChallenge, seRevision))
        let qaVerdict = await this.runAgentTurn("qa-engineer",
            buildQaVerdictPrompt(seRevision, tlVerification))

        // 否决循环（最多2次修正）
        let correctionCount = 0
        while (this.isVetoed(qaVerdict) && correctionCount < 2) {
            correctionCount++
            const seFix = await this.runAgentTurn("staff-engineer", ...)
            const tlReVerify = await this.runAgentTurn("tech-lead", ...)
            qaVerdict = await this.runAgentTurn("qa-engineer", ...)
        }

        // === 第3轮：定稿 ===
        const finalConclusion = await this.runAgentTurn("tech-lead",
            buildTlFinalPrompt(this.record))

        // 归档 + 更新记忆 + 请求第4方Sign-off
        await this.saveDiscussionRecord(finalConclusion)
        await this.memory.updateHistory(this.record)
        await this.memory.updateKnowledge(this.record)
        await this.requestFourthPartySignOff(finalConclusion)
    }

    /**
     * 执行单个角色的一轮对话（核心方法）
     * 复用 Cline 的工具执行基础设施
     */
    private async runAgentTurn(roleId: string, prompt: string): Promise<string> {
        const handler = this.manager.getHandler(roleId)
        const systemPrompt = buildRoleSystemPrompt(roleId, this.task.cwd)
        const allowedTools = handler.getAllowedTools()
        const messages = [{ role: "user", content: prompt }]

        let fullResponse = ""
        let toolRounds = 0

        while (toolRounds < 12) {  // 防止无限循环
            // 1. 调用模型（流式）
            let responseText = ""
            for await (const chunk of handler.createMessage(systemPrompt, messages)) {
                if (chunk.type === "text") {
                    responseText += chunk.text
                    await this.streamAgentOutput(roleId, chunk.text)
                }
            }
            fullResponse += responseText

            // 2. 解析工具调用（复用 Cline 的 XML 解析器）
            const parsed = parseAssistantMessageV2(responseText)
            const toolUses = parsed.filter(b => b.type === "tool_use")
            if (toolUses.length === 0) break

            // 3. 权限过滤 + 执行工具
            for (const toolUse of toolUses) {
                if (!allowedTools.includes(toolUse.name)) {
                    // 返回权限拒绝信息
                    continue
                }
                const result = await this.task.executeToolDirect(toolUse)
                messages.push({ role: "assistant", content: responseText })
                messages.push({ role: "user",
                    content: `[工具结果] ${toolUse.name}:\n${result}` })
            }
            toolRounds++
        }

        this.record.addTurn(roleId, fullResponse)
        return fullResponse
    }

    private isVetoed(qaOutput: string): boolean {
        return /\[否决\]|\[VETO\]|否决理由|REJECTED/i.test(qaOutput)
    }
}
```

#### `src/core/discussion/types.ts`（新建，~100行）

```typescript
export interface DiscussionRecord {
    topic: string
    mode: "A" | "B"
    subMode?: string
    startTime: Date
    rounds: RoundRecord[]
    finalConclusion?: string
    vetoCount: number
    signOffs: SignOff[]
}

export interface AgentTurn {
    roleId: "tech-lead" | "staff-engineer" | "qa-engineer"
    roleName: string
    model: string
    content: string
    toolCalls: ToolCallRecord[]
    confidenceLabels: ConfidenceLabel[]
    timestamp: Date
}

export interface ConfidenceLabel {
    level: "L1" | "L2" | "L3" | "L4"
    claim: string
    evidence?: string
}

export interface SignOff {
    party: string
    approved: boolean
    comment?: string
    timestamp: Date
}
```


---

## 五、P3：角色智能体 + 工具权限

### 5.1 角色 System Prompt

#### `src/core/discussion/prompts.ts`（新建，~300行）

每个角色有独立的 system prompt，包含：
- 角色职责定义
- 鞍钢宪法讨论规则（置信度标签、讨论纪律）
- 可用工具列表
- 嵌入式开发专用检查清单

```typescript
const ANSTEEL_RULES = `
## 鞍钢宪法讨论规则（必须遵守）

### 置信度标签（每个事实性断言必须标注）
- L1 🟢 已验证：有明确来源、可交叉验证（必须给出具体来源）
- L2 🟡 高可信：基于可靠知识但无法即时验证（必须说明推理依据）
- L3 🟠 待验证：不确定，需要进一步核查（必须标注并建议验证方法）
- L4 🔴 存疑/未知：不确定或可能错误（必须明确说"我不确定"）

### 讨论纪律
- 证据 > 自信。有证据的 L2 胜过没证据的 L1
- 不知道就说不知道，绝不编造
- 对事不对人：质疑观点，不质疑角色
- 有错必纠：发现错误立即修正
- 禁止模糊：不说"可能""大概""也许"而不标注置信度
- 被质疑时必须正面回应，不能转移话题
`

export function buildRoleSystemPrompt(roleId: string, cwd: string): string {
    // TL: 定义问题、亲自验证、排优先级、裁决
    // SE: 提方案、读代码、定位问题、分析根因
    // QA: 质疑、验证、发现遗漏、否决权
    // 每个角色注入 ANSTEEL_RULES + 嵌入式检查清单
}
```

### 5.2 工具权限映射

| 鞍钢原型工具 | Cline 工具 | TL | SE | QA |
|-------------|-----------|----|----|-----|
| `read_file` | `read_file` | ✅ | ✅ | ✅ |
| `list_dir` | `list_files` | ✅ | ✅ | ✅ |
| `grep_code` | `search_files` | ✅ | ✅ | ✅ |
| `run_command` | `execute_command` | ✅ | ✅ | ❌ |
| `read_memory` | `ansteel_read_memory`（新增） | ✅ | ✅ | ✅ |
| `save_memory` | `ansteel_save_memory`（新增） | ✅ | ✅ | ✅ |
| `search_history` | `ansteel_search_history`（新增） | ✅ | ✅ | ✅ |

### 5.3 新增工具

在 `src/core/assistant-message/index.ts` 中扩展 toolUseNames 和 toolParamNames。

在 `src/core/task/ToolExecutor.ts` 中新增 3 个 case：
- `ansteel_read_memory`：读取 `.ansteel/` 下的记忆文件
- `ansteel_save_memory`：追加写入记忆文件
- `ansteel_search_history`：搜索讨论历史

---

## 六、P4：3轮讨论流程 + QA否决

### 6.1 讨论流程状态机

```
                    ┌─────────────────────────────────────┐
                    │                                     │
                    ▼                                     │
┌──────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐ │
│ 开始  │───▶│ 第1轮:发散 │───▶│ 第2轮:收敛 │───▶│ QA 审核   │ │
└──────┘    │ TL立项    │    │ SE回应    │    │ 通过/否决 │ │
            │ SE方案    │    │ TL验证    │    └────┬─────┘ │
            │ QA质疑    │    │ QA审核    │         │       │
            └──────────┘    └──────────┘    ┌────┴────┐   │
                                           │         │   │
                                           ▼         ▼   │
                                        通过      否决───┘
                                           │     (≤2次)
                                           ▼
                                     ┌──────────┐
                                     │ 第3轮:定稿 │
                                     │ TL合议    │
                                     │ 输出记录   │
                                     │ 更新记忆   │
                                     │ 4方Sign-off│
                                     └──────────┘
```

### 6.2 QA 否决检测

```typescript
private isVetoed(qaOutput: string): boolean {
    const vetoPattern = /\[否决\]|\[VETO\]|否决理由|REJECTED/i
    return vetoPattern.test(qaOutput)
}
```

QA 被要求在否决时使用结构化格式：`[否决] 理由：xxx`

### 6.3 上下文管理

防止超出 context window 的策略：
1. 最近2轮完整保留
2. 更早的轮次只保留前200字摘要
3. 工具调用结果截断到前500字符
4. 总 token 数不超过 60000


---

## 七、P5：记忆系统

### 7.1 目录结构

```
项目根目录/
└── .ansteel/
    ├── config.json      — 角色/模型/API 配置
    ├── project.json     — 项目画像（芯片、RTOS、模块列表）
    ├── history.json     — 讨论历史索引
    ├── knowledge.md     — 累积知识库
    ├── evolution.md     — 进化日志（QA否决模式、常见错误）
    └── discussions/     — 讨论记录归档
        ├── 2026-07-22-审查-control_loop.md
        └── ...
```

### 7.2 新增文件

#### `src/core/discussion/AnsteelMemory.ts`（新建，~250行）

从 `ansteel_agents.py` 的记忆系统移植：

```typescript
export class AnsteelMemory {
    private memoryDir: string

    constructor(projectRoot: string) {
        this.memoryDir = path.join(projectRoot, ".ansteel")
    }

    // 项目画像
    async loadProjectProfile(): Promise<string>
    async saveProjectProfile(profile: object): Promise<void>

    // 讨论历史
    async searchHistory(query: string): Promise<string>
    async updateHistory(record: DiscussionRecord): Promise<void>

    // 知识库
    async updateKnowledge(record: DiscussionRecord): Promise<void>

    // 进化日志
    async updateEvolution(record: DiscussionRecord): Promise<void>

    // 通用读写（供工具调用）
    async read(category: string): Promise<string>
    async save(category: string, content: string): Promise<void>
}
```

### 7.3 项目画像自动检测

从 `ansteel_agents.py` 的 `auto_build_project_profile()` 移植：
- 扫描 Makefile / CMakeLists.txt 检测芯片型号
- 扫描 FreeRTOSConfig.h 检测 RTOS
- 扫描 .c/.h 文件检测功能模块
- 结果存入 `.ansteel/project.json`

---

## 八、P6：UI 改造

### 8.1 模式切换器

#### `webview-ui/src/components/chat/ChatTextArea.tsx`（+15行）

在现有 Plan/Act 切换旁新增"讨论"选项。

### 8.2 新增 UI 组件

#### `webview-ui/src/components/chat/DiscussionView.tsx`（新建，~200行）

多角色对话视图：
- 轮次标题（第1轮：发散 / 第2轮：收敛 / 第3轮：定稿）
- 角色发言（带颜色标识：TL蓝/SE绿/QA橙）
- 模型标签（显示每个角色用的什么模型）
- 工具调用记录（折叠显示）
- 置信度标签渲染（L1🟢 L2🟡 L3🟠 L4🔴）

#### `webview-ui/src/components/chat/SignOffPanel.tsx`（新建，~80行）

四方 Sign-off 面板：
- 4个签署方（TL/SE/QA/架构审查员）
- 每个显示 ✅通过 或 ❌否决
- 用户（第4方）可以在线签署

#### `webview-ui/src/components/settings/AnsteelSettings.tsx`（新建，~150行）

鞍钢配置界面：
- 三个角色的 API 配置（base_url, api_key, model, temperature）
- 讨论模式选择（方案生成/项目分析）
- 工具权限配置

### 8.3 消息类型扩展

#### `src/shared/ExtensionMessage.ts`（+15行）

新增 ClineSay 类型：
- `discussion_round`：轮次标题
- `discussion_agent`：角色发言
- `discussion_tool_call`：工具调用
- `discussion_veto`：否决通知
- `discussion_signoff`：Sign-off
- `discussion_complete`：讨论完成

---

## 九、P7：配置系统 + 归档

### 9.1 配置加载优先级

```
1. 工作区 .ansteel/config.json（最高优先级）
2. VS Code settings（cline.ansteel.*）
3. 全局 ~/.cline/ansteel-config.json
4. 内置默认值
```

### 9.2 讨论记录归档

每次讨论完成自动保存到 `.ansteel/discussions/` 目录。
格式与现有 `ansteel-solution-*.md` 兼容。

### 9.3 与 AGENTS.md 的集成

Discussion 模式启动时自动读取工作区的 `AGENTS.md`，
将鞍钢宪法规则注入到每个角色的 system prompt 中。


---

## 十、P8：测试计划

### 10.1 测试项目

使用 `F:\温控`（AT32F407 温度控制系统，71个源文件）作为测试项目。

### 10.2 测试用例

| # | 测试内容 | 预期结果 |
|---|---------|---------|
| 1 | 三个角色用不同模型 | TL/SE/QA 分别调用配置的模型 |
| 2 | TL 用 execute_command | 成功执行命令并返回结果 |
| 3 | QA 用 execute_command | 被拒绝，返回权限错误 |
| 4 | 3轮讨论完整流程 | 发散→收敛→定稿，输出记录 |
| 5 | QA 否决触发修正循环 | 回到 SE 修正，最多2次 |
| 6 | 记忆持久化 | .ansteel/ 目录正确写入 |
| 7 | 跨会话记忆 | 新讨论能读取历史 |
| 8 | 上下文窗口管理 | 长讨论不超出 context window |
| 9 | Plan/Act 模式不受影响 | 原有功能正常 |
| 10 | 讨论记录归档 | .md 文件正确生成 |

### 10.3 验收标准

- [ ] 在 VS Code 中一键触发3轮讨论
- [ ] 三个角色用不同模型，UI 清晰显示
- [ ] 每个角色能真正读代码、搜代码
- [ ] QA 否决权正常工作
- [ ] 讨论记录自动保存
- [ ] 记忆跨会话保持
- [ ] 原有 Plan/Act 功能不受影响

---

## 十一、文件改动清单

### 新增文件（11个）

| 文件 | 用途 | 预估行数 |
|------|------|---------|
| `src/api/providers/ansteel.ts` | 多模型 Provider | ~200 |
| `src/core/discussion/DiscussionOrchestrator.ts` | 讨论编排器（核心） | ~800 |
| `src/core/discussion/prompts.ts` | 角色 System Prompt | ~300 |
| `src/core/discussion/types.ts` | 类型定义 | ~100 |
| `src/core/discussion/AnsteelMemory.ts` | 记忆系统 | ~250 |
| `src/core/discussion/config.ts` | 配置加载 | ~150 |
| `webview-ui/src/components/chat/DiscussionView.tsx` | 讨论视图 | ~200 |
| `webview-ui/src/components/chat/SignOffPanel.tsx` | Sign-off 面板 | ~80 |
| `webview-ui/src/components/chat/ConfidenceBadge.tsx` | 置信度标签 | ~50 |
| `webview-ui/src/components/settings/AnsteelSettings.tsx` | 配置界面 | ~150 |
| `src/core/discussion/index.ts` | 模块导出 | ~20 |

### 修改文件（10个）

| 文件 | 改动内容 | 改动量 |
|------|---------|--------|
| `src/shared/ChatSettings.ts` | 新增 "discussion" 模式 | ~5行 |
| `src/shared/api.ts` | 新增 Ansteel 配置类型 | ~40行 |
| `src/shared/ExtensionMessage.ts` | 新增讨论消息类型 | ~15行 |
| `src/api/index.ts` | 新增 ansteel provider | ~15行 |
| `src/core/task/index.ts` | 讨论模式入口 | ~30行 |
| `src/core/task/ToolExecutor.ts` | 新增3个记忆工具 | ~60行 |
| `src/core/assistant-message/index.ts` | 新增工具名/参数名 | ~10行 |
| `src/core/prompts/system.ts` | 讨论模式提示词 | ~20行 |
| `webview-ui/src/components/chat/ChatTextArea.tsx` | 模式切换器 | ~15行 |
| `webview-ui/src/components/chat/ChatView.tsx` | 讨论视图集成 | ~30行 |

### 总代码量

- 新增：~2,300 行
- 修改：~240 行
- **总计：~2,540 行**


---

## 十二、风险和注意事项

### 12.1 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 不同模型的 XML 工具调用格式不一致 | 工具解析失败 | 在 system prompt 中严格规定格式；增加容错解析 |
| 上下文窗口溢出 | 讨论中断 | 实现上下文截断策略（P4 已设计） |
| 模型不遵守置信度标注规则 | 讨论质量下降 | 在 prompt 中反复强调；后处理检测 |
| QA 否决检测误判 | 流程异常 | 要求 QA 使用结构化格式 `[否决]` |
| Cline 升级后代码冲突 | 维护困难 | 改动集中在新增文件，减少对原有文件的修改 |

### 12.2 模型兼容性

不是所有模型都能很好地遵循 XML 工具调用格式。推荐：

| 模型 | 工具调用能力 | 推荐角色 |
|------|------------|---------|
| Qwen3.8-Max | ⭐⭐⭐⭐⭐ | TL/SE |
| DeepSeek-Chat | ⭐⭐⭐⭐ | SE |
| GLM-4-Plus | ⭐⭐⭐⭐ | QA |
| Claude Sonnet 4 | ⭐⭐⭐⭐⭐ | 任意 |
| GPT-4o | ⭐⭐⭐⭐ | 任意 |
| 小模型（7B以下） | ⭐⭐ | 不推荐 |

### 12.3 成本控制

3轮讨论 × 3角色 × 每角色可能多轮工具调用 = 大量 API 调用。

- 默认每角色最多 12 轮工具调用
- 上下文截断减少 token 消耗
- 可选：第1轮用便宜模型，第3轮用强模型

---

## 十三、与现有原型的关系

```
ansteel_agents.py (Python 原型)
    │
    │  移植核心逻辑
    ▼
DiscussionOrchestrator.ts (TypeScript)
    │
    │  复用基础设施
    ▼
Cline 工具系统 (ToolExecutor)
Cline 消息系统 (ClineMessage)
Cline API 层 (ApiHandler)
```

**原型中保留的**：
- 3轮讨论流程逻辑
- 角色 system prompt
- QA 否决机制
- 记忆系统设计
- 置信度标签规则

**原型中丢弃的**：
- OpenAI Agents SDK 依赖（改用 Cline 原生工具系统）
- Python 工具实现（改用 Cline 的 TypeScript 工具）
- 命令行交互（改用 VS Code UI）

---

## 十四、快速开始（改造完成后）

1. 在 VS Code 中打开项目（如 `F:\温控`）
2. 打开 Cline 面板
3. 切换到"讨论"模式
4. 输入议题：`帮我审查 Src/control_loop.c 中的 MPC 控制逻辑`
5. 三个角色自动开始3轮讨论
6. 讨论完成后，你作为第4方签署 Sign-off
7. 讨论记录自动保存到 `.ansteel/discussions/`

---

## 附录A：关键源码位置速查

| 功能 | 文件 | 关键函数/类 |
|------|------|-----------|
| API Provider 工厂 | `src/api/index.ts` | `buildApiHandler()` |
| Qwen Provider（参考） | `src/api/providers/qwen.ts` | `QwenHandler` |
| Agent 循环 | `src/core/task/index.ts` | `recursivelyMakeClineRequests()` |
| 工具执行 | `src/core/task/ToolExecutor.ts` | `executeTool()` |
| XML 解析 | `src/core/assistant-message/parse-assistant-message.ts` | `parseAssistantMessageV2()` |
| System Prompt | `src/core/prompts/system.ts` | `SYSTEM_PROMPT()` |
| 模式定义 | `src/shared/ChatSettings.ts` | `ChatSettings.mode` |
| 消息类型 | `src/shared/ExtensionMessage.ts` | `ClineSay`, `ClineMessage` |
| 聊天视图 | `webview-ui/src/components/chat/ChatView.tsx` | `ChatView` |
| 设置界面 | `webview-ui/src/components/settings/ApiOptions.tsx` | `ApiOptions` |

## 附录B：ansteel_agents.py → TypeScript 映射

| Python 函数 | TypeScript 对应 | 文件 |
|------------|----------------|------|
| `load_config()` | `loadAnsteelConfig()` | `config.ts` |
| `get_role_config()` | `AnsteelDiscussionManager.getHandler()` | `ansteel.ts` |
| `make_model()` | `new AnsteelRoleHandler()` | `ansteel.ts` |
| `create_agent()` | `buildRoleSystemPrompt()` | `prompts.ts` |
| `call_agent()` | `DiscussionOrchestrator.runAgentTurn()` | `DiscussionOrchestrator.ts` |
| `run_discussion()` | `DiscussionOrchestrator.run()` | `DiscussionOrchestrator.ts` |
| `read_file()` 工具 | Cline 原生 `read_file` | `ToolExecutor.ts` |
| `grep_code()` 工具 | Cline 原生 `search_files` | `ToolExecutor.ts` |
| `run_command()` 工具 | Cline 原生 `execute_command` | `ToolExecutor.ts` |
| `read_memory()` 工具 | `ansteel_read_memory` | `ToolExecutor.ts` |
| `save_memory()` 工具 | `ansteel_save_memory` | `ToolExecutor.ts` |
| `search_history()` 工具 | `ansteel_search_history` | `ToolExecutor.ts` |
| `scan_project_structure()` | `autoDetectProjectProfile()` | `AnsteelMemory.ts` |
| `auto_build_project_profile()` | `autoDetectProjectProfile()` | `AnsteelMemory.ts` |

---

## 十五、最终实施状态（2026-07-22 更新）

### 编译状态
| 检查项 | 状态 |
|--------|------|
| tsc --noEmit (src/) | 0 错误 |
| esbuild | 构建成功 |
| tsc -b (webview-ui) | 0 错误 |
| vite build (webview-ui) | 4.86MB |
| npm run protos | 15个proto文件 |

### 使用方法
1. 在 VS Code 中打开 F:\cline-v3
2. 按 F5 启动调试
3. 在新窗口中打开项目（如 F:\温控）
4. 在 Cline 面板底部切换到「讨论」模式
5. 输入议题，自动执行3轮讨论
6. 讨论记录保存到 .ansteel/discussions/

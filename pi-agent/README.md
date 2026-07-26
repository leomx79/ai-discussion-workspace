# Pi Agent Harness 与鞍钢治理扩展

本仓库以 [Pi Agent Harness](https://pi.dev) 为底座，提供可扩展的终端编码智能体，并在 `packages/coding-agent` 中加入了鞍钢宪法式多角色工程治理能力。

它解决的不是“让更多模型同时回答”这一件事，而是把工程讨论中的证据、质疑、修订、验证、任务所有权和交付证据变成可检查的状态与记录。

上游 Pi 负责模型接入、会话、工具调用、CLI 和扩展机制；本仓库的鞍钢扩展基于这些原生能力实现，不替换 Pi 的智能体循环。

## 项目导图

[在 XMind 中打开完整运作原理图](https://app.xmind.com/jumpto/chatgpt-generated-content/mXCeINBApEzi?utm_source=ChatGPT)

```mermaid
flowchart TB
    User[用户与项目目录] --> Pi[Pi Coding Agent]
    Pi --> Models[多提供商模型与认证]
    Pi --> Tools[原生工具与扩展]
    Pi --> Review[pi --ansteel\n退出式治理审查]
    Pi --> Team[/ansteel-team\n持续协作与受控交付]

    Review --> RolesA[TL / Staff / QA\n独立调查与双向质疑]
    RolesA --> Ledger[协调器计算的挑战台账]
    Ledger --> Signoff[修订、独立验证、共识、双会签]
    Signoff --> Report[.pi/ansteel-reports\n完整审查报告]

    Team --> RolesB[三份持久角色会话]
    RolesB --> Task[任务声明与精确文件所有权]
    Task --> Evidence[真实测试与冻结 Git diff]
    Evidence --> Peer[两名非所有者独立评审]
    Peer --> State[.pi/ansteel-team\n状态与哈希事件账本]
```

## 适用场景

- 使用 Pi 在代码库中进行交互式分析、编码、测试和会话管理。
- 对一个方案、改动或项目执行证据优先的三角色工程审查。
- 让三名持续工作的角色协作交付代码，并强制任务声明、测试证据和同行会签。
- 接入 OpenAI、Anthropic、Google、OpenAI 兼容服务、本地模型或其他 Pi 支持的提供商。

不适用场景：把模型结论当作事实、把不同模型名称当作已证明的真实后端隔离，或把审查通过误解为代码已经合并、发布或完成业务验收。

## 系统组成

| 组件 | 位置 | 职责 |
|---|---|---|
| `pi-ai` | `packages/ai` | 统一模型 API 与提供商适配。 |
| `pi-agent-core` | `packages/agent` | 智能体会话、工具调用循环、状态与中止控制。 |
| `pi-coding-agent` | `packages/coding-agent` | 终端 CLI、交互界面、RPC、内置工具与扩展。 |
| 鞍钢审查核心 | `packages/coding-agent/src/core/ansteel-discussion.ts` | 三角色审查、挑战台账、不可变共识和报告。 |
| 鞍钢团队扩展 | `packages/coding-agent/src/extensions/ansteel-team/` | 持久角色会话、受控任务交付与同行评审。 |
| 团队状态机 | `packages/coding-agent/src/core/ansteel-team.ts` | 任务、测试、Git diff、评审和哈希事件账本。 |

## 两条运行路径

### 1. 非交互治理审查：`pi --ansteel`

该模式针对“这个方案或变更是否经得起工程审查”。它有边界、结束后退出，并生成 Markdown 报告。

```text
独立调查
  -> 独立交叉质疑
  -> 逐条修订
  -> 独立验证
  -> TL 共识
  -> Staff 最终会签
  -> QA 最终会签
  -> 批准或拒绝归档
```

三名治理角色固定为 Tech Lead、Staff Engineer、QA Engineer。协调器负责调度、门禁和归档，不是第四个审查者，也不参与会签。

运行时，三名角色首先独立调查，不读取彼此当轮结论；随后独立质疑同一组工作卡。问题必须使用 `ISSUE: <ID> | TARGET: <role>`，被质疑者必须使用 `RESOLUTION: <ID> | RESOLVED` 回应。验证阶段只有精确的 `VERDICT: APPROVE` 才能通过；带新问题的 `VERDICT: REJECT` 进入下一轮修订，最多两轮。

每个角色阶段都有总墙钟超时，默认 120 秒。缺少角色、模型配置重复、模型不可用、工具超预算、格式不合格、超时或遗漏台账都会失败关闭并归档，而不是静默放行。

重要边界：该模式的报告即使 `Governance result: APPROVED`，`Delivery result` 仍为 `NOT_DELIVERED`。审查通过只能说明治理流程通过，不代表实现已经完成。

### 2. 交互团队交付：`/ansteel-team`

该模式用于真实项目工作。它为 TL、Staff、QA 各保留一个 Pi 会话，角色私有历史不互相暴露，宿主时间线仅显示公开更新和可审计事件。

```text
/ansteel-team start <议题>
  -> 三方独立调查
  -> 公开交叉质疑
  -> /ansteel-team ask <协作问题>
  -> 受控任务声明、修改、测试、评审
  -> /ansteel-team stop
```

`start` 新建或恢复团队；新团队先完成独立调查与交叉质疑。`ask` 让三个角色带着各自私有会话和同一份公开台账继续协作。`stop` 释放在内存中的角色会话，但保留状态以便后续恢复。

团队状态保存在项目目录下：

```text
.pi/ansteel-team/
  team.json      # 角色、任务权限、任务、测试、提交与评审状态
  events.jsonl   # 追加式公开事件账本，带顺序与 SHA-256 哈希链
  sessions/      # 三个角色的持久会话记录
```

恢复时会检查已持久化的角色模型和任务所有权策略；配置变更不会被悄悄套用。若上次宿主中断时角色仍为 `working`，系统先把它记录为失败，避免把未完成阶段伪装成成功。

## 交互式代码变更门禁

默认只有 Staff Engineer 可以承担代码变更任务，TL 和 QA 仍保留完整的质疑与评审职责。项目可通过 `teamTaskOwners` 显式调整这一策略。

1. **声明任务**：所有者调用 `ansteel_claim_task`，提供唯一 `TASK-...`、精确的项目相对文件、描述和验收标准。
2. **隔离写入**：仅任务所有者可通过 `edit` 或 `write` 修改已声明的精确文件。未声明路径、他人路径、`.pi` 治理目录和已提交任务都会被阻断。
3. **执行真实测试**：所有者调用 `ansteel_submit_change`。系统只接受受限的单条测试或检查命令，记录真实 stdout、stderr、退出结果和时间。
4. **冻结证据包**：成功测试后，系统在 Git worktree 中捕获仅属于声明文件的非空 diff，形成不可变 revision 证据包。
5. **独立同行评审**：两名非所有者并发接收相同的测试输出与 diff，彼此看不到当轮评审。各自必须调用 `ansteel_review_task` 给出 `approve` 或附带具体问题的 `reject`。
6. **状态转换**：两票 `approve` 才会把任务变为 `approved`；任一 `reject` 立即变为 `revision-required`，所有者必须重新修改、测试、提交和评审。

直接 `bash` 在团队会话中仅允许单条只读检查，不能绕过写入或测试门禁。没有成功测试、没有 Git diff、没有完整双评审，就不会获得交付批准。

## 挑战台账与可信度

### 机械台账，而不是模型自报数字

协调器从合格的 `ISSUE`、`RESOLUTION` 和验证结果计算挑战台账。共识和最终会签阶段会注入同一份不可变摘要，最终报告也由协调器计算数字。

如果模型在共识中声称错误的已解决、开放或总问题数量，审查结果为 `invalid-ledger-summary`。这条规则用于防止“所有 12 个问题都已解决”之类没有事实依据的模型自述通过门禁。

### 证据分级

| 级别 | 含义 | 处理方式 |
|---|---|---|
| `L1` | 已验证 | 给出文件、命令输出、测试结果或权威来源。 |
| `L2` | 高可信 | 说明技术依据，但不伪装为已验证。 |
| `L3` | 待验证 | 说明未知点与下一步验证方法。 |
| `L4` | 存疑或未知 | 明确承认不确定，不能转写为结论。 |

系统保证的是流程和证据边界，不保证模型或测试永远正确。不同的 `provider/model` 配置标识也只证明配置不同，不能证明真实后端、端点或模型一定不同；报告会明确标记这种限制。

## 快速开始

### 安装或从源码运行

Pi 的发布包可通过 npm 安装：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
cd /path/to/your-project
pi
```

从本仓库源码运行时，要求 Node.js `>= 22.19.0`：

```powershell
npm install --ignore-scripts
.\pi-test.ps1
```

Windows 需要可用的 Bash。通常安装 Git for Windows 即可；详见 [Windows 配置](packages/coding-agent/docs/windows.md)。

### 配置模型

启动 Pi 后使用 `/login` 进行订阅或 API Key 登录，或按 [提供商文档](packages/coding-agent/docs/providers.md) 配置环境变量。自定义 OpenAI 兼容端点、本地模型与代理请见 [自定义模型](packages/coding-agent/docs/models.md)。

在被审项目中创建 `.pi/ansteel.json`，为三名角色配置模型：

```json
{
  "roles": {
    "tech-lead": { "model": "provider-a/model-a" },
    "staff-engineer": { "model": "provider-b/model-b", "thinkingLevel": "high" },
    "qa-engineer": { "model": "provider-c/model-c" }
  },
  "stageTimeoutMs": 120000,
  "maxToolCallsPerStage": 8,
  "teamTaskOwners": ["staff-engineer"],
  "allowSingleModel": false
}
```

凭据不要写入 `.pi/ansteel.json`，应使用 Pi 的认证存储、环境变量或提供商配置。完整字段、工具权限和恢复语义见 [鞍钢治理文档](packages/coding-agent/docs/ansteel.md)。

### 启动审查或团队

```bash
# 一次性治理审查：输出阶段进度、完整报告和结果
pi --ansteel "审查这个电机安全改动"
```

```text
# 进入 pi 交互界面后
/ansteel-team start 审查并实现电机安全改动
/ansteel-team ask 列出下一项可安全交付的任务与验收条件
/ansteel-team status
/ansteel-team stop
```

## 可观测性与验证

非交互审查会在标准错误输出阶段状态：`role / stage started|completed|failed|timed out`，并把完整转录写入：

```text
.pi/ansteel-reports/ansteel-<UTC 时间>-<主题>.md
```

仓库为治理和交付关键点提供确定性回归：

- `ansteel-cli.test.ts`：通过真实 CLI 边界验证错误台账数字会拒绝为 `invalid-ledger-summary`。
- `ansteel-team-cli.test.ts`：通过真实 RPC 子进程、确定性提供商和角色工具验证默认任务所有权；测试等待持久化完成态，而不把 RPC 预检响应误当作命令完成。
- `ansteel-team.test.ts`：验证任务、测试证据、Git diff、双评审、状态迁移和哈希账本。
- `ansteel-team-extension.test.ts`：验证会话启动、超时、恢复、提交后双评审和宿主绕过阻断。

确定性测试证明机制边界；真实提供商运行还应使用小议题观察模型可用性、工具调用、超时和报告，二者不能互相替代。

## 常用文档

| 主题 | 文档 |
|---|---|
| Pi 快速开始与基础交互 | [Quickstart](packages/coding-agent/docs/quickstart.md) |
| 鞍钢审查与团队交付 | [Ansteel](packages/coding-agent/docs/ansteel.md) |
| 模型与认证提供商 | [Providers](packages/coding-agent/docs/providers.md) |
| 自定义模型与 OpenAI 兼容服务 | [Custom models](packages/coding-agent/docs/models.md) |
| 扩展、技能和包 | [Extensions](packages/coding-agent/docs/extensions.md) / [Skills](packages/coding-agent/docs/skills.md) / [Packages](packages/coding-agent/docs/packages.md) |
| JSON 与 RPC 集成 | [JSON mode](packages/coding-agent/docs/json.md) / [RPC](packages/coding-agent/docs/rpc.md) |
| 安全与容器化 | [Security](packages/coding-agent/docs/security.md) / [Containerization](packages/coding-agent/docs/containerization.md) |
| 会话与上下文 | [Sessions](packages/coding-agent/docs/sessions.md) / [Compaction](packages/coding-agent/docs/compaction.md) |

## 开发与安全

```bash
npm install --ignore-scripts
npm run build
npm run check
./test.sh
```

Pi 默认以启动它的用户权限访问文件、进程和网络。对于不可信项目或高风险工具，请使用 [Gondolin 扩展、Docker 或 OpenShell](packages/coding-agent/docs/containerization.md) 建立隔离边界。把 Git 提交或其他可恢复检查点作为日常工作流的一部分。

依赖与发布安全策略见根目录 `.npmrc`、`package-lock.json`、`AGENTS.md` 和 `scripts/`。贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 上游与许可

Pi 是开源项目；上游文档与演示见 [pi.dev](https://pi.dev)，本仓库保留其原有包结构与许可。许可证见 [LICENSE](LICENSE)。

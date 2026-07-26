# AI 群讨论工作区

这是一个私有整合工作区，用于研究、实现和验证“鞍钢宪法式”多智能体工程讨论与受控交付。

工作区不是单一应用：它同时保存当前主产品、端到端验证夹具、Kilo 集成模板、第三方对照实现，以及早期方案和讨论记录。当前主线产品是 [`pi-agent/`](pi-agent/)。

## 工作区全景

```mermaid
flowchart TB
    Root[AI 群讨论工作区] --> Product[pi-agent\n当前主产品]
    Root --> Fixtures[ansteel-e2e-*\n验证夹具]
    Root --> Kilo[kilo-ansteel-template\nKilo 集成模板]
    Root --> References[_ref_*\n对照实现]
    Root --> History[根目录脚本与历史资料]

    Product --> Review[pi --ansteel\n退出式治理审查]
    Product --> Team[/ansteel-team\n持续团队交付]
    Fixtures --> Deterministic[确定性 CLI、RPC、状态机回归]
    Fixtures --> Live[真实提供商小议题运行]

    Review --> Reports[.pi/ansteel-reports\n完整审查报告]
    Team --> Delivery[任务声明、测试、Git diff、双评审]
    Deterministic --> Evidence[可重复的机制证据]
    Live --> Runtime[一次真实运行的可观测证据]
```

> [在 XMind 中打开工作区全景导图](https://app.xmind.com/jumpto/chatgpt-generated-content/apUfIO1nUDG7?utm_source=ChatGPT)。该图与本页 Mermaid 总览和下文目录结构保持一致。

## 这个工作区解决什么问题

- 让多角色工程讨论具备可追溯的证据、质疑、修订和会签，而不是多个模型各自给出不可核验的意见。
- 把“审查通过”和“代码已交付”分开记录，避免用模型结论替代实现与测试事实。
- 在真实项目中限制写入权、测试路径和同行评审，防止角色绕过任务边界直接修改代码。
- 用确定性测试验证 CLI、RPC 和报告边界，再用小范围真实提供商运行验证实际可用性。

系统不承诺模型、测试或多角色讨论一定正确。它提供的是失败关闭的流程、可定位的证据和明确的未知项。

## 目录说明

| 目录或文件组 | 作用 | 是否为当前主线 |
|---|---|---|
| [`pi-agent/`](pi-agent/) | Pi Agent 源码；鞍钢治理核心位于 `packages/coding-agent/`。 | 是 |
| [`ansteel-e2e-algorithm/`](ansteel-e2e-algorithm/) | 算法题与多角色讨论验证夹具。 | 验证 |
| [`ansteel-e2e-dynamic-connectivity/`](ansteel-e2e-dynamic-connectivity/) | 动态连通性算法实现、随机化和性能验证夹具。 | 验证 |
| [`ansteel-e2e-negative-cycle/`](ansteel-e2e-negative-cycle/) | 负环相关的失败关闭与审查案例。 | 验证 |
| [`ansteel-e2e-owner-policy/`](ansteel-e2e-owner-policy/) | 默认任务所有权策略的端到端夹具。 | 验证 |
| [`ansteel-e2e-owner-policy-qwen-qa/`](ansteel-e2e-owner-policy-qwen-qa/) | 替换 QA 角色模型后的配置与行为实验。 | 验证 |
| [`ansteel-e2e-team-timeout/`](ansteel-e2e-team-timeout/) | 交互团队角色阶段超时、失败记录和恢复边界。 | 验证 |
| [`ansteel-e2e-real-glm-gpt/`](ansteel-e2e-real-glm-gpt/) | 真实提供商审查的运行夹具与报告位置。 | 验证 |
| [`kilo-ansteel-template/`](kilo-ansteel-template/) | Kilo Code 中的鞍钢讨论集成模板。 | 并行集成 |
| [`_ref_crewai_debate/`](_ref_crewai_debate/)、[`_ref_llm_discussion/`](_ref_llm_discussion/)、[`_ref_local_debate/`](_ref_local_debate/) | 第三方或本地讨论实现，用于能力和设计对照。 | 参考 |
| [`docs/legacy/`](docs/legacy/) | 早期设计方案、配置指南、讨论记录和解决方案归档。 | 历史资料 |
| 根目录兼容脚本 | `ansteel_agents.py`、`agent-llm.py`、`ansteel_discussion.py` 和 PowerShell 桥接脚本；保留以兼容旧工作流。 | 历史入口 |

## 当前主产品：`pi-agent`

`pi-agent` 保留 Pi 的原生模型接入、会话、工具调用、终端 CLI、扩展和 RPC；鞍钢能力建立在这些原生机制上，而不是另造一个智能体循环。

产品级入口、架构图和快速开始见 [pi-agent 中文 README](pi-agent/README.md)。协议和字段细节见 [鞍钢治理文档](pi-agent/packages/coding-agent/docs/ansteel.md)。

### 路径 A：退出式治理审查

```text
pi --ansteel "审查议题"
  -> TL / Staff / QA 独立调查
  -> 独立交叉质疑与挑战台账
  -> 逐条修订与独立验证
  -> TL 共识
  -> Staff、QA 对同一不可变共识最终会签
  -> 生成批准或拒绝报告后退出
```

该路径用于判断方案或改动是否经得起治理审查。报告中的 `Governance result` 只说明门禁结果；`Delivery result` 固定为 `NOT_DELIVERED`，因为该命令不执行项目交付。

### 路径 B：持续团队交付

```text
/ansteel-team start <议题>
  -> 三个持久角色会话进行独立调查和公开交叉质疑
  -> /ansteel-team ask <协作问题>
  -> 任务声明、受控修改、真实测试、冻结 diff、双同行评审
  -> /ansteel-team stop
```

该路径用于真实编码工作。默认仅 Staff Engineer 可声明变更任务；TL 和 QA 负责独立评审，QA 有可追溯的退回权。状态保存于被审项目的 `.pi/ansteel-team/`，包括 `team.json`、角色会话和带 SHA-256 哈希链的 `events.jsonl`。

## 核心治理与交付门禁

### 审查门禁

- 角色固定为 Tech Lead、Staff Engineer、QA Engineer；协调器不作为第四个会签角色。
- 三个角色默认必须使用不同的 `provider/model` 配置标识；模型缺失、重复、无法解析或未认证时拒绝开始，不回退到当前模型。
- 每条质疑使用 `ISSUE: <ID> | TARGET: <role>`；回应使用 `RESOLUTION: <ID> | RESOLVED`；审批使用精确的 `VERDICT: APPROVE`。
- 验证拒绝必须附带新的问题。格式错误、遗漏问题、超时、工具超预算或会签缺失都会失败关闭。
- 协调器计算不可变挑战台账摘要；模型在共识中编造错误的台账数字会被拒绝为 `invalid-ledger-summary`。

### 交付门禁

1. 所有者用 `ansteel_claim_task` 声明唯一 `TASK-...`、精确文件、描述和验收标准。
2. 只有所有者可用 `edit` 或 `write` 修改这些精确文件；未声明路径、他人路径和 `.pi` 治理文件均被阻断。
3. 所有者用 `ansteel_submit_change` 运行允许的单条测试或检查命令；系统记录真实输出和退出状态。
4. 系统从 Git worktree 冻结只包含声明文件的非空 diff，形成 revision 证据包。
5. 两名非所有者收到相同证据并独立调用 `ansteel_review_task`。两票批准才会交付；任一拒绝使任务回到 `revision-required`。

### 可信度与限制

| 事实等级 | 含义 |
|---|---|
| `L1` | 已验证，必须能定位到文件、命令输出、测试结果或权威来源。 |
| `L2` | 有技术依据但未即时验证，不能伪装为事实。 |
| `L3` | 待验证，必须说明下一步验证方法。 |
| `L4` | 未知或存疑，不能转写为结论。 |

不同的配置标识不等于已经证明真实后端、端点或模型不同；测试通过也不等于现实系统绝对正确。确定性回归与真实提供商运行分别证明不同层次的事情，不能互相替代。

## 推荐工作流

### 1. 先确认目标位置

- 产品功能、协议、CLI 或扩展改动：进入 [`pi-agent/`](pi-agent/)。
- 验证特定边界或算法题：进入对应的 `ansteel-e2e-*` 夹具。
- 对照其他实现：阅读 `_ref_*`，不要把它们误认为当前产品代码。
- 查找早期设计依据：使用根目录的方案、讨论记录和回测报告，但以主产品当前源码与测试为准。

### 2. 修改后先做确定性验证

从 `pi-agent/packages/coding-agent/` 执行与改动相关的测试。对于治理与交付边界，优先保留或补充真实 CLI/RPC 子进程回归，而不是只依赖 mock。

当前关键覆盖包括：

- `ansteel-cli.test.ts`：错误共识台账数字必须得到 `invalid-ledger-summary`。
- `ansteel-team-cli.test.ts`：真实 RPC 子进程、确定性提供商和角色工具调用下的默认任务所有权。
- `ansteel-team.test.ts`：状态、哈希账本、任务、测试、Git diff 和评审状态机。
- `ansteel-team-extension.test.ts`：会话、超时、恢复、提交后双评审与宿主绕过阻断。

### 3. 再做真实提供商验证

选择小而可观察的议题运行 `pi --ansteel` 或 `/ansteel-team`，观察阶段监控、工具调用、报告、台账和失败原因。一次真实成功只证明该次路径可运行，不应覆盖确定性回归所验证的机制边界。

### 4. 提交与归档

- 源码、夹具、设计文档和可复现测试可以提交。
- 依赖、构建产物、缓存、`.pi` 运行态、日志、API Key 和本机模型配置不得提交。
- 提交前先确认工作区状态，只暂存本次实际修改的文件。

## Git 与本地状态边界

`F:\codex\ai群讨论` 是唯一的根 Git 仓库，远端为私有仓库。此前嵌套项目的 `.git` 元数据已在整合时移出工作区保存历史备份；不要在子目录重新初始化 Git，否则会重新拆分工作区的提交边界。

[`.gitignore`](.gitignore) 明确排除：

```text
node_modules/、dist/、build/、缓存、Python 字节码
.pi/、.ansteel/、.kilo/、日志
.env、llm-config.json、model-config.ps1 等本机凭据或配置
```

因此，真实运行报告若需长期保存，应先脱敏并明确其证据用途，再决定是否另行纳入版本控制。

## 快速入口

| 需求 | 入口 |
|---|---|
| 理解主产品与鞍钢机制 | [pi-agent/README.md](pi-agent/README.md) |
| 查看审查与团队命令、配置和报告语义 | [docs/ansteel.md](pi-agent/packages/coding-agent/docs/ansteel.md) |
| 从源码启动 Pi | [pi-agent/pi-test.ps1](pi-agent/pi-test.ps1) |
| 配置模型、代理或本地 OpenAI 兼容服务 | [docs/models.md](pi-agent/packages/coding-agent/docs/models.md) |
| 配置认证与提供商 | [docs/providers.md](pi-agent/packages/coding-agent/docs/providers.md) |
| 查看早期架构判断 | [pi-agent-analysis.md](docs/legacy/design/pi-agent-analysis.md) |
| 查看历史方案演进 | [鞍钢宪法式AI防幻觉讨论方案_V6.md](docs/legacy/design/鞍钢宪法式AI防幻觉讨论方案_V6.md) |

## 许可证与来源

`pi-agent/` 基于 Pi Agent Harness，保留其开源许可和上游结构。其他目录有各自的来源与用途；引用第三方对照项目时应遵守其原始许可证。

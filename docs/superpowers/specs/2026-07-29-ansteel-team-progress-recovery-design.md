# Ansteel Team 进展驱动恢复设计

## 背景与根因

真实耐久租约队列探针运行约 28 分 40 秒，最终为 `stopped / task-missing`。公开测试
`0/10`、隐藏测试 `0/6`，实现文件仍是 `NOT_IMPLEMENTED` 桩。事件链本身连续且哈希有效，
因此问题不是账本损坏、Bash 缺失或写入门禁误拦截。

Staff Engineer 三个阶段都以 `stopReason: length` 结束，只产生被截断的思考内容，没有公开文本，
也没有调用 `ansteel_claim_task`、`edit`、`write` 或 `ansteel_submit_change`。当前原始轮次适配器把
`length` 当作正常结束并返回空字符串，团队扩展随后把空字符串写成普通 `role-report`。同时，
任务存在与否完全依赖模型主动调用认领工具，所以协调器最终只能看到 `tasks: []`。

## 方案比较

### 方案一：只更换 Staff 模型

优点是改动小，并能在替代模型通过工具调用 canary 时绕过当前 provider 的长思考行为。缺点是没有修复协调器误判，另一个模型
出现截断或空输出时仍会重现；配置的模型名也不能证明后端实际模型身份。

### 方案二：只把截断改成失败

优点是 fail-closed 结果更准确，不会再把空输出写成正常报告。缺点是只能把 `task-missing` 改写为
显式角色失败，仍不能确定性创建任务，也不能支持需要多个阶段的长时间编码工作。

### 方案三：截断识别、协调器任务入口和进展驱动 epoch

这是采用的方案。协调器先以结构化输入登记任务，任务所有者只负责真实实现；每个实现 epoch
从隔离上下文开始，只依据工具和持久状态判断进展。截断可以恢复，但纯思考不能获得无限续期。
该方案保持三角色评审和写入门禁不变，同时消除任务创建对模型自觉行为的依赖。

## 命令与状态

新增命令：

```text
/ansteel-team task {"id":"TASK-ID","owner":"staff-engineer","files":["src/file.ts"],"description":"...","acceptanceCriteria":"...","dependsOn":[]}
```

协调器解析 JSON 后调用现有任务校验和文件所有权逻辑。成功后：

1. 任务以现有 `claimed` 状态登记，只有配置允许的 owner 能写入精确文件集合。
2. 账本追加 `task-assigned`，actor 为 `coordinator`，`targetRole` 为任务 owner。
3. 协调器直接进入 owner 的任务 epoch，不要求 Tech Lead 或模型先用自然语言重建任务。

已存在且尚未批准的任务可用以下命令恢复：

```text
/ansteel-team task TASK-ID
```

`coordinator` 只可作为 `task-assigned` 的事件 actor，不构成第四个评审或会签角色。任务提交后仍由
另外两个角色分别检查同一不可变 diff 和测试证据。

## 角色轮次完整性

`createAnsteelRawTurnSession` 必须把以下情况作为阶段失败：

- 最后一条 assistant message 的 `stopReason` 为 `length`；
- provider 明确返回错误；
- 本轮没有任何非空公开文本。

失败原因只包含稳定错误码或安全描述，不记录私有思考内容。普通调查阶段把这些情况写为
`role-failure`，不得写为 `role-report`，角色状态保持 `failed`。

团队角色的每个提示都从空对话分支开始。旧消息继续保存在 append-only session JSONL 中用于审计，
但不再自动进入下一阶段上下文；跨阶段事实通过公开账本、任务状态和当前文件重新注入。这避免连续
截断内容污染后续实现 epoch。

## 进展驱动任务 epoch

每个任务 epoch 使用现有 `stageTimeoutMs` 作为单轮上限，并使用新增配置：

```json
{
  "teamTaskMaxEpochs": 8,
  "teamTaskMaxNoProgressEpochs": 2
}
```

两个字段均为可选正整数。`teamTaskMaxEpochs` 范围为 `1..128`，默认 `8`；
`teamTaskMaxNoProgressEpochs` 范围为 `1..8`，默认 `2`，且不能大于最大 epoch 数。

协调器在每轮前后计算任务进展指纹，指纹包括：

- 状态和 revision；
- 测试证据数、提交数和评审数；
- 精确任务文件的 Git diff SHA-256。

任一字段变化才算进展。读取文件、输出长分析或重复相同工具请求不算进展。

- 截断但指纹变化：记录 `role-failure/output-truncated`，开启新隔离 epoch。
- 正常公开输出且指纹变化：记录 `role-report`，继续到任务终态。
- 指纹不变：连续无进展计数加一。
- 达到连续无进展上限：停止任务循环，记录 `role-failure/owner-no-progress`。
- 达到最大 epoch：停止并记录 `role-failure/task-epoch-limit`。
- `approved`：任务成功终止。
- `revision-required`：owner 收到最新评审问题并进入下一实现 epoch。

任务循环停止不伪造批准，也不删除已有 diff、测试证据或角色 session。

## 提示边界

任务 owner 每轮只接收：

- 任务 ID、精确文件、依赖、描述和验收条件；
- 当前状态、revision 和最新评审问题；
- 明确动作顺序：检查当前文件，修改已授权文件，通过 `ansteel_submit_change` 提交；
- 禁止把公开说明当成交付，必须产生受控状态变化。

不注入完整通用讨论账本，避免与实现无关的角色文本膨胀上下文。独立评审仍使用现有不可变证据包。

## 测试与证明

自动化回归必须覆盖：

1. `stopReason: length` 被拒绝，不能返回空成功文本。
2. 空 assistant 输出被拒绝。
3. 协调器任务命令登记唯一任务和 `task-assigned` 事件。
4. 非法 owner、重复任务、越界文件和错误 JSON 继续 fail-closed。
5. 只有任务指纹变化才能获得下一 epoch。
6. 连续无进展和最大 epoch 都能有界停止。
7. 截断但已有文件进展时可以用新隔离 epoch 恢复。
8. 真实 RPC CLI 能完成 `task-assigned -> task-submitted -> 双评审` 的确定性夹具。

最后重新运行原耐久租约队列探针。证明分为两层：

- 产品缺陷证明：不得再出现空 `role-report` 或 `task-missing`；截断、无进展和任务状态必须机械可见。
- 编码能力证明：只有真实 Staff 产生受控 diff、公开和隐藏测试通过、两名非 owner 独立批准时才算通过。
  若 provider 仍失败，应准确归档为角色/provider 失败，不得把产品门禁正确性冒充为编码成功。

## 非目标

- 不重写现有批量 `/ansteel` epoch supervisor。
- 不根据模型文字自动延长预算。
- 不静默更换 provider/model 或自动转移任务 owner。
- 不降低测试、Git diff、文件所有权或双评审门禁。

## 真实探针反馈：只读工具预算必须接入交互团队

第一轮修复后的新隔离探针已经消除了原故障：coordinator 确定性创建了 `TASK-LEASE-QUEUE`，事件中不再出现空
`role-report` 或 `task-missing`，两个截断 owner epoch 最终机械归档为 `owner-no-progress`。但是 Staff 在每个
epoch 中仍重复执行 `ls/read/find/bash`，分别消耗约 8 到 14 个只读调用，直到 provider 以 `length` 结束；没有
调用 `edit`、`write` 或提交工具，目标文件仍为 `NOT_IMPLEMENTED`。

根因是现有 `maxToolCallsPerStage` 只用于批量治理流程，交互团队 session 没有消费这个已经解析的配置。最终方案
因此补充以下约束：

- 每个隔离团队 prompt 重置一次只读工具计数，默认使用现有 `maxToolCallsPerStage = 4`；
- `read`、`grep`、`find`、`ls` 和合法的只读 `bash` 消耗预算；
- `edit`、`write` 和 Ansteel 结构化任务工具不消耗只读预算；
- 达到预算后拒绝继续扫描，owner prompt 要求先在受控文件留下语法有效的 Git diff checkpoint；
- 非 owner 角色在预算耗尽后只能发布简洁的证据结论，不能通过更多扫描无限延长阶段。

该约束不是把任意工具调用当成进展。只有任务状态和精确文件 diff 指纹变化才能获得下一个 owner epoch；只读预算
只是确保有限工具被用于从调查转向可恢复实现。

## 最终根因闭环

后续隔离探针又暴露出三条相互独立的故障链，必须分别处理，不能只靠增加总超时：

1. **GLM 返回空公开文本。** 两个自定义 GLM provider 的模型元数据没有正确声明思考协议，单轮的 16384
   token 被隐藏 thinking 消耗，最终没有可发布文本。运行环境中的模型配置已分别声明 `reasoning: true`，
   并按接口使用 `thinkingFormat: qwen` 或 `thinkingFormat: zai`，同时把模型输出上限设置到 provider
   支持的范围。该修复属于本机 provider 元数据，不写入仓库，也不在文档或事件中保存凭据。
2. **角色读取协调器自身证据。** 角色曾读取 `.pi/ansteel-team/team.json`、历史报告和自己的 session，
   造成自引用、上下文膨胀及错误的任务认知。团队工具现在复用审查证据策略，并额外隔离
   `.pi/ansteel-team`、`.pi/ansteel-reports`、`.pi/ansteel-runs`、`.pi/ansteel-memory`、`.git`
   和 `node_modules`；普通项目源码、测试和受控 Git diff 仍可读取。
3. **角色抢先创建任务。** Staff Engineer 曾在 coordinator 注册任务前调用 `ansteel_claim_task`，
   形成两个不同任务争用同一文件。交互角色的可用工具集合不再暴露该工具；只有
   `/ansteel-team task <JSON>` 能创建任务，`/ansteel-team task TASK-ID` 只恢复已存在任务。

这三项修复与进展驱动 epoch 的关系是：provider 元数据保证模型能结束一轮，证据隔离保证有限上下文只用于项目
事实，coordinator-only 入口保证只有一条任务主线，而只读预算和任务指纹决定是否允许继续下一个 epoch。运行几
个小时的真实工作由多个有界、可恢复 epoch 组成；任何单轮仍受超时和工具上限约束，只有受控 diff、任务状态、
测试提交或评审计数发生变化才获得续跑资格。

## 最终真实 Canary 结果

2026-07-29 的全新隔离项目使用三个彼此不同的显式 `provider/model`：

- Tech Lead：`qwen-token-plan-cn/glm-5.2`
- Staff Engineer：`micuapi/gpt-5.5`
- QA Engineer：`volcengine-agent-plan/glm-5.2`

协调器只创建了 `TASK-LEASE-QUEUE`，owner 为 Staff Engineer。Staff 实际调用了 `edit` 四次和
`ansteel_submit_change` 一次，只修改探针项目的 `src/lease-queue.mjs`；提交时 `npm test` 为
`10/10`。Tech Lead 与 QA Engineer 随后分别调用一次 `ansteel_review_task`，共同批准 revision 1，
团队最终状态为 `stopped`，任务状态为 `approved`。

独立 Oracle 另外执行了 6 项未向角色公开的 DAG、并发幂等、租约过期、重复恢复、尾部损坏和失败依赖测试，
结果为 `6/6`。证据审计确认 13 条事件连续、SHA-256 链有效、链头与 `team.json` 一致、下一事件序号正确，
三个 session 均无 JSON 解析错误，且进程结束后没有遗留 `run-team-probe.mjs`。这证明的是交互团队能在真实
provider、真实工具、受控 Git diff、真实测试和双评审门禁下完成一次代码任务；它不把模型标识当作事实正确性
证明，也不把临时探针实现混入产品仓库。

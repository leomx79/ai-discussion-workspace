# Ansteel Team 独立验证与最终交付状态设计

> 状态说明：本设计不再作为 Ansteel Team 的主流程设计。新的主线是
> [鞍钢宪法式三 AI 持续协作协议设计](./2026-07-29-ansteel-team-continuous-collaboration-protocol-design.md)。
> 本文保留为持续协作完成后的独立验证与最终交付兜底层，不应再把事后报告、证据包或双审批解释为三 AI
> 协作本身。

## 背景

2026-07-29 的耐久租约队列真实编码探针完成了完整团队流程：

- 初始公开测试为 `0/10`，隐藏 Oracle 为 `0/6`；
- Staff Engineer 修改唯一授权文件并提交 revision 1；
- 提交时公开测试为 `10/10`；
- Tech Lead 与 QA Engineer 均记录 `APPROVE`；
- 任务随即进入 `approved`；
- 流程结束后，外部 Oracle 再运行 6 项隐藏测试并得到 `6/6`。

但额外对抗验证证明生成实现仍有两个确定性缺陷：

1. `clock() + leaseMs` 超出 JavaScript 安全整数范围时，失败操作已经把无效事件写入并
   `fsync`，之后 `recover()` 永久拒绝该日志。
2. canonicalize 使用普通对象和属性赋值，导致合法 JSON payload 的 `__proto__` 键被静默
   丢失。

两个审查者都批准了该 revision，说明当前流程把三种不同事实压缩成了一个 `approved`：

1. owner 自己运行的测试通过；
2. 两个非 owner 审查者同意提交；
3. 独立最终验收证明交付正确。

现有状态机只能机械证明前两项，而且审查者的批准不要求各自提供成功的独立测试证据。隐藏
Oracle 又在 `approved` 之后由外部脚本运行，因此即使 Oracle 失败，产品状态仍会错误地保持
`approved`。

## 目标

本设计只解决以下三个问题：

1. 为耐久租约队列探针增加能复现本次漏检问题的对抗测试。
2. Tech Lead 与 QA Engineer 的批准必须分别绑定自己的真实验证证据。
3. 把治理审批和最终交付验收拆成独立状态，只有最终验收通过才能解锁依赖任务。

完成后，系统必须满足：

- owner 的测试证据不能替代任一审查者的独立验证证据；
- Tech Lead 与 QA Engineer 不能共享一次命令执行结果完成两次批准；
- 双审批只能形成 `governanceStatus: "approved"`；
- 最终检查未运行或失败时，`deliveryStatus` 不能是 `passed`；
- 只有 `workflowStatus: "completed"` 且 `deliveryStatus: "passed"` 的任务才是依赖的
  可用前置任务；
- 所有验证证据必须绑定 task ID、revision 和冻结 diff 的 SHA-256；
- 任何 diff 漂移、命令失败、超时、证据缺失或进程异常都必须 fail-closed。

## 非目标

本设计不同时处理以下事项：

- 全面移除角色的原始 `bash` 工具；
- 为所有编程任务自动生成领域专用对抗测试；
- 证明任意程序在所有输入上都正确；
- 替换现有 provider、模型或任务 owner；
- 重写 milestone 集成流程；
- 把临时探针生成的 `lease-queue.mjs` 提交到产品仓库。

原始 `bash` 的路径逃逸与读写型参数问题需要单独设计。本阶段新增的独立验证不依赖角色
`bash`，而是使用结构化验证工具。

## 方案比较

### 方案一：双审批后重复 owner 的测试

系统在两个审查者批准后再运行一次 owner 的测试命令，然后标记完成。

优点是改动最小。缺点是审查者仍没有独立证据，最终验收也只重复同一覆盖不足的测试，无法发现
本次两个反例。因此不采用。

### 方案二：审查者独立验证、双状态、协调器最终检查

每个审查者必须通过结构化工具独立运行冻结 revision 的测试；双审批后任务进入等待交付状态；
协调器再运行单独声明的最终检查清单。所有检查通过后才完成任务。

该方案直接覆盖用户要求的三个流程缺口，保持现有 owner、冻结 diff 和双评审结构，改动可被现有
单元测试、扩展集成测试和 RPC CLI 测试覆盖，因此采用该方案。

### 方案三：外部隔离验证服务

把最终检查交给容器或远程验证服务，服务返回签名结果。

该方案能提供更强的隐藏测试隔离和资源控制，但需要新的服务部署、密钥管理、制品上传和 Windows
兼容层。它适合作为后续强化，不作为本阶段前置条件。

## 状态模型

### 任务工作流状态

`AnsteelTeamTask.status` 重命名为 `workflowStatus`：

```ts
type AnsteelTeamTaskWorkflowStatus =
  | "blocked"
  | "claimed"
  | "submitted"
  | "revision-required"
  | "awaiting-delivery"
  | "completed";
```

### 治理状态

```ts
type AnsteelTeamTaskGovernanceStatus = "pending" | "approved";
```

`approved` 只表示当前 revision 已获得所有非 owner 审查者的有效批准。每个有效批准必须引用同一
revision 和同一 diff hash 的审查者独立验证证据。

### 交付状态

```ts
type AnsteelTeamTaskDeliveryStatus = "pending" | "running" | "passed" | "failed";
```

`passed` 只表示协调器对当前 revision 执行的最终检查清单全部成功。它不表示数学意义上的完全
正确，只表示声明的机械验收范围已经通过。

### 任务实体

```ts
interface AnsteelTeamTask {
  // 现有 id、owner、files、description、acceptanceCriteria、dependsOn 保持不变
  workflowStatus: AnsteelTeamTaskWorkflowStatus;
  governanceStatus: AnsteelTeamTaskGovernanceStatus;
  deliveryStatus: AnsteelTeamTaskDeliveryStatus;
  revision: number;
  testEvidence: AnsteelTeamTaskTestEvidence[];
  submissions: AnsteelTeamTaskSubmission[];
  verifications: AnsteelTeamTaskVerificationEvidence[];
  reviews: AnsteelTeamTaskReview[];
}

interface AnsteelTeamTaskReview {
  revision: number;
  reviewer: AnsteelRole;
  verdict: "approve" | "reject";
  verificationEvidenceId?: string;
  issue?: string;
  reviewedAt: string;
}
```

version 7 的 `approve` review 必须有 `verificationEvidenceId`；`reject` 不需要成功 evidence。迁移
得到的历史 approve 可以没有该字段，但不能计入当前 governance。

### 状态转换

```text
claimed
  -> submitted
  -> revision-required                   任一审查者拒绝
  -> awaiting-delivery                   两个审查者均独立验证并批准
       governanceStatus = approved
       deliveryStatus = pending
  -> completed                           协调器最终检查全部通过
       governanceStatus = approved
       deliveryStatus = passed
  -> revision-required                   任一最终检查失败或 diff 漂移
       governanceStatus = approved
       deliveryStatus = failed
```

owner 提交下一 revision 时：

- `workflowStatus` 变为 `submitted`；
- `governanceStatus` 重置为 `pending`；
- `deliveryStatus` 重置为 `pending`；
- 旧 revision 的验证、审查和交付证据保留，只是不再能证明新 revision。

任务依赖和 milestone 解锁统一使用：

```ts
task.workflowStatus === "completed" && task.deliveryStatus === "passed"
```

不得再使用“两个审查者已批准”作为依赖解锁条件。

## 冻结 revision

每次提交继续捕获任务精确文件的 Git diff，并新增：

```ts
interface AnsteelTeamTaskSubmission {
  revision: number;
  submittedAt: string;
  diff: string;
  diffHash: string;
  test: AnsteelTeamTaskTestEvidence;
}
```

`diffHash` 为 UTF-8 diff 文本的 SHA-256。验证命令执行前后都重新计算当前任务 diff：

- 执行前不等于 submission `diffHash`：拒绝启动验证；
- 执行后发生变化：本次证据记为失败，禁止批准；
- 只有前后均等于 submission `diffHash` 的结果才可绑定当前 revision。

这样可以阻止审查者验证 A 版本、随后批准 B 版本。

## 审查者独立验证

### 结构化工具

新增角色工具：

```text
ansteel_verify_task
```

参数只有 `taskId`，不允许模型自行选择命令。工具读取当前 submission 中 owner 已成功执行的精确
测试命令，在项目根目录重新独立运行一次，并记录调用者身份。

Tech Lead 和 QA Engineer 必须分别调用该工具。一次执行只能属于一个 reviewer，不能复制、转让或
改写 actor。

### 验证证据

```ts
interface AnsteelTeamTaskVerificationEvidence {
  id: string;
  scope: "review" | "delivery";
  taskId: string;
  revision: number;
  actor: AnsteelRole | "coordinator";
  checkId: string;
  diffHash: string;
  commandHash: string;
  outputHash: string;
  exitCode: number | null;
  timedOut: boolean;
  isError: boolean;
  startedAt: string;
  completedAt: string;
}
```

review scope 的完整命令输出保存在协调器状态目录的受控证据记录中。delivery scope 的完整命令
输出保存在 manifest 所在的项目外验证目录，团队状态只保存哈希和结果。公开事件只写 evidence
ID、revision、actor、diff hash、command hash、output hash 和结果，防止事件账本被超长日志
撑大，也不把隐藏 Oracle 输出写入角色可见项目。

### 审批门禁

`ansteel_review_task({ verdict: "approve" })` 必须机械检查：

1. reviewer 不是 owner；
2. 当前任务为 `submitted`；
3. reviewer 尚未评审该 revision；
4. 存在该 reviewer 自己产生的成功 `scope: "review"` 证据；
5. evidence revision 与当前 revision 相同；
6. evidence diff hash 与 submission diff hash 相同；
7. 验证后当前 diff 仍未变化。

缺少任何一项都拒绝 `APPROVE`。`REJECT` 不要求先成功验证，但必须继续提供具体 issue。

两个 reviewer 均批准后：

- `governanceStatus = "approved"`；
- `workflowStatus = "awaiting-delivery"`；
- `deliveryStatus = "pending"`；
- 账本追加 `task-governance-approved`；
- 不解锁依赖任务。

## 协调器最终验收

新增 coordinator-only 命令：

```text
/ansteel-team verify <TASK-ID> <verification-manifest-path>
```

角色工具列表中不注册该命令。manifest 使用结构化 argv，不经过 Shell 字符串拼接：

```json
{
  "version": 1,
  "taskId": "TASK-LEASE-QUEUE",
  "revision": 1,
  "checks": [
    {
      "id": "public",
      "executable": "npm.cmd",
      "args": ["test"],
      "timeoutMs": 60000
    },
    {
      "id": "oracle",
      "executable": "node.exe",
      "args": ["--test", "C:\\absolute\\oracle\\hidden.test.mjs"],
      "timeoutMs": 60000
    }
  ]
}
```

manifest 必须位于项目根目录之外，规范化后的绝对路径不能落入角色工作目录。驱动只把 manifest
路径传给协调器进程，不通过角色 prompt、角色 session 或团队公开事件传递。

协调器验证以下前置条件：

1. task ID、revision 与 manifest 完全一致；
2. `workflowStatus === "awaiting-delivery"`；
3. `governanceStatus === "approved"`；
4. 当前 diff hash 等于 submission diff hash；
5. check ID 唯一、命令可执行文件在允许列表内；
6. `timeoutMs` 为 `1_000..21_600_000` 的安全整数；
7. 子进程 cwd 固定为项目根；
8. 子进程环境使用白名单，不继承 API Key、token、Oracle 根路径或宿主凭据。

验证开始时：

- `deliveryStatus = "running"`；
- 写入 `task-delivery-started`；
- 每项 check 产生 coordinator 证据。

全部 check 成功且 diff 未变化时：

- `deliveryStatus = "passed"`；
- `workflowStatus = "completed"`；
- 写入 `task-delivery-passed`；
- 重新计算依赖和 milestone。

任一 check 非零退出、超时、无法启动或 diff 漂移时：

- `deliveryStatus = "failed"`；
- `workflowStatus = "revision-required"`；
- 写入 `task-delivery-failed`，内容只含稳定错误码和 evidence ID；
- owner 获得新的实现 epoch；
- 依赖任务保持 `blocked`。

若进程在 `running` 中异常退出，恢复时必须把该状态归一化为 `pending`，保留未完成证据但不把它
计为成功。用户或探针驱动重新发送同一 revision 的 verify 命令即可恢复。

## 对抗测试增强

正式耐久租约队列 Oracle 增加以下测试：

1. **安全整数溢出不污染日志**
   - `clock() = Number.MAX_SAFE_INTEGER`，`leaseMs = 1`；
   - `claim()` 必须拒绝；
   - 日志字节、行数、链头和内存状态均不变化；
   - 新实例 `recover()` 必须成功。
2. **JSON 特殊键完整往返**
   - payload 包含 `__proto__`、`constructor` 和 `prototype`；
   - enqueue 返回值、日志恢复结果和原始 JSON 深度相等；
   - 不得污染任何对象原型。
3. **失败变更原子性**
   - 所有公开 mutator 的校验失败都不得追加事件；
   - 失败前后的日志 SHA-256 和任务快照相同。
4. **最终验收失败阻断交付**
   - 公开测试通过且双审批成功；
   - Oracle 对抗测试失败；
   - 状态必须是 governance `approved`、delivery `failed`、workflow
     `revision-required`；
   - 依赖任务仍为 `blocked`。
5. **修订后重新验收**
   - revision 2 修复问题；
   - 两名 reviewer 分别产生新证据并批准；
   - 最终检查全部通过后才进入 `completed/passed`。

公开测试继续验证基础契约，Oracle 保持在角色工作目录之外。真实探针必须先证明旧桩为公开
`0/10`、Oracle `0/N`，防止旧实现或旧状态污染绿灯。

## 事件与可观测性

新增事件类型：

```text
task-verification
task-governance-approved
task-delivery-started
task-delivery-check
task-delivery-passed
task-delivery-failed
```

`/ansteel-team status` 对每个任务同时显示：

```text
Workflow: awaiting-delivery
Governance: approved
Delivery: pending
Revision: 1
Review evidence: tech-lead=<ID>, qa-engineer=<ID>
Delivery evidence: none
```

输出中的计数和状态由 coordinator 从结构化 state 派生，角色自由文本不能覆盖。

## 状态版本与迁移

状态版本从 6 升到 7。加载 version 6 时执行一次确定性迁移：

- `blocked/claimed/submitted/revision-required` 映射到同名 `workflowStatus`；
- 原 `approved` 映射为：
  - `workflowStatus = "submitted"`；
  - `governanceStatus = "pending"`；
  - `deliveryStatus = "pending"`；
- 其他状态的 governance 和 delivery 均为 `pending`；
- 现有 review、submission 和 test evidence 原样保留，但缺少 verification evidence ID 的旧 review
  只作为历史记录，不能满足 version 7 的批准门禁；
- version 7 允许同一 reviewer 对该 revision 新增一条绑定独立证据的有效 review，旧 review 不触发
  重复评审拒绝；
- 不为旧任务伪造 reviewer verification 或 delivery evidence；
- 所有依赖旧 `approved` 任务的未完成任务重新按 delivery `passed` 条件计算，必要时回到
  `blocked`。

迁移通过现有原子临时文件加 rename 写回。迁移前的 team.json 保存为一次性 version 6 备份；迁移
失败时保持原文件不变并拒绝启动团队。

## 测试层级

### 核心状态机测试

`ansteel-team.test.ts` 覆盖：

- 两个 reviewer 没有各自证据时不能批准；
- reviewer 证据不能跨角色、revision 或 diff hash 重用；
- 双审批只进入 `awaiting-delivery/approved/pending`；
- delivery 失败不解锁依赖；
- delivery 通过才进入 `completed/approved/passed`；
- revision 2 不接受 revision 1 的任何证据；
- version 6 fail-closed 迁移。

### 扩展测试

`ansteel-team-extension.test.ts` 覆盖：

- 评审 prompt 要求先调用 `ansteel_verify_task`；
- 两名 reviewer 的命令分别真实执行；
- 验证失败时 `APPROVE` 被拒绝；
- coordinator verify 命令不暴露给角色；
- verify 中断可以恢复；
- 状态事件按顺序进入同一哈希链。

### CLI/RPC 集成测试

`ansteel-team-cli.test.ts` 使用确定性夹具证明：

```text
task-assigned
-> task-submitted
-> tech-lead task-verification
-> tech-lead task-review
-> qa-engineer task-verification
-> qa-engineer task-review
-> task-governance-approved
-> task-delivery-started
-> task-delivery-check
-> task-delivery-passed
```

另一个夹具让最终 check 失败，必须得到非零 RPC 结果、delivery `failed` 和未解锁依赖。

### 真实探针

全新唯一 Probe/Oracle 目录执行：

1. 红灯公开与 Oracle；
2. 三个不同 provider/model 的真实编码；
3. 两份 reviewer 独立验证证据；
4. 双审批后的 `awaiting-delivery`；
5. 外部 Oracle 最终验收；
6. 对抗测试；
7. Git、事件链、session、模型、进程和退出码机械审计。

审计脚本遇到任一失败必须设置非零退出码，不能只打印布尔值。

## 验收标准

本阶段只有同时满足以下条件才算完成：

1. 旧回归和新增核心、扩展、CLI 测试全部通过。
2. `coding-agent` 类型检查与构建通过。
3. version 6 状态迁移测试通过且不伪造验证证据。
4. reviewer 没有自己的成功证据时无法 `APPROVE`。
5. 双审批后任务仍不能解锁依赖。
6. 最终验收失败时 delivery 为 `failed`，任务进入 revision。
7. 最终验收成功时才进入 `completed/passed`。
8. 新增两个租约队列反例在旧生成实现上失败，在修订实现上通过。
9. 真实探针从红灯运行到最终交付，所有审计命令严格返回正确退出码。
10. 产品仓库不包含探针生成的临时实现、运行状态、凭据或 Oracle 绝对路径。

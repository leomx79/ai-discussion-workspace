# Ansteel Team 公开协作检查点与共享工作板实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有持久团队、哈希链账本和运行追踪之上，实现可机械校验的 `WORK_CHECKPOINT`、`PROCESS_ISSUE`、`PROCESS_RESOLUTION`、问题提出者复核，以及从持久事实派生的共享工作板。

**Architecture:** 将公开协作对象作为 `AnsteelTeamState` v7 的结构化状态，并通过新增的哈希链事件驱动状态变化；不把模型自由文本当成状态。核心模块负责校验身份、引用、状态转换和迁移，扩展层只提供角色工具、时间线展示和只读 `board` 命令。私有思维链不记录，角色只能发布简洁、可质疑的公开工作检查点。

**Tech Stack:** TypeScript 5.9、Node.js 22、Vitest 4、TypeBox、现有 Ansteel Team 哈希链账本、OpenTelemetry 运行日志、Pi extension/RPC harness

---

除明确标注从 `pi-agent` 根目录运行的命令外，本计划的测试和构建命令均从
`pi-agent/packages/coding-agent` 执行。用户已明确要求只使用 `main`，每个任务通过后直接以详细中文
提交并推送 `origin/main`，不创建分支或 worktree。

## 范围边界

本阶段实现：

1. 角色发布结构化公开工作检查点；
2. 同伴针对精确检查点提出过程问题；
3. 检查点负责人发布精确解决结果；
4. 问题提出者确认关闭或拒绝解决；
5. 协调器从账本和状态派生共享工作板；
6. 所有变化进入运行 trace 和统一时间线。

本阶段不宣称实现：

- 黄色、红色动作的执行阻断和双同伴确认；
- 动态任务负责人、负载调度和文件租约转交；
- 协作、治理、交付三轴终态；
- 自动最终交付验收。

这些能力依赖本阶段建立的结构化对象，将在后续计划中实现。

## 文件边界

- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team.ts`
  - 状态 v7、事件 schema、检查点、问题、解决和提出者复核。
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team.test.ts`
  - 核心状态迁移、身份门禁、引用完整性和哈希链测试。
- Modify: `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts`
  - 角色协作工具、公开提示词、共享工作板展示和 trace 接入。
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts`
  - 三角色工具、时间线、board 命令和恢复测试。
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-cli.test.ts`
  - 真实 RPC 下的公开检查点、问题纠正闭环和失败退出。
- Modify: `pi-agent/packages/coding-agent/docs/ansteel.md`
  - 用户命令、公开/私有边界和后续风险门禁边界。

### Task 1: 定义状态 v7 与无损迁移

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team.test.ts`

- [ ] **Step 1: 写出 v6 到 v7 迁移和结构校验失败测试**

在 `ansteel-team.test.ts` 增加：

```ts
it("migrates v6 teams to empty public collaboration state", () => {
	const cwd = createTemporaryProject();
	const state = createTeam(cwd);
	const statePath = getAnsteelTeamStatePath(cwd);
	const legacy = JSON.parse(readFileSync(statePath, "utf8"));
	legacy.version = 6;
	delete legacy.workCheckpoints;
	delete legacy.processIssues;
	writeFileSync(statePath, `${JSON.stringify(legacy)}\n`, "utf8");

	const migrated = loadAnsteelTeamState(cwd);

	expect(migrated).toMatchObject({
		version: 7,
		workCheckpoints: [],
		processIssues: [],
	});
});
```

再增加损坏状态用例，确保重复检查点 ID、未知目标检查点、非法置信度、解决者身份不匹配时
`loadAnsteelTeamState()` 拒绝。

- [ ] **Step 2: 运行测试并确认因 v7 字段不存在而失败**

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team.test.ts -t "public collaboration state"
```

Expected: FAIL，断言显示状态仍为 v6 或缺少 `workCheckpoints/processIssues`。

- [ ] **Step 3: 增加公共类型**

在核心模块定义：

```ts
export type AnsteelCheckpointRisk = "green" | "yellow" | "red";
export type AnsteelCheckpointConfidence = "L1" | "L2" | "L3" | "L4";
export type AnsteelProcessIssueSeverity = "advisory" | "blocking" | "critical";
export type AnsteelProcessResolutionOutcome =
	| "ACCEPTED"
	| "REFUTED"
	| "EXPERIMENT_REQUIRED"
	| "SCOPE_ESCALATION";

export interface AnsteelWorkCheckpoint {
	id: string;
	taskId?: string;
	actor: AnsteelRole;
	goal: string;
	currentUnderstanding: string;
	assumptions: string[];
	evidenceRefs: string[];
	uncertainties: string[];
	nextAction: {
		kind: "read" | "experiment" | "edit" | "test" | "commit" | "publish" | "decision";
		target: string;
		expectedResult: string;
	};
	risk: AnsteelCheckpointRisk;
	confidence: AnsteelCheckpointConfidence;
	status: "active" | "superseded";
	supersedesCheckpointId?: string;
	createdAt: string;
}

export interface AnsteelProcessResolution {
	id: string;
	issueId: string;
	actor: AnsteelRole;
	outcome: AnsteelProcessResolutionOutcome;
	summary: string;
	evidenceRefs: string[];
	replacementCheckpointId?: string;
	experiment?: string;
	createdAt: string;
	review?: {
		reviewer: AnsteelRole;
		verdict: "accept" | "reject";
		reason: string;
		reviewedAt: string;
	};
}

export interface AnsteelProcessIssue {
	id: string;
	targetCheckpointId: string;
	author: AnsteelRole;
	targetRole: AnsteelRole;
	severity: AnsteelProcessIssueSeverity;
	claim: string;
	evidenceRefs: string[];
	suggestedCorrection: string;
	status: "open" | "resolution-proposed" | "closed" | "escalated";
	resolutions: AnsteelProcessResolution[];
	createdAt: string;
}
```

给 `AnsteelTeamState` 增加：

```ts
workCheckpoints: AnsteelWorkCheckpoint[];
processIssues: AnsteelProcessIssue[];
```

将状态版本提升为 `7`；v6 迁移只追加空数组，不修改任务、里程碑、角色、账本头或序号。

- [ ] **Step 4: 实现结构校验**

校验必须包括：

- `CP-<UPPERCASE-ID>`、`PI-<UPPERCASE-ID>`、`PR-<UPPERCASE-ID>`；
- ID 全局唯一；
- `taskId` 存在时必须引用现有任务；
- `taskId` 存在时，检查点作者必须是该任务当前负责人；
- `supersedesCheckpointId` 必须引用同一角色的旧检查点；
- 问题必须引用存在的检查点，且提出者不能是该检查点作者；
- `targetRole` 必须等于检查点作者；
- 解决者必须等于问题目标角色；
- 解决复核者必须等于问题提出者；
- 关闭问题必须有被接受的解决；升级问题必须来自 `SCOPE_ESCALATION`。

- [ ] **Step 5: 运行核心测试并确认通过**

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team.test.ts
```

Expected: PASS；既有 v1-v6 迁移、任务、里程碑和事务恢复测试无回归。

- [ ] **Step 6: 提交并推送状态基础**

```powershell
git add -- packages/coding-agent/src/core/ansteel-team.ts packages/coding-agent/test/ansteel-team.test.ts
git commit -m "feat(鞍钢协作): 建立公开检查点与过程问题状态"
git push origin main
```

### Task 2: 实现检查点、问题、解决与提出者复核

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team.test.ts`

- [ ] **Step 1: 写出完整纠错闭环失败测试**

```ts
it("requires the issue author to verify a checkpoint correction", () => {
	const cwd = createTemporaryProject();
	const state = createTeam(cwd);
	const checkpointInput = {
		id: "CP-LEASE-0001",
		goal: "Prevent lease timestamp overflow",
		currentUnderstanding: "The sum must remain a safe integer",
		assumptions: ["clock and leaseMs are non-negative safe integers"],
		evidenceRefs: ["file:src/lease.ts:10"],
		uncertainties: ["Callers near MAX_SAFE_INTEGER"],
		nextAction: { kind: "edit", target: "src/lease.ts", expectedResult: "Overflow is rejected" },
		risk: "yellow",
		confidence: "L2",
	} as const;
	const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", checkpointInput);
	raiseAnsteelProcessIssue(cwd, state, "qa-engineer", {
		id: "PI-LEASE-0001",
		targetCheckpointId: checkpoint.id,
		severity: "blocking",
		claim: "Valid inputs can still produce an unsafe sum",
		evidenceRefs: ["test:lease-overflow"],
		suggestedCorrection: "Validate the calculated expiry",
	});
	publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
		...checkpointInput,
		id: "CP-LEASE-0002",
		currentUnderstanding: "The calculated expiry must also be a safe integer",
		evidenceRefs: ["test:lease-overflow"],
		supersedesCheckpointId: "CP-LEASE-0001",
	});
	resolveAnsteelProcessIssue(cwd, state, "staff-engineer", {
		id: "PR-LEASE-0001",
		issueId: "PI-LEASE-0001",
		outcome: "ACCEPTED",
		summary: "Validate expiry before persistence",
		evidenceRefs: ["diff:sha256:abc"],
		replacementCheckpointId: "CP-LEASE-0002",
	});

	expect(() =>
		reviewAnsteelProcessResolution(cwd, state, "tech-lead", "PI-LEASE-0001", {
			verdict: "accept",
			reason: "Looks good",
		}),
	).toThrow("issue author");

	reviewAnsteelProcessResolution(cwd, state, "qa-engineer", "PI-LEASE-0001", {
		verdict: "accept",
		reason: "The replacement checkpoint includes the overflow test",
	});
	expect(state.processIssues[0].status).toBe("closed");
});
```

- [ ] **Step 2: 运行测试并确认四个操作函数不存在**

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team.test.ts -t "requires the issue author"
```

Expected: FAIL，缺少公开协作操作函数。

- [ ] **Step 3: 扩展事件 schema**

新增事件类型：

```ts
| "work-checkpoint"
| "process-issue"
| "process-resolution"
| "process-resolution-review"
```

事件增加 `schemaVersion?: 1 | 2` 和可选字段 `checkpointId`、`issueId`、`resolutionId`，并定义可判别
的结构化 payload：

```ts
export type AnsteelTeamPublicEventPayload =
	| { kind: "work-checkpoint"; checkpoint: AnsteelWorkCheckpoint }
	| { kind: "process-issue"; issue: AnsteelProcessIssue }
	| { kind: "process-resolution"; issueId: string; resolution: AnsteelProcessResolution }
	| {
			kind: "process-resolution-review";
			issueId: string;
			resolutionId: string;
			review: NonNullable<AnsteelProcessResolution["review"]>;
	  };
```

新协作事件必须使用 `schemaVersion: 2` 并携带与事件类型一致的 payload，`applyAnsteelTeamEvent()` 只从
该 payload 更新结构化状态。新事件哈希规范对象包含关联 ID 和完整 payload。既有事件没有
`schemaVersion`，按 v1 解析并继续使用原哈希字段集合；v6 到 v7 迁移不得重写或重新哈希旧账本。

- [ ] **Step 4: 实现四个操作函数**

```ts
publishAnsteelWorkCheckpoint(cwd, state, actor, input, persistence?)
raiseAnsteelProcessIssue(cwd, state, author, input, persistence?)
resolveAnsteelProcessIssue(cwd, state, actor, input, persistence?)
reviewAnsteelProcessResolution(cwd, state, reviewer, issueId, input, persistence?)
```

共同规则：

- 先完成全部校验，再改变内存；
- 每次操作只通过 `appendAnsteelTeamEvent()` 驱动状态；
- 状态、事件和 pending transaction 使用同一 persistence context；
- `ACCEPTED` 必须引用同一角色的新替代检查点；
- `ACCEPTED` 的替代检查点必须直接 supersede 被质疑检查点，并保持相同任务引用；
- `REFUTED` 必须有新证据；
- `EXPERIMENT_REQUIRED` 必须给出最小实验；
- `SCOPE_ESCALATION` 直接进入 `escalated`，不得伪装成关闭；
- 复核 `reject` 将问题恢复为 `open`，必须说明仍缺什么证据；
- 同一解决只能复核一次。

- [ ] **Step 5: 增加对抗测试**

覆盖：

- 自己质疑自己的检查点；
- 解决其他角色的问题；
- `ACCEPTED` 不发布替代检查点；
- `REFUTED` 无证据；
- 重复问题/解决 ID；
- 非问题提出者复核；
- 复核拒绝后发布新解决；
- 修改历史事件后哈希链拒绝。

- [ ] **Step 6: 运行核心测试并提交**

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team.test.ts test/ansteel-team-observability.test.ts
git add -- packages/coding-agent/src/core/ansteel-team.ts packages/coding-agent/test/ansteel-team.test.ts
git commit -m "feat(鞍钢协作): 实现公开问题纠正闭环"
git push origin main
```

### Task 3: 从持久事实派生共享工作板

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team.test.ts`

- [ ] **Step 1: 写出共享工作板失败测试**

```ts
it("derives the shared board without trusting role-written counts", () => {
	const board = getAnsteelTeamSharedBoard(state, events);

	expect(board.currentGoal).toBe(state.topic);
	expect(board.roles["staff-engineer"].activeCheckpointId).toBe("CP-LEASE-0002");
	expect(board.openProcessIssues).toEqual([
		expect.objectContaining({ id: "PI-LEASE-0002", severity: "blocking" }),
	]);
	expect(board.counts).toEqual({
		activeCheckpoints: 1,
		openProcessIssues: 1,
		blockingProcessIssues: 1,
		escalatedProcessIssues: 0,
	});
});
```

- [ ] **Step 2: 运行测试并确认 projection 不存在**

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team.test.ts -t "derives the shared board"
```

Expected: FAIL，缺少 `getAnsteelTeamSharedBoard()`。

- [ ] **Step 3: 实现只读 projection**

定义：

```ts
export interface AnsteelTeamSharedBoard {
	teamId: string;
	currentGoal: string;
	teamStatus: AnsteelTeamStatus;
	roles: Record<AnsteelRole, {
		status: AnsteelTeamRoleState["status"];
		activeCheckpointId?: string;
		openIssueIds: string[];
	}>;
	tasks: Array<{
		id: string;
		owner: AnsteelRole;
		status: AnsteelTeamTask["status"];
		dependsOn: string[];
	}>;
	activeCheckpoints: AnsteelWorkCheckpoint[];
	openProcessIssues: AnsteelProcessIssue[];
	recentToolFacts: Array<{ sequence: number; eventName: string; outcome: string; reasonCode?: string }>;
	counts: {
		activeCheckpoints: number;
		openProcessIssues: number;
		blockingProcessIssues: number;
		escalatedProcessIssues: number;
	};
}
```

`getAnsteelTeamSharedBoard(state, events, runtimeEntries?)` 必须机械计算数量、当前检查点、开放问题和最近工具
事实。模型文本中的 “all issues closed” 或手写数字不得进入 projection。

- [ ] **Step 4: 验证状态与事件不一致时拒绝**

从所有 v2 公开协作事件重放出 `workCheckpoints/processIssues`；若重放结果与状态中的检查点/问题不一致，抛出带
`state-projection-mismatch` 语义的 `AnsteelTeamStateError`，不返回部分工作板。

- [ ] **Step 5: 运行测试并提交**

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team.test.ts
git add -- packages/coding-agent/src/core/ansteel-team.ts packages/coding-agent/test/ansteel-team.test.ts
git commit -m "feat(鞍钢协作): 增加机械共享工作板投影"
git push origin main
```

### Task 4: 暴露角色协作工具并接入运行追踪

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts`

- [ ] **Step 1: 写出角色工具与时间线失败测试**

在 extension harness 中通过 `roleSessionOptions` 调用协作操作，断言：

```ts
const staff = harness.roleSessionOptions.find((entry) => entry.role === "staff-engineer")!;
const qa = harness.roleSessionOptions.find((entry) => entry.role === "qa-engineer")!;
await staff.taskOperations.publishCheckpoint(checkpointInput);
await qa.taskOperations.raiseProcessIssue(issueInput);
await staff.taskOperations.resolveProcessIssue(resolutionInput);
await qa.taskOperations.reviewProcessResolution("PI-LEASE-0001", reviewInput);

expect(listAnsteelTeamEvents(cwd).map((event) => event.type)).toEqual(
	expect.arrayContaining([
		"work-checkpoint",
		"process-issue",
		"process-resolution",
		"process-resolution-review",
	]),
);
```

同时检查 timeline 含精确 ID，运行日志含 `checkpoint.publish`、`process.issue`、`process.resolve`、
`process.review`。

- [ ] **Step 2: 运行测试并确认扩展操作不存在**

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-extension.test.ts -t "publishes public checkpoints"
```

Expected: FAIL。

- [ ] **Step 3: 扩展角色操作接口**

给角色操作增加：

```ts
publishCheckpoint(input): Promise<AnsteelWorkCheckpoint>;
raiseProcessIssue(input): Promise<AnsteelProcessIssue>;
resolveProcessIssue(input): Promise<AnsteelProcessResolution>;
reviewProcessResolution(issueId, input): Promise<AnsteelProcessIssue>;
```

新增 TypeBox 工具：

```text
ansteel_publish_checkpoint
ansteel_raise_process_issue
ansteel_resolve_process_issue
ansteel_review_process_resolution
```

工具参数必须逐字段声明，不接受自由 JSON 字符串。工具结果只显示公开 ID、状态和下一步，不返回协调器
私有日志路径。

- [ ] **Step 4: 接入运行 span 和公开时间线**

每个工具操作使用当前 command root 下的 span：

```text
checkpoint.publish
process.issue
process.resolve
process.review
```

关联 `checkpointId/issueId/taskId/role`。失败使用现有稳定原因码；引用或身份门禁失败使用
`unclassified-runtime-error` 但保留脱敏异常栈，后续风险阶段再增加专用门禁原因码。

- [ ] **Step 5: 更新角色提示词**

提示词必须明确：

- 公开工作推理不是隐藏思维链；
- 形成/改变方案、准备黄色或红色动作、工具结果异常、接受/反驳质疑、准备验收时发布检查点；
- 对具体检查点质疑，不攻击角色；
- 解决问题必须选精确 outcome；
- 问题只有提出者复核接受才关闭；
- 纯公开 prose 不能替代结构化工具事件。

- [ ] **Step 6: 运行扩展测试并提交**

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-extension.test.ts
git add -- packages/coding-agent/src/extensions/ansteel-team/index.ts packages/coding-agent/test/ansteel-team-extension.test.ts
git commit -m "feat(鞍钢协作): 接入角色公开检查点与纠错工具"
git push origin main
```

### Task 5: 增加 `board` 命令和真实 RPC 纠错闭环

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-cli.test.ts`

- [ ] **Step 1: 写出 `board` 只读命令失败测试**

```ts
await command("board", harness.ctx);
expect(harness.sendMessage).toHaveBeenLastCalledWith(
	expect.objectContaining({
		content: expect.stringMatching(/Active checkpoints: 1.*Open process issues: 1/s),
	}),
	{ triggerTurn: false },
);
```

损坏账本时 `board` 必须拒绝，不能回退到内存状态。

- [ ] **Step 2: 写出真实 RPC 纠错闭环**

确定性 provider 依次调用四个公开协作工具，真实 RPC 测试断言：

- `start` 后账本存在检查点；
- QA 问题引用 Staff 检查点；
- Staff 解决引用替代检查点；
- QA 接受后问题状态为 `closed`；
- `/ansteel-team board` 返回机械数量；
- 非作者尝试复核时 RPC `success: false`。

- [ ] **Step 3: 运行测试并确认命令与 provider fixture 尚不支持**

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-extension.test.ts test/ansteel-team-cli.test.ts -t "shared board|correction loop"
```

Expected: FAIL。

- [ ] **Step 4: 实现 board 格式和命令**

`formatSharedBoard()` 只读取 `getAnsteelTeamSharedBoard()` 返回值。输出至少包含：

```text
Goal
Role status and active checkpoint
Task owner/status/dependencies
Active checkpoints
Open process issues grouped by severity
Recent tool facts
Mechanically derived counts
```

`board` 是只读 observed command；状态、账本或运行日志损坏时异常必须传播到 RPC。

- [ ] **Step 5: 运行完整扩展与 RPC 回归**

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-extension.test.ts test/ansteel-team-cli.test.ts
```

Expected: 全部 PASS，无挂起子进程。

- [ ] **Step 6: 提交并推送共享工作板**

```powershell
git add -- packages/coding-agent/src/extensions/ansteel-team/index.ts packages/coding-agent/test/ansteel-team-extension.test.ts packages/coding-agent/test/ansteel-team-cli.test.ts
git commit -m "feat(鞍钢协作): 增加共享工作板与真实纠错闭环"
git push origin main
```

### Task 6: 文档、完整验证和阶段验收

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts`
- Modify: `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team.test.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-observability.test.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-cli.test.ts`
- Modify: `pi-agent/packages/coding-agent/docs/ansteel.md`
- Modify: `docs/superpowers/plans/2026-07-29-ansteel-team-public-collaboration-board.md`
- Create: `.superpowers/sdd/2026-07-29-ansteel-team-public-collaboration-board/task-6-report.md`

- [x] **Step 1: 更新用户文档**

文档精确说明：

- 公开工作推理与隐藏思维链的边界；
- 四个协作工具的字段、身份限制和状态转换；
- `board` 的事实来源和机械计数；
- 问题提出者复核关闭规则；
- 本阶段尚未实施黄色/红色动作阻断。

- [x] **Step 2: 运行定向回归**

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team.test.ts test/ansteel-team-observability.test.ts test/ansteel-team-extension.test.ts test/ansteel-team-cli.test.ts
```

Expected: 全部 PASS。

- [x] **Step 3: 运行构建和依赖检查**

```powershell
npm run build
```

从 `pi-agent` 根目录：

```powershell
npm run check:pinned-deps
npm run check:ts-imports
npm run check:shrinkwrap
npm run check:install-lock:coding-agent
```

Expected: 全部退出 `0`。

- [x] **Step 4: 做状态重放和篡改审计**

在测试中创建完整纠错闭环，重启加载后 `board` 必须相同；修改任一检查点、问题、解决或复核事件内容后，
账本哈希校验必须拒绝，且 `doctor/board` 不得输出健康状态。

- [x] **Step 5: 更新计划证据并提交**

本次执行已更新计划证据；实现任务明确禁止提交和推送，最终控制器须在审阅后另行完成提交与上传。

```powershell
git add -- `
  docs/superpowers/plans/2026-07-29-ansteel-team-public-collaboration-board.md `
  pi-agent/packages/coding-agent/docs/ansteel.md `
  pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts `
  pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts `
  pi-agent/packages/coding-agent/test/ansteel-team.test.ts `
  pi-agent/packages/coding-agent/test/ansteel-team-observability.test.ts `
  pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts `
  pi-agent/packages/coding-agent/test/ansteel-team-cli.test.ts
git add -f -- .superpowers/sdd/2026-07-29-ansteel-team-public-collaboration-board/task-6-report.md
git commit -m "docs(鞍钢协作): 完成公开纠错与共享工作板验收"
git push origin main
```

- [x] **Step 6: 阶段完成审计**

只有以下条件全部有当前磁盘和测试证据时才勾选完成：

- 检查点、问题、解决和复核均为结构化状态；
- 问题只能引用真实检查点；
- 只有目标角色能解决，只有提出者能确认关闭；
- 共享工作板计数由协调器机械派生；
- 重启后状态不变，篡改账本 fail-closed；
- RPC 对身份、引用和损坏错误返回非成功；
- 旧任务、里程碑、可观测性测试无回归。

完成本阶段后继续实施风险门禁；不得把“问题可记录”描述为“黄色/红色动作已被阻断”。

### 2026-07-30 阶段证据 (Task 6)

- RED: 在生产代码改动前执行 `node node_modules/vitest/vitest.mjs --run --no-file-parallelism test/ansteel-team-extension.test.ts -t "rejects a previously healthy doctor run"`，得到 `1 failed | 26 skipped`；断言实际报错为 `promise resolved "undefined" instead of rejecting`，证明 doctor 会错误信任被篡改账本之前的健康运行。
- GREEN: 同一命令在 doctor 持久化完整性预检加入后得到 `1 passed | 26 skipped`。
- 空运行与中断运行 RED: 在可观测性生产代码改动前，从 `pi-agent` 根目录执行
  `node packages/coding-agent/node_modules/vitest/vitest.mjs --run --no-file-parallelism packages/coding-agent/test/ansteel-team-observability.test.ts packages/coding-agent/test/ansteel-team-cli.test.ts -t "returns artifact-missing|returns process-orphaned|returns RPC failure when doctor diagnoses"`，
  得到 `3 failed | 13 skipped`；旧实现把无日志运行和没有根 span 终态的运行判为健康，真实 RPC doctor 也返回成功。
- 空运行与中断运行 GREEN: 同一命令得到 `3 passed | 13 skipped`；两文件完整串行回归得到 `16 passed`。
- 恢复门禁与多 span RED: 独立规范审查用只读探针证明第一根已结束、第二根未结束时仍会返回健康，并证明
  恢复路径只看 `team.json`。新增多根、无根兼容和真实新宿主恢复测试后，定向命令得到
  `3 failed | 35 skipped`；终态早于起点的对抗用例另得到 `1 failed | 10 skipped`。
- 恢复门禁与多 span GREEN: 诊断改为逐一匹配起点之后、同 `spanId` 和同 `eventName` 的合法终态；
  首次重启会在原 run/trace/team 哈希链上追加 `abandoned/process-orphaned` 并阻断，第二次显式启动才继续。
  四条定向回归得到 `4 passed | 35 skipped`，两文件完整回归得到 `39 passed`。
- 子 span RED/GREEN: 第二轮复审证明已结束根 span 会掩盖未结束 `provider.request`；单元和新宿主恢复回归
  先得到 `2 failed | 38 skipped`，推广到所有 `started` span 并保留父子与 provider/tool/process/lease
  关联字段后，同一命令得到 `2 passed | 38 skipped`。
- 多宿主、因果字段与状态游标 RED/GREEN: 最终规范复审指出活跃旧宿主会被误写 `abandoned`、同一 run
  可由两个 logger 共享旧链头、恢复覆盖原 `causeEventId`，且有效事件链配合损坏 `ledgerHeadHash` 或
  `nextEventSequence` 会误报 `event-chain-invalid`。新增 6 条回归后先得到 `6 failed | 40 skipped`；
  使用既有 `proper-lockfile` 建立单写者租约、持锁重读链头、保留原因果字段并分阶段校验 doctor 后，
  同一命令得到 `6 passed | 40 skipped`。
- 重启回放和四类事件篡改: `node node_modules/vitest/vitest.mjs --run --no-file-parallelism test/ansteel-team.test.ts -t "replays a complete public correction loop|rejects a hash-preserving-state tamper"` 得到 `2 passed | 55 skipped`。
- 规范审查修复: 哈希链损坏的 `doctor` 原因码精确锁定为 `event-chain-invalid`；另以合法事件链和被改写
  `team.json` 构造投影不一致，精确锁定 `state-projection-mismatch`；真实 RPC 篡改账本后执行
  `doctor <healthyRunId>` 与 `board` 均返回 `success: false`，且不输出健康诊断或工作板内容。
- 受控变异证明: 临时移除 `doctor` 持久化预检后，新补的 3 条扩展/RPC 回归全部失败；恢复预检后同一命令
  得到 `2 passed` 文件、`3 passed | 32 skipped`。临时变异未保留在最终差异中。
- 定向完整回归: `node node_modules/vitest/vitest.mjs --run --no-file-parallelism test/ansteel-team.test.ts test/ansteel-team-observability.test.ts test/ansteel-team-extension.test.ts test/ansteel-team-cli.test.ts` 得到 `4 passed` 文件和 `111 passed` 测试。
- 构建和代码格式: `npm run build` 成功；首次将可观测性文件纳入 Biome 后安全修复了 3 个文件的格式和
  import 顺序，随后 `npx biome check src/core/ansteel-team-observability.ts src/extensions/ansteel-team/index.ts test/ansteel-team.test.ts test/ansteel-team-observability.test.ts test/ansteel-team-extension.test.ts test/ansteel-team-cli.test.ts`
  报告 `Checked 6 files` 且未应用修复。
- 根目录验证: `.\node_modules\.bin\tsgo.cmd --noEmit`、`npm run check:pinned-deps`、`npm run check:ts-imports`、`npm run check:shrinkwrap`、`npm run check:install-lock:coding-agent` 均以退出码 `0` 完成；后两项分别确认 shrinkwrap 和 install-lock 为最新。
- 工作区检查: `git diff --check` 以退出码 `0` 结束（仅报告既有行尾转换提示）；当前声明边界包含 8 个受跟踪修改文件，以及强制加入的 Task 6 报告；未触碰既有 `.workbuddy/`、`github-work-profile.md`、`input-output-flow.md`、`overview.md`。
- 本阶段仍不完成完整的持续协作协议：黄色/红色风险只会被记录，不会单独触发动作阻断；提交和推送未执行，等待控制器审阅。

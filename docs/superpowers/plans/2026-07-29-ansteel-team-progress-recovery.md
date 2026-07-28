# Ansteel Team 进展驱动恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 `/ansteel-team` 对截断输出的成功误判，以协调器结构化任务和真实状态进展驱动有界编码 epoch。

**Architecture:** 原始角色轮次拒绝 `length` 和空公开文本，并在每轮前切到隔离对话分支。团队扩展新增 coordinator task 命令，任务循环比较受控任务状态和 Git diff 指纹，只在真实变化后继续，最终仍由两名非 owner 审查不可变提交。

**Tech Stack:** TypeScript、Vitest、Pi Extension API、RPC CLI、Git、Node.js。

---

## 文件结构

- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-discussion.ts`
  - 配置字段解析；原始角色轮次截断和空输出错误。
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team.ts`
  - coordinator 事件 actor；`task-assigned` 事件；任务进展指纹。
- Modify: `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts`
  - 隔离角色 session；结构化 task 命令；有界进展循环。
- Modify: `pi-agent/packages/coding-agent/test/ansteel-discussion.test.ts`
  - 原始轮次 RED/GREEN 回归和配置边界。
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team.test.ts`
  - coordinator 事件与任务指纹回归。
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts`
  - task 命令、进展、截断恢复和有界停止。
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-cli.test.ts`
  - 真实 RPC CLI 的确定性任务交付回归。
- Modify: `pi-agent/packages/coding-agent/docs/ansteel.md`
  - 用户命令和失败语义。

### Task 1: 拒绝截断和空角色输出

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-discussion.ts:717-882`
- Test: `pi-agent/packages/coding-agent/test/ansteel-discussion.test.ts:2043`

- [ ] **Step 1: 写出 `length` 失败测试**

在 raw-session 测试组添加：

```ts
it("rejects an output-length stop instead of publishing an empty role reply", async () => {
	const assistantMessages = createAssistantMessageEmitter();
	const session = createAnsteelRawTurnSession({
		prompt: async () => {
			assistantMessages.emit({
				role: "assistant",
				content: [{ type: "thinking", thinking: "truncated private work" }],
				stopReason: "length",
			});
		},
		subscribeToAssistantMessageEnd: assistantMessages.subscribe,
		dispose: () => {},
	});

	await expect(session.prompt("implement")).rejects.toThrow("output-truncated");
	expect(session.getLastStageAudit?.().events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: "assistant-message-end", stopReason: "length" }),
			expect.objectContaining({ type: "stage-prompt-error" }),
		]),
	);
});
```

- [ ] **Step 2: 把旧空输出测试改成失败契约**

```ts
await expect(createAnsteelRawTurnSession(source).prompt("veto")).rejects.toThrow("empty-public-update");
```

- [ ] **Step 3: 运行 RED**

Run:

```powershell
node .\node_modules\vitest\vitest.mjs --run --no-file-parallelism test\ansteel-discussion.test.ts -t "output-length|empty role"
```

Expected: 两个断言失败；当前实现分别返回空字符串。

- [ ] **Step 4: 实现最小错误识别**

增加安全 helper：

```ts
function rawAssistantCompletionError(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	if (message.stopReason === "length") return "Ansteel role stage failed: output-truncated";
	return rawAssistantProviderError(message);
}
```

在 `createAnsteelRawTurnSession` 中先检查最后一条 assistant message，再提取文本；没有非空文本时抛出：

```ts
throw new Error("Ansteel role stage failed: empty-public-update");
```

两个错误都必须记录 `stage-prompt-error`，不得记录 `stage-prompt-end`。

- [ ] **Step 5: 运行 GREEN**

Run:

```powershell
node .\node_modules\vitest\vitest.mjs --run --no-file-parallelism test\ansteel-discussion.test.ts -t "output-length|empty role|provider error|raw-session"
```

Expected: 相关测试全部通过。

### Task 2: 定义 coordinator 任务事件和进展指纹

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team.ts`
- Test: `pi-agent/packages/coding-agent/test/ansteel-team.test.ts`

- [ ] **Step 1: 写 coordinator 事件 RED 测试**

创建团队状态和 Staff 任务后追加：

```ts
const event = appendAnsteelTeamEvent(cwd, team, {
	type: "task-assigned",
	role: "coordinator",
	targetRole: "staff-engineer",
	content: "TASK-PARSER assigned to staff-engineer",
});
expect(event).toMatchObject({
	type: "task-assigned",
	role: "coordinator",
	targetRole: "staff-engineer",
});
expect(() =>
	appendAnsteelTeamEvent(cwd, team, {
		type: "role-report",
		role: "coordinator",
		content: "invalid fourth reviewer",
	}),
).toThrow("coordinator");
```

- [ ] **Step 2: 写任务指纹 RED 测试**

```ts
const before = getAnsteelTeamTaskProgressFingerprint(cwd, team, "TASK-PARSER");
writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'after';\n", "utf8");
const after = getAnsteelTeamTaskProgressFingerprint(cwd, team, "TASK-PARSER");
expect(after).not.toBe(before);
expect(getAnsteelTeamTaskProgressFingerprint(cwd, team, "TASK-PARSER")).toBe(after);
```

- [ ] **Step 3: 运行 RED**

Run:

```powershell
node .\node_modules\vitest\vitest.mjs --run --no-file-parallelism test\ansteel-team.test.ts -t "coordinator|progress fingerprint"
```

Expected: 新 event type、actor 和指纹 API 不存在。

- [ ] **Step 4: 实现事件约束**

增加：

```ts
export type AnsteelTeamEventActor = AnsteelRole | "coordinator";
```

`task-assigned` 是 coordinator 唯一允许写入的事件类型；其他事件继续要求三角色 actor。哈希字段继续覆盖
`sequence/type/role/targetRole/challengeId/content/createdAt/previousHash`。

- [ ] **Step 5: 实现稳定任务指纹**

复用现有 Git diff 捕获逻辑，但允许空 diff。指纹内容固定为：

```ts
JSON.stringify({
	status: task.status,
	revision: task.revision,
	testEvidence: task.testEvidence.length,
	submissions: task.submissions.length,
	reviews: task.reviews.length,
	diffHash: createHash("sha256").update(diff, "utf8").digest("hex"),
});
```

最终对上述 JSON 再计算 SHA-256 并返回十六进制字符串。未知任务和非 Git 工作区必须拒绝。

- [ ] **Step 6: 运行 GREEN**

Run:

```powershell
node .\node_modules\vitest\vitest.mjs --run --no-file-parallelism test\ansteel-team.test.ts
```

Expected: `ansteel-team.test.ts` 全部通过。

### Task 3: 解析任务 epoch 配置

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-discussion.ts:334-362`
- Test: `pi-agent/packages/coding-agent/test/ansteel-discussion.test.ts`

- [ ] **Step 1: 写边界 RED 测试**

断言合法配置保留：

```ts
expect(loadConfig({ teamTaskMaxEpochs: 12, teamTaskMaxNoProgressEpochs: 3 })).toMatchObject({
	teamTaskMaxEpochs: 12,
	teamTaskMaxNoProgressEpochs: 3,
});
```

并断言 `0`、`129`、无进展上限大于 epoch 上限均抛出配置错误。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node .\node_modules\vitest\vitest.mjs --run --no-file-parallelism test\ansteel-discussion.test.ts -t "team task epoch"
```

Expected: 字段未被解析或边界未被拒绝。

- [ ] **Step 3: 实现配置**

在 `AnsteelConfig` 增加：

```ts
teamTaskMaxEpochs?: number;
teamTaskMaxNoProgressEpochs?: number;
```

解析时默认不写入，团队扩展使用默认 `8` 和 `2`；显式值分别验证 `1..128`、`1..8`，并要求无进展
上限不大于最大 epoch。

- [ ] **Step 4: 运行 GREEN**

Run:

```powershell
node .\node_modules\vitest\vitest.mjs --run --no-file-parallelism test\ansteel-discussion.test.ts -t "team task epoch"
```

Expected: 新配置测试通过。

### Task 4: 实现结构化 task 命令和进展循环

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts`
- Test: `pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts`

- [ ] **Step 1: 扩展测试 session 审计接口**

`setup()` 的 fake session 支持可注入的阶段审计，并在任务 prompt 中由测试回调直接调用
`options.taskOperations`，不模拟生产状态：

```ts
getLastStageAudit: () => ({
	events: [{ type: "tool-execution-end", elapsedMs: 1, toolName: "edit", isError: false }],
}),
```

- [ ] **Step 2: 写任务登记 RED 测试**

启动团队后执行：

```ts
await command(
	'task {"id":"TASK-1","owner":"staff-engineer","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"npm test passes","dependsOn":[]}',
	ctx,
);
```

断言 state 中只有一个 Staff 任务，事件包含 coordinator 的 `task-assigned`，任务 owner 收到的 prompt
包含精确文件、验收条件和 `ansteel_submit_change`。

- [ ] **Step 3: 写恢复与有界停止 RED 测试**

分别覆盖：

- 第一 epoch 修改文件并返回截断错误，第二 epoch 提交并获得双批准；
- 连续两个 epoch 没有任务指纹变化后停止，最后事件为 `owner-no-progress`；
- `teamTaskMaxEpochs: 1` 时有进展但未提交，停止为 `task-epoch-limit`；
- `task TASK-1` 恢复现有未终止任务，不创建重复任务。

- [ ] **Step 4: 运行 RED**

Run:

```powershell
node .\node_modules\vitest\vitest.mjs --run --no-file-parallelism test\ansteel-team-extension.test.ts -t "coordinator task|owner progress|task epoch"
```

Expected: `task` 命令不存在。

- [ ] **Step 5: 隔离默认角色上下文**

`createDefaultRoleSession` 给 raw session source 增加：

```ts
reset: () => {
	created.session.sessionManager.resetLeaf();
	created.session.agent.state.messages = [];
},
subscribeToAgentEvent: (listener) => created.session.subscribe(listener),
```

并把 `getLastStageAudit` 透传到 `AnsteelTeamRoleSession`。

- [ ] **Step 6: 实现任务命令**

JSON 创建路径严格解析 `id/owner/files/description/acceptanceCriteria/dependsOn`，调用
`claimAnsteelTeamTask`，追加 coordinator `task-assigned`。纯 `TASK-*` 参数只恢复现有任务。
错误 JSON、已批准任务和未知任务都必须写出明确命令失败消息，不进入角色 prompt。

- [ ] **Step 7: 实现任务 epoch**

每轮前后调用 `getAnsteelTeamTaskProgressFingerprint`。owner prompt 不注入完整公共账本，只注入任务、
当前状态、revision 和最新 reject issue。截断错误照常写 `role-failure`；若指纹变化则继续新 epoch，
否则累计无进展次数。到达批准、连续无进展或最大 epoch 后退出。

- [ ] **Step 8: 运行 GREEN**

Run:

```powershell
node .\node_modules\vitest\vitest.mjs --run --no-file-parallelism test\ansteel-team-extension.test.ts
```

Expected: 扩展测试全部通过。

### Task 5: 真实 CLI 确定性回归和文档

**Files:**
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-cli.test.ts`
- Modify: `pi-agent/packages/coding-agent/docs/ansteel.md`

- [ ] **Step 1: 写 RPC CLI RED 测试**

确定性 provider 的 Staff task 阶段依次返回 `write` 和 `ansteel_submit_change` 工具调用；Tech Lead 与 QA
对同一 submission 调用 `ansteel_review_task`。RPC 发送结构化 `task` 命令后断言：

```ts
expect(state.tasks).toEqual([
	expect.objectContaining({ id: "TASK-STAFF", owner: "staff-engineer", status: "approved", revision: 1 }),
]);
expect(events.map((event) => event.type)).toEqual(
	expect.arrayContaining(["task-assigned", "task-submitted", "task-review"]),
);
```

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node .\node_modules\vitest\vitest.mjs --run --no-file-parallelism test\ansteel-team-cli.test.ts -t "coordinator task delivery"
```

Expected: 新命令和事件不存在。

- [ ] **Step 3: 完成 deterministic provider 响应和夹具**

夹具只修改受控 `src/staff.ts`，测试命令使用现有允许列表中的 `node --test test/staff.test.mjs`。
两个 reviewer 必须分别调用一次 `ansteel_review_task`。

- [ ] **Step 4: 更新文档**

在交互团队章节记录：

- `/ansteel-team task <JSON>` 创建并运行任务；
- `/ansteel-team task TASK-ID` 恢复；
- epoch 配置和默认值；
- `length`、空输出、无进展和 epoch 上限的 fail-closed 语义。

- [ ] **Step 5: 运行 GREEN**

Run:

```powershell
node .\node_modules\vitest\vitest.mjs --run --no-file-parallelism test\ansteel-team-cli.test.ts
```

Expected: CLI 测试全部通过。

### Task 6: 完整验证和真实探针

**Files:**
- Modify only if driver contract changes: `docs/superpowers/plans/2026-07-28-ansteel-team-hard-runtime-probe.md`
- Runtime artifacts remain outside the repository.

- [ ] **Step 1: 运行 Ansteel Team 定向套件**

```powershell
node .\node_modules\vitest\vitest.mjs --run --no-file-parallelism test\ansteel-team.test.ts test\ansteel-team-extension.test.ts test\ansteel-team-cli.test.ts test\ansteel-discussion.test.ts
```

Expected: 0 failed。

- [ ] **Step 2: 运行 coding-agent 全量测试与构建**

```powershell
npm test
npm run build
```

Expected: 0 failed，构建退出码 0。

- [ ] **Step 3: 重跑原耐久租约队列探针**

使用新的隔离仓库和 oracle 路径，先建立同一公开/隐藏红灯基线，再通过结构化 task 命令运行真实
Staff。最长运行时间由探针总上限控制；不得写入 API key、环境变量或私有推理。

- [ ] **Step 4: 审计证据**

重新计算事件序号、SHA-256 前向链和 state head；核对：

- 不存在空 `role-report`；
- 不存在 `task-missing`；
- task-assigned、owner epoch、diff、测试和双评审与 state 一致；
- 公开/隐藏测试结果与 Git diff 一致。

- [ ] **Step 5: 提交并推送**

只暂存本计划列出的受控文件，运行 `git diff --check`，以详细中文提交直接推送 `origin/main`。

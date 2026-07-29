# Ansteel Team 可观测性基础实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为完整持续协作协议建立第一块可独立运行的基础：所有团队运行、provider、工具、状态和故障都具有结构化 trace、稳定原因码、耐久日志、内容寻址产物和只读诊断入口。

**Architecture:** 新建独立的 `ansteel-team-observability.ts`，避免继续扩大 `ansteel-team.ts`。模块使用 OpenTelemetry trace/span 语义生成标准关联标识，以同步 JSONL writer 和分段 SHA-256 保证本地可诊断性；现有哈希链协作账本保持独立。核心状态模块只负责在事务、账本和状态持久化边界发出运行记录，扩展层负责为命令、角色阶段和工具操作建立 span。

**Tech Stack:** TypeScript 5.9、Node.js 22、Vitest 4、OpenTelemetry API 1.9、OpenTelemetry Trace SDK 2.10、同步文件系统 API、现有 Pi extension/RPC 测试夹具

---

除明确标注从 `pi-agent` 根目录执行的命令外，本计划所有 `npm`、`npx` 和测试命令均从
`pi-agent/packages/coding-agent` 执行。

## 范围与后续关系

本计划是完整持续协作协议的第一阶段，不把整体目标缩减为日志系统。完成后仍需依次实施：

1. 公开 `WORK_CHECKPOINT`、`PROCESS_ISSUE`、`PROCESS_RESOLUTION` 和共享工作板；
2. 绿色、黄色、红色风险门禁及动态任务负责人；
3. 三轴状态、独立最终验证和依赖解锁；
4. 对抗测试和真实三模型长任务探针。

这些阶段必须复用本计划建立的 trace、原因码、产物和诊断接口，不能各自增加不兼容日志。

## 文件边界

- Create: `pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts`
  - 唯一职责：运行上下文、原因码、脱敏、JSONL writer、内容寻址产物、OpenTelemetry span、日志读取和诊断。
- Create: `pi-agent/packages/coding-agent/test/ansteel-team-observability.test.ts`
  - 唯一职责：验证可观测性模块的格式、耐久性、完整性、脱敏和故障行为。
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team.ts`
  - 只在已有事务、事件和状态持久化边界调用可观测性接口，不在该文件实现日志细节。
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team.test.ts`
  - 验证协作账本、状态和运行日志使用同一关联上下文，且损坏时失败关闭。
- Modify: `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts`
  - 为命令、角色 prompt、任务操作和状态查询建立 run/span；增加只读诊断子命令。
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts`
  - 验证 `status --explain`、`trace`、`doctor`、退出失败和角色阶段关联。
- Modify: `pi-agent/packages/coding-agent/package.json`
  - 增加固定版本 OpenTelemetry 运行依赖。
- Modify: `pi-agent/package-lock.json`
  - 由 `npm install --package-lock-only` 机械更新。
- Modify: `pi-agent/packages/coding-agent/docs/ansteel.md`
  - 记录日志目录、关联字段、诊断命令、脱敏和保留边界。

### Task 1: 固定 OpenTelemetry 依赖与公共类型

**Files:**
- Modify: `pi-agent/packages/coding-agent/package.json`
- Modify: `pi-agent/package-lock.json`
- Create: `pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts`
- Test: `pi-agent/packages/coding-agent/test/ansteel-team-observability.test.ts`

- [ ] **Step 1: 写出原因码、运行上下文和标识格式的失败测试**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ANSTEEL_RUNTIME_REASON_CODES,
	createAnsteelRunContext,
	isAnsteelRuntimeReasonCode,
} from "../src/core/ansteel-team-observability.ts";

const temporaryProjects: string[] = [];

function createTemporaryProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-observability-"));
	temporaryProjects.push(cwd);
	return cwd;
}

afterEach(() => {
	for (const cwd of temporaryProjects.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("Ansteel team observability", () => {
	it("creates stable run and trace identifiers and rejects unknown reason codes", () => {
		const context = createAnsteelRunContext({
			teamId: "ansteel-team-test",
			command: "status --explain",
			now: new Date("2026-07-29T00:00:00.000Z"),
		});

		expect(context.runId).toMatch(/^RUN-/);
		expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(context.startedAt).toBe("2026-07-29T00:00:00.000Z");
		expect(isAnsteelRuntimeReasonCode("provider-timeout")).toBe(true);
		expect(isAnsteelRuntimeReasonCode("made-up-reason")).toBe(false);
		expect(ANSTEEL_RUNTIME_REASON_CODES).toContain("unclassified-runtime-error");
	});
});
```

- [ ] **Step 2: 运行定向测试并确认因模块不存在而失败**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-observability.test.ts
```

Expected: FAIL，错误包含 `Cannot find module '../src/core/ansteel-team-observability.ts'`。

- [ ] **Step 3: 增加固定版本依赖并更新根锁文件**

在 `dependencies` 增加：

```json
"@opentelemetry/api": "1.9.1",
"@opentelemetry/sdk-trace-base": "2.10.0"
```

Run:

```powershell
npm install @opentelemetry/api@1.9.1 @opentelemetry/sdk-trace-base@2.10.0 --workspace @earendil-works/pi-coding-agent --save-exact --package-lock-only --ignore-scripts
```

该命令从 `pi-agent` 根目录执行。Expected: `package-lock.json` 包含 coding-agent workspace 的两个固定
依赖，命令退出 0。

- [ ] **Step 4: 实现公共类型、原因码和上下文创建**

```ts
import { randomBytes, randomUUID } from "node:crypto";

export const ANSTEEL_RUNTIME_REASON_CODES = [
	"provider-timeout",
	"provider-empty-public-output",
	"provider-rate-limited",
	"provider-authentication-failed",
	"tool-exit-nonzero",
	"tool-timeout",
	"tool-policy-denied",
	"process-orphaned",
	"lease-expired",
	"lease-owner-mismatch",
	"revision-drift",
	"diff-hash-mismatch",
	"blocking-process-issue-open",
	"event-chain-invalid",
	"event-fsync-failed",
	"artifact-missing",
	"state-projection-mismatch",
	"budget-exhausted",
	"no-governed-progress",
	"coordinator-restarted",
	"unclassified-runtime-error",
] as const;

export type AnsteelRuntimeReasonCode = (typeof ANSTEEL_RUNTIME_REASON_CODES)[number];

export interface AnsteelRunContext {
	runId: string;
	traceId: string;
	teamId: string;
	command: string;
	startedAt: string;
	resumedFromRunId?: string;
	resumedFromSequence?: number;
}

export function isAnsteelRuntimeReasonCode(value: string): value is AnsteelRuntimeReasonCode {
	return (ANSTEEL_RUNTIME_REASON_CODES as readonly string[]).includes(value);
}

export function createAnsteelRunContext(input: {
	teamId: string;
	command: string;
	now?: Date;
	resumedFromRunId?: string;
	resumedFromSequence?: number;
}): AnsteelRunContext {
	const startedAt = (input.now ?? new Date()).toISOString();
	return {
		runId: `RUN-${randomUUID()}`,
		traceId: randomBytes(16).toString("hex"),
		teamId: input.teamId,
		command: input.command,
		startedAt,
		...(input.resumedFromRunId === undefined ? {} : { resumedFromRunId: input.resumedFromRunId }),
		...(input.resumedFromSequence === undefined ? {} : { resumedFromSequence: input.resumedFromSequence }),
	};
}
```

- [ ] **Step 5: 运行测试并确认通过**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-observability.test.ts
```

Expected: PASS，1 test。

- [ ] **Step 6: 提交第一块类型基础**

```powershell
git add -- packages/coding-agent/package.json package-lock.json packages/coding-agent/src/core/ansteel-team-observability.ts packages/coding-agent/test/ansteel-team-observability.test.ts
git commit -m "feat(鞍钢日志): 建立运行追踪类型与稳定原因码"
git push origin main
```

### Task 2: 实现脱敏、内容寻址产物和耐久 JSONL

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-observability.test.ts`

- [ ] **Step 1: 写出脱敏、产物哈希和日志落盘失败测试**

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	createAnsteelRuntimeLogger,
	getAnsteelRuntimeLogDirectory,
	readAnsteelRuntimeLogs,
} from "../src/core/ansteel-team-observability.ts";

it("redacts secrets, stores large output by hash, and writes structured JSONL", () => {
	const cwd = createTemporaryProject();
	const context = createAnsteelRunContext({ teamId: "team-1", command: "task TASK-1" });
	const logger = createAnsteelRuntimeLogger(cwd, context);

	const entry = logger.write({
		level: "error",
		eventName: "tool.call.completed",
		outcome: "failed",
		reasonCode: "tool-exit-nonzero",
		message: "command failed",
		data: { authorization: "Bearer top-secret", exitCode: 1 },
		artifacts: [{ kind: "stderr", content: "API_KEY=top-secret\nfailure" }],
	});
	logger.close();

	expect(entry.data.authorization).toBe("[REDACTED]");
	expect(entry.artifactRefs[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
	expect(readFileSync(entry.artifactRefs[0]!.storageId, "utf8")).not.toContain("top-secret");
	expect(readAnsteelRuntimeLogs(cwd, context.runId)).toHaveLength(1);
	expect(existsSync(getAnsteelRuntimeLogDirectory(cwd))).toBe(true);
});
```

- [ ] **Step 2: 运行测试并确认缺少 writer**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-observability.test.ts
```

Expected: FAIL，错误指向 `createAnsteelRuntimeLogger` 未导出。

- [ ] **Step 3: 实现规范日志类型、递增序号和递归脱敏**

定义：

```ts
export interface AnsteelRuntimeLogEntry {
	schemaVersion: 1;
	timestampUtc: string;
	monotonicElapsedNs: string;
	sequence: number;
	level: "debug" | "info" | "warn" | "error" | "audit";
	eventName: string;
	outcome: "started" | "progress" | "succeeded" | "failed" | "cancelled" | "abandoned";
	reasonCode?: AnsteelRuntimeReasonCode;
	runId: string;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	teamId: string;
	role?: "tech-lead" | "staff-engineer" | "qa-engineer" | "coordinator";
	sessionId?: string;
	taskId?: string;
	checkpointId?: string;
	issueId?: string;
	toolCallId?: string;
	providerRequestId?: string;
	processId?: string;
	leaseId?: string;
	revision?: number;
	diffHash?: string;
	causeEventId?: string;
	message: string;
	data: Record<string, unknown>;
	artifactRefs: Array<{ kind: string; sha256: string; storageId: string }>;
	previousHash: string | null;
	hash: string;
}

export type AnsteelRuntimeLogInput = Omit<
	AnsteelRuntimeLogEntry,
	| "schemaVersion"
	| "timestampUtc"
	| "monotonicElapsedNs"
	| "sequence"
	| "runId"
	| "traceId"
	| "spanId"
	| "teamId"
	| "artifactRefs"
	| "previousHash"
	| "hash"
> & {
	spanId?: string;
	artifacts?: Array<{ kind: string; content: string }>;
};
```

递归脱敏必须按字段名识别 `authorization`、`apiKey`、`api_key`、`token`、`cookie`、`secret`、
`password` 和 `privateKey`，字符串内容额外识别 `Bearer ...`、`sk-...` 和环境变量赋值。产物在计算哈希
与落盘前使用同一脱敏器。

- [ ] **Step 4: 用同步文件描述符实现关键记录落盘**

`createAnsteelRuntimeLogger()` 必须：

1. 在 `.pi/ansteel-team/logs/` 创建 `run-<runId>-0001.jsonl`；
2. 在 `.pi/ansteel-team/artifacts/` 按 SHA-256 保存脱敏产物；
3. 使用 `openSync`、`writeSync`、`fsyncSync`、`closeSync` 写关键记录；
4. 每条记录包含上一条日志哈希；
5. 写入失败抛出带 `event-fsync-failed` 的 `AnsteelObservabilityError`；
6. `close()` 后拒绝继续写入；
7. `readAnsteelRuntimeLogs()` 校验序号、前序哈希和当前哈希。

- [ ] **Step 5: 运行日志测试并确认通过**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-observability.test.ts
```

Expected: PASS，脱敏后的日志和产物中均不存在测试秘密。

- [ ] **Step 6: 提交耐久日志 writer**

```powershell
git add -- packages/coding-agent/src/core/ansteel-team-observability.ts packages/coding-agent/test/ansteel-team-observability.test.ts
git commit -m "feat(鞍钢日志): 增加脱敏耐久日志与内容寻址产物"
git push origin main
```

### Task 3: 接入 OpenTelemetry span 并保持本地日志为强制出口

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-observability.test.ts`

- [ ] **Step 1: 写出父子 span 和完成出口失败测试**

```ts
it("exports nested OpenTelemetry spans with the same trace and parent relationship", async () => {
	const cwd = createTemporaryProject();
	const context = createAnsteelRunContext({ teamId: "team-1", command: "ask" });
	const logger = createAnsteelRuntimeLogger(cwd, context);
	const root = logger.startSpan("run.started", { role: "coordinator" });
	const child = logger.startSpan("provider.request", { role: "tech-lead", parent: root });

	child.end({ outcome: "failed", reasonCode: "provider-timeout", message: "provider timed out" });
	root.end({ outcome: "failed", reasonCode: "provider-timeout", message: "run failed" });
	await logger.forceFlush();
	logger.close();

	const logs = readAnsteelRuntimeLogs(cwd, context.runId);
	const childEnd = logs.find((entry) => entry.eventName === "provider.request" && entry.outcome === "failed");
	expect(childEnd?.traceId).toBe(context.traceId);
	expect(childEnd?.parentSpanId).toBe(root.spanId);
});
```

- [ ] **Step 2: 运行测试并确认 `startSpan` 不存在**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-observability.test.ts
```

Expected: FAIL，错误指向 `logger.startSpan`。

- [ ] **Step 3: 实现显式父子 span**

使用 `BasicTracerProvider`、自定义 `IdGenerator` 和自定义 `SpanExporter`。不要注册全局 tracer
provider，避免覆盖宿主应用。每个 logger 拥有一个 provider；`IdGenerator.generateTraceId()` 固定返回
`AnsteelRunContext.traceId`，`generateSpanId()` 使用 8 字节加密随机数。`startSpan()` 显式接收父 span
context，开始时写 `started`，结束 exporter 写终态；`forceFlush()` 调用 provider 的 `forceFlush()`。
Ansteel 关联字段作为 span attributes，同时保留日志顶层字段便于本地查询。

- [ ] **Step 4: 覆盖重复 end 和 exporter 失败**

增加测试确保：

- span 只能结束一次；
- exporter 写入失败使 `forceFlush()` 拒绝；
- exporter 失败写入最小 stderr 告警，但不包含秘密；
- 未结束 span 在 logger 恢复时追加 `abandoned/coordinator-restarted`。

- [ ] **Step 5: 运行测试并确认通过**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-observability.test.ts
```

Expected: PASS。

- [ ] **Step 6: 提交 OpenTelemetry bridge**

```powershell
git add -- packages/coding-agent/src/core/ansteel-team-observability.ts packages/coding-agent/test/ansteel-team-observability.test.ts
git commit -m "feat(鞍钢日志): 接入OpenTelemetry父子追踪"
git push origin main
```

### Task 4: 接入团队账本、事务和状态持久化边界

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team.test.ts`

- [ ] **Step 1: 写出事件和状态使用同一 trace 的失败测试**

```ts
it("records ledger append, fsync, and state persistence under one trace", () => {
	const cwd = createTemporaryProject();
	const team = createTeam(cwd);
	const context = createAnsteelRunContext({ teamId: team.id, command: "ask" });
	const logger = createAnsteelRuntimeLogger(cwd, context);

	appendAnsteelTeamEvent(
		cwd,
		team,
		{ type: "role-report", role: "tech-lead", content: "checkpoint" },
		{ logger, causeEventId: undefined },
	);
	logger.close();

	const logs = readAnsteelRuntimeLogs(cwd, context.runId);
	expect(logs.map((entry) => entry.eventName)).toEqual(
		expect.arrayContaining(["event.appended", "event.fsync.completed", "state.persisted"]),
	);
	expect(logs.every((entry) => entry.traceId === context.traceId)).toBe(true);
});
```

- [ ] **Step 2: 运行测试并确认函数签名尚不支持日志上下文**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team.test.ts -t "records ledger append"
```

Expected: FAIL，TypeScript 或断言表明缺少可观测性选项。

- [ ] **Step 3: 增加可选持久化上下文而不破坏旧调用者**

定义：

```ts
export interface AnsteelTeamPersistenceContext {
	logger: AnsteelRuntimeLogger;
	causeEventId?: string;
}
```

给 `appendAnsteelTeamEvent`、`saveAnsteelTeamState` 和事务恢复增加最后一个可选参数。每个关键边界记录
`started/succeeded/failed`，失败必须带稳定原因码；不传上下文时保持现有测试和公共 API 行为。

- [ ] **Step 4: 把普通 append 替换为显式 fsync**

协作事件与 pending transaction 必须使用共享的 `writeDurableFile`/`appendDurableLine` 辅助函数：

- 临时状态文件写入后 `fsync`，再原子 rename；
- 事件行 append 后 `fsync`；
- 只有两者成功才删除 transaction；
- 任一步失败记录精确原因并保留 transaction；
- 恢复时记录 `run.resumed`、原事务状态和采取的分支。

- [ ] **Step 5: 运行原有与新增核心测试**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team.test.ts test/ansteel-team-observability.test.ts
```

Expected: PASS；原有迁移、哈希链和中断事务测试不得回归。

- [ ] **Step 6: 提交核心持久化接入**

```powershell
git add -- packages/coding-agent/src/core/ansteel-team.ts packages/coding-agent/test/ansteel-team.test.ts
git commit -m "feat(鞍钢日志): 追踪账本事务与状态持久化"
git push origin main
```

### Task 5: 提供 trace、doctor 和事故包查询

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-observability.test.ts`

- [ ] **Step 1: 写出查询、完整性诊断和事故包失败测试**

```ts
it("explains the first cause and returns non-healthy for a damaged artifact", () => {
	const cwd = createTemporaryProject();
	const context = createAnsteelRunContext({ teamId: "team-1", command: "task TASK-1" });
	const logger = createAnsteelRuntimeLogger(cwd, context);
	const failed = logger.write({
		level: "error",
		eventName: "tool.call.completed",
		outcome: "failed",
		reasonCode: "tool-exit-nonzero",
		message: "test failed",
		data: { exitCode: 1 },
		artifacts: [{ kind: "stderr", content: "assertion failed" }],
	});
	logger.close();
	writeFileSync(failed.artifactRefs[0]!.storageId, "tampered", "utf8");

	const diagnosis = diagnoseAnsteelTeamRun(cwd, context.runId);
	expect(diagnosis.healthy).toBe(false);
	expect(diagnosis.rootCause).toMatchObject({
		reasonCode: "tool-exit-nonzero",
		eventName: "tool.call.completed",
	});
	expect(diagnosis.issues).toContainEqual(expect.objectContaining({ reasonCode: "artifact-missing" }));
});
```

- [ ] **Step 2: 运行测试并确认诊断函数不存在**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-observability.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现只读查询**

实现：

```ts
listAnsteelRuntimeRuns(cwd)
traceAnsteelTeamRuntime(cwd, selector)
diagnoseAnsteelTeamRun(cwd, runId)
createAnsteelTeamIncidentBundle(cwd, runId)
formatAnsteelTeamDiagnosis(diagnosis)
```

查询必须：

- 校验日志段链、记录链和所有引用产物；
- 按 `traceId/taskId/issueId/toolCallId` 过滤；
- 找出最早失败 span，而不是最后一条传播错误；
- 列出最后受治理进展、开放 span、最近状态转换和可恢复点；
- 事故包只引用既有机械事实并对 manifest 自身计算 SHA-256；
- 健康返回 `healthy: true`，任何完整性或终态问题返回 `healthy: false`。

- [ ] **Step 4: 运行模块测试**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-observability.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交诊断能力**

```powershell
git add -- packages/coding-agent/src/core/ansteel-team-observability.ts packages/coding-agent/test/ansteel-team-observability.test.ts
git commit -m "feat(鞍钢日志): 增加运行诊断与脱敏事故包"
git push origin main
```

### Task 6: 接入扩展命令、角色阶段和任务操作

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts`

- [ ] **Step 1: 写出 `status --explain`、`trace` 和失败角色 span 测试**

在扩展 harness 中启动团队，使 Tech Lead prompt 抛出 `provider timeout`，然后断言：

```ts
await expect(command.handler("ask inspect", harness.context)).rejects.toThrow("provider timeout");
const capturedRunId = listAnsteelRuntimeRuns(harness.context.cwd).at(-1)?.runId;
expect(capturedRunId).toBeDefined();
await command.handler("status --explain", harness.context);
await command.handler(`trace ${capturedRunId!}`, harness.context);

expect(harness.notifications.at(-2)?.message).toContain("provider-timeout");
expect(harness.notifications.at(-2)?.message).toContain(capturedRunId!);
expect(harness.notifications.at(-1)?.message).toContain("role.session");
```

- [ ] **Step 2: 运行测试并确认当前命令解析拒绝诊断子命令**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-extension.test.ts -t "explains a failed role run"
```

Expected: FAIL。

- [ ] **Step 3: 为每条命令创建 run 和根 span**

新增 `runObservedCommand()`：

```ts
async function runObservedCommand<T>(
	cwd: string,
	teamId: string,
	command: string,
	action: (logger: AnsteelRuntimeLogger, root: AnsteelRuntimeSpan) => Promise<T>,
): Promise<T>
```

规则：

- 命令开始写 `run.started`；
- 角色 prompt 建立 `role.session` 与 `provider.request` 子 span；
- task submit/review、测试和 milestone 建立工具或状态子 span；
- timeout 映射 `provider-timeout`，空公开输出映射 `provider-empty-public-output`；
- 未分类异常保留脱敏异常栈产物并使用 `unclassified-runtime-error`；
- finally 强制 flush 和 close；
- 原异常继续抛出，CLI/RPC 不得错误退出零。

- [ ] **Step 4: 扩展命令解析**

支持：

```text
/ansteel-team status --explain
/ansteel-team trace <runId|traceId|taskId|issueId|toolCallId>
/ansteel-team doctor [runId]
/ansteel-team incident <runId>
```

所有命令只读。`doctor` 不信任内存状态，必须重新读取账本、日志和产物；不健康时向调用方返回错误状态，
同时仍显示诊断内容。

- [ ] **Step 5: 运行扩展和 CLI/RPC 回归**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-extension.test.ts test/ansteel-team-cli.test.ts
```

Expected: PASS。

- [ ] **Step 6: 提交扩展接入**

```powershell
git add -- packages/coding-agent/src/extensions/ansteel-team/index.ts packages/coding-agent/test/ansteel-team-extension.test.ts
git commit -m "feat(鞍钢日志): 接入团队命令与角色全链路追踪"
git push origin main
```

### Task 7: 文档、完整验证和阶段验收

**Files:**
- Modify: `pi-agent/packages/coding-agent/docs/ansteel.md`
- Modify: `docs/superpowers/plans/2026-07-29-ansteel-team-observability-foundation.md`

- [ ] **Step 1: 更新运行文档**

文档必须精确说明：

- 四类持久记录及路径；
- 哪些内容长期保留、哪些内容轮转；
- 统一关联 ID 与原因码；
- 四个诊断命令及退出语义；
- 日志不包含 API Key、认证头、环境变量值和隐藏思维链；
- 本阶段只完成可观测性基础，持续协作工具和三轴状态仍在后续阶段。

- [ ] **Step 2: 运行定向测试**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-observability.test.ts test/ansteel-team.test.ts test/ansteel-team-extension.test.ts test/ansteel-team-cli.test.ts
```

Expected: 全部 PASS，无挂起进程。

- [ ] **Step 3: 运行 coding-agent 构建**

Run:

```powershell
npm run build
```

Expected: 退出 0，TypeScript 构建和资源复制完成。

- [ ] **Step 4: 运行依赖一致性检查**

从 `pi-agent` 根目录运行：

```powershell
npm run check:pinned-deps
npm run check:ts-imports
npm run check:install-lock:coding-agent
```

Expected: 全部退出 0。若 install-lock 因新增依赖变化，运行项目提供的生成脚本更新
`packages/coding-agent/install-lock`，重新执行检查。

- [ ] **Step 5: 做日志安全审计**

在测试临时目录生成包含伪 API Key 的失败运行，递归搜索 `.pi/ansteel-team/`：

```powershell
rg -n "top-secret|Bearer test|sk-test" <temporary-project>/.pi/ansteel-team
```

Expected: 没有匹配；`doctor` 仍能通过哈希引用定位脱敏事故。

- [ ] **Step 6: 更新计划复选框并提交阶段结果**

```powershell
git add -- packages/coding-agent/docs/ansteel.md docs/superpowers/plans/2026-07-29-ansteel-team-observability-foundation.md
git commit -m "docs(鞍钢日志): 完成可观测性基础阶段验收"
git push origin main
```

- [ ] **Step 7: 阶段完成审计**

逐项核对本计划 Goal：

- 任意失败具有 `runId/traceId/spanId/reasonCode`；
- 日志、账本和产物能交叉验证；
- 诊断命令从磁盘重建事实；
- secrets 不落盘；
- 原有治理测试无回归。

只有以上全部有当前测试、构建和磁盘产物证据时，才把实施总计划的“可观测性基础”标为完成。不得把本
阶段完成描述为整个持续协作协议已经完成。

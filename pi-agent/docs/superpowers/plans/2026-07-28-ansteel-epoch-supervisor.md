# Ansteel Epoch Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一个 Ansteel 审查在多个短生命周期 CLI epoch 间自动续跑，同时只以持久化检查点决定继续或停止。

**Architecture:** 新建 `cli/ansteel-supervisor.ts` 作为可注入的监督器核心：它拥有项目锁、调用一次 epoch 执行器、重新读取检查点并产生终态或下一轮动作。 `main.ts` 仅把监督器参数转换为子进程执行器；每个子进程继续使用原有 `--ansteel` 或 `--ansteel-resume` 路径创建并销毁全部角色会话。

**Tech Stack:** TypeScript ESM、Node `child_process`/ `fs`、Vitest、既有 `loadAnsteelRunCheckpoint()`、现有 Ansteel CLI 确定性 Provider 扩展。

## Global Constraints

- 不修改三角色治理顺序、模型身份校验、阶段预算、项目硬截止时间、检查点 JSON 格式或报告语义。
- 监督器不得创建 `AgentSession`、调用 Provider、解析角色回答或从 stdout/Markdown 推导状态。
- 每轮只能从 `loadAnsteelRunCheckpoint()` 读取 `ready-to-resume` 决定续跑；任何其他非终态、缺失或歧义均失败关闭。
- 默认最大 `64` 个 epoch，上限 `128`；达到上限保持可恢复检查点并返回非零。
- 锁路径固定为 `<cwd>/.pi/ansteel-supervisor.lock`；仅确认锁主 PID 已退出时才清理孤儿锁。
- 每个任务完成后运行目标测试，提交使用详细中文信息并直接推送 `main`；不提交工作区根目录的用户未跟踪文件。

---

### Task 1: 监督器核心与失败关闭循环

**Files:**
- Create: `packages/coding-agent/src/cli/ansteel-supervisor.ts`
- Create: `packages/coding-agent/test/ansteel-supervisor.test.ts`
- Read: `packages/coding-agent/src/core/ansteel-run.ts:372-428`

**Interfaces:**
- Consumes: `loadAnsteelRunCheckpoint(path)`、`getAnsteelRunCheckpointPath(cwd, runId)`、`AnsteelRunCheckpointStatus`。
- Produces: `runAnsteelEpochSupervisor(options): Promise<AnsteelEpochSupervisorResult>`，其中 `options.runEpoch({ kind, runId?, topic? })` 返回子进程退出码，`options.listRunIds()` 与 `options.loadCheckpoint(runId)` 用于注入文件系统。
- Produces: `AnsteelEpochSupervisorResult = { outcome: "terminal" | "limit-reached" | "child-failed" | "invalid-checkpoint"; runId?: string; epochsStarted: number; exitCode: number }`。

- [ ] **Step 1: Write the failing test**

```ts
it("starts a new epoch, resumes its only paused checkpoint, and stops at terminal state", async () => {
  const calls: Array<{ kind: "new" | "resume"; runId?: string; topic?: string }> = [];
  const result = await runAnsteelEpochSupervisor({
    topic: "Long review",
    maxEpochs: 4,
    listRunIds: () => calls.length === 0 ? [] : ["ansteel-run-new"],
    loadCheckpoint: () => ({ id: "ansteel-run-new", status: calls.length === 1 ? "ready-to-resume" : "completed" }),
    runEpoch: async (call) => { calls.push(call); return 0; },
  });
  expect(calls).toEqual([
    { kind: "new", topic: "Long review" },
    { kind: "resume", runId: "ansteel-run-new" },
  ]);
  expect(result).toMatchObject({ outcome: "terminal", runId: "ansteel-run-new", epochsStarted: 2, exitCode: 0 });
});
```

同一文件增加表驱动用例：首次执行前后有两个新 run ID、子进程返回 `1`、零退出却没有检查点、恢复后是 `waiting-provider`、以及达到 `maxEpochs`。每个用例断言不会多调用 `runEpoch`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run --no-file-parallelism packages/coding-agent/test/ansteel-supervisor.test.ts`

Expected: FAIL，错误指向缺少 `../src/cli/ansteel-supervisor.ts` 或 `runAnsteelEpochSupervisor`。

- [ ] **Step 3: Write minimal implementation**

```ts
export async function runAnsteelEpochSupervisor(options: AnsteelEpochSupervisorOptions): Promise<AnsteelEpochSupervisorResult> {
  let runId = options.resumeRunId;
  for (let epoch = 0; epoch < options.maxEpochs; epoch++) {
    const before = runId === undefined ? new Set(options.listRunIds()) : undefined;
    const exitCode = await options.runEpoch(runId === undefined ? { kind: "new", topic: options.topic! } : { kind: "resume", runId });
    if (exitCode !== 0) return { outcome: "child-failed", runId, epochsStarted: epoch + 1, exitCode };
    if (runId === undefined) runId = getOnlyNewRunId(before!, options.listRunIds());
    const checkpoint = options.loadCheckpoint(runId);
    if (checkpoint.status === "ready-to-resume") continue;
    if (checkpoint.status === "completed" || checkpoint.status === "failed" || checkpoint.status === "expired") {
      return { outcome: "terminal", runId, epochsStarted: epoch + 1, exitCode: 0 };
    }
    return { outcome: "invalid-checkpoint", runId, epochsStarted: epoch + 1, exitCode: 1 };
  }
  return { outcome: "limit-reached", runId, epochsStarted: options.maxEpochs, exitCode: 1 };
}
```

`getOnlyNewRunId()` 必须对差集大小不等于 1 抛出带上下文的错误；恢复模式不得调用 `listRunIds()` 选择其他 run。文件系统适配器在本模块中用 `readdirSync(join(cwd, ".pi", "ansteel-runs"))` 与现有检查点加载 API 实现。

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run --no-file-parallelism packages/coding-agent/test/ansteel-supervisor.test.ts`

Expected: PASS，覆盖新建、恢复、终态、非零子进程、歧义、异常状态和上限。

- [ ] **Step 5: Commit**

```powershell
git add packages/coding-agent/src/cli/ansteel-supervisor.ts packages/coding-agent/test/ansteel-supervisor.test.ts
git commit -m "feat(鞍钢): 增加可恢复 epoch 监督器核心" -m "以检查点状态驱动短生命周期审查续跑，并对歧义和非法状态失败关闭。"
```

### Task 2: 原子锁与进程存活恢复

**Files:**
- Modify: `packages/coding-agent/src/cli/ansteel-supervisor.ts`
- Modify: `packages/coding-agent/test/ansteel-supervisor.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `runAnsteelEpochSupervisor()`。
- Produces: `runAnsteelEpochSupervisorWithLock(options): Promise<AnsteelEpochSupervisorResult>`。
- Produces: `AnsteelSupervisorLockOwner = { version: 1; pid: number; startedAt: string; runId?: string }`。

- [ ] **Step 1: Write the failing test**

```ts
it("rejects a live supervisor lock without starting an epoch", async () => {
  writeFileSync(lockPath, JSON.stringify({ version: 1, pid: 42, startedAt: "2026-07-28T00:00:00.000Z" }));
  await expect(runAnsteelEpochSupervisorWithLock({
    cwd, topic: "Long review", maxEpochs: 1, runEpoch, listRunIds, loadCheckpoint,
    isProcessAlive: (pid) => pid === 42,
  })).rejects.toThrow("already owns this project");
  expect(runEpoch).not.toHaveBeenCalled();
});

it("removes a confirmed-dead lock and releases its own lock after terminal completion", async () => {
  writeFileSync(lockPath, JSON.stringify({ version: 1, pid: 41, startedAt: "2026-07-28T00:00:00.000Z" }));
  await runAnsteelEpochSupervisorWithLock({
    cwd, topic: "Long review", maxEpochs: 1, runEpoch, listRunIds, loadCheckpoint,
    isProcessAlive: () => false,
  });
  expect(existsSync(lockPath)).toBe(false);
});
```

额外断言损坏 JSON、缺少整数 PID 和 `isProcessAlive()` 抛出 `EPERM` 都不会删除锁且失败关闭。

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run --no-file-parallelism packages/coding-agent/test/ansteel-supervisor.test.ts`

Expected: FAIL，错误指向 `runAnsteelEpochSupervisorWithLock` 未定义。

- [ ] **Step 3: Write minimal implementation**

使用 `mkdirSync(join(cwd, ".pi"), { recursive: true })` 与 `writeFileSync(lockPath, json, { flag: "wx" })` 获取锁。遇到 `EEXIST` 时只解析版本 `1`、非负整数 PID 与 ISO 时间；调用 `process.kill(pid, 0)` 的适配器确认死亡后使用 `unlinkSync(lockPath)`，再尝试一次 `wx` 获取。任何其他条件抛出明确错误。

把释放函数放进 `try/finally`，使成功、子进程失败和监督器异常都删除自身锁。释放函数幂等；更新锁的 run ID 时通过写入临时文件后 `renameSync()` 原子替换。

- [ ] **Step 4: Run lock and core regression**

Run: `node_modules/.bin/vitest run --no-file-parallelism packages/coding-agent/test/ansteel-supervisor.test.ts`

Expected: PASS，活锁不启动、死锁接管、损坏锁失败关闭、全部退出路径清理。

- [ ] **Step 5: Commit**

```powershell
git add packages/coding-agent/src/cli/ansteel-supervisor.ts packages/coding-agent/test/ansteel-supervisor.test.ts
git commit -m "feat(鞍钢): 为 epoch 监督器加入互斥与孤儿锁恢复" -m "只接管已确认死亡的监督器锁，并在所有可控退出路径清理自身锁。"
```

### Task 3: CLI 参数与短生命周期子进程适配

**Files:**
- Modify: `packages/coding-agent/src/cli/args.ts`
- Modify: `packages/coding-agent/src/main.ts`
- Modify: `packages/coding-agent/test/args.test.ts`
- Modify: `packages/coding-agent/test/ansteel-supervisor.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `runAnsteelEpochSupervisor()` 和 Task 2 的锁包装器。
- Produces: `Args.ansteelSupervise?: string`、`Args.ansteelSuperviseResume?: string`、`Args.ansteelSuperviseMaxEpochs?: number`。
- Produces: `runAnsteelSupervisorCli({ args, cwd, spawnEpoch })`，供 `main()` 在创建运行时与角色会话前调用。

- [ ] **Step 1: Write the failing test**

```ts
test("parses supervision modes and rejects Ansteel mode conflicts", () => {
  expect(parseArgs(["--ansteel-supervise", "Review", "--ansteel-supervise-max-epochs", "2"])).toMatchObject({
    ansteelSupervise: "Review", ansteelSuperviseMaxEpochs: 2,
  });
  for (const argv of [
    ["--ansteel-supervise", "Review", "--ansteel", "Other"],
    ["--ansteel-supervise-resume", "../run"],
    ["--ansteel-supervise-max-epochs", "0"],
    ["--ansteel-supervise-max-epochs", "129"],
  ]) expect(parseArgs(argv).diagnostics.some((item) => item.type === "error")).toBe(true);
});
```

在监督器测试加入 `spawnEpoch` 记录：首轮参数包含 `--ansteel Review`，第二轮只包含 `--ansteel-resume ansteel-run-new`，两轮均保留 `-e provider.ts`，均不包含监督器选择器。

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run --no-file-parallelism packages/coding-agent/test/args.test.ts packages/coding-agent/test/ansteel-supervisor.test.ts`

Expected: FAIL，错误指向未识别的监督器参数或缺少 CLI 适配入口。

- [ ] **Step 3: Write minimal implementation**

在 `parseArgs()` 中只接受下列形态：

```text
--ansteel-supervise <topic>
--ansteel-supervise-resume <safe-run-id>
--ansteel-supervise-max-epochs <1..128>
```

在 `main(args)` 完成 `help/version/diagnostics` 后、`createAgentSessionRuntime()` 前分派监督器，避免父进程创建模型会话。子进程使用 `spawn(process.execPath, childArgs, { cwd, env: process.env, stdio: "inherit" })`；Node 运行时的 `childArgs` 以当前 CLI 入口文件开头，Bun 编译二进制则使用空入口参数。子进程参数从原始 `args` 中仅剔除监督器选择器和最大值，再附加恰好一个 `--ansteel <topic>` 或 `--ansteel-resume <run-id>`。若入口路径不可用则明确失败，不退回为同进程调用。

- [ ] **Step 4: Run parameter and supervisor tests**

Run: `node_modules/.bin/vitest run --no-file-parallelism packages/coding-agent/test/args.test.ts packages/coding-agent/test/ansteel-supervisor.test.ts`

Expected: PASS，子进程参数保留扩展和认证选项，且每轮只替换 Ansteel 选择器。

- [ ] **Step 5: Commit**

```powershell
git add packages/coding-agent/src/cli/args.ts packages/coding-agent/src/main.ts packages/coding-agent/test/args.test.ts packages/coding-agent/test/ansteel-supervisor.test.ts
git commit -m "feat(鞍钢): 提供自动续跑的 CLI 监督入口" -m "监督器在不创建角色会话的前提下调度独立的 Ansteel epoch 子进程。"
```

### Task 4: 确定性真实 CLI 续跑与文档

**Files:**
- Modify: `packages/coding-agent/test/ansteel-cli.test.ts`
- Modify: `packages/coding-agent/docs/ansteel.md`
- Modify: `packages/coding-agent/docs/ansteel-adaptive-budget-plan.md`

**Interfaces:**
- Consumes: Task 3 的 `pi --ansteel-supervise` CLI。
- Produces: 一个跨两个真实子进程的集成回归，以及用户可执行的长任务命令说明。

- [ ] **Step 1: Write the failing real CLI integration test**

在 `ansteel-cli.test.ts` 新增确定性 Provider 扩展：Tech Lead 首次 architecture 响应延迟至少 `20ms`；项目配置设 `adaptiveBudgetPolicy: { enabled: true, epochTimeoutMs: 1, projectTimeoutMs: 5000, maxProjectToolCalls: 20, protectedVerificationTimeMs: 100, protectedVerificationToolCalls: 10 }`。调用：

```ts
const result = await runCli(projectDir, agentDir, [
  "--ansteel-supervise", "Complete two epochs", "--ansteel-supervise-max-epochs", "4",
]);
expect(result.code).toBe(0);
expect(result.stdout).toContain("Ansteel review paused:");
expect(result.stdout).toContain("Ansteel review approved:");
expect(readdirSync(join(projectDir, ".pi", "ansteel-runs"))).toHaveLength(1);
expect(existsSync(join(projectDir, ".pi", "ansteel-supervisor.lock"))).toBe(false);
```

确定性共识文本不得声明人工总数，必须引用协调器不可变台账，避免该集成测试被已有 `invalid-ledger-summary` 门禁拒绝。

- [ ] **Step 2: Run test to verify it fails**

Run: `node packages/coding-agent/node_modules/vitest/vitest.mjs --run --no-file-parallelism packages/coding-agent/test/ansteel-cli.test.ts`

Expected: FAIL，CLI 将 `--ansteel-supervise` 作为未知参数或没有产生自动恢复的批准报告。

- [ ] **Step 3: Complete minimal integration adaptation and update docs**

仅为集成测试所揭示的问题修正 Task 1-3 的适配层。更新 `ansteel.md`：说明两个命令、默认/上限、锁冲突、`SUPERVISOR_STOPPED` 的非终态含义、手动恢复前必须停止监督器，以及每个 epoch 都建立新的角色会话。更新自适应计划第 9/11/13 节，将“后续 runner 或外部调度器”更新为本地监督器已实现，同时保留外部调度器可调用该命令的边界。

- [ ] **Step 4: Run complete Ansteel verification**

Run: `node packages/coding-agent/node_modules/vitest/vitest.mjs --run --no-file-parallelism packages/coding-agent/test/ansteel-discussion.test.ts packages/coding-agent/test/ansteel-adaptive-budget.test.ts packages/coding-agent/test/ansteel-cli.test.ts packages/coding-agent/test/ansteel-team.test.ts packages/coding-agent/test/ansteel-team-cli.test.ts packages/coding-agent/test/ansteel-team-extension.test.ts`

Expected: PASS，包含新的两 epoch CLI 场景。

- [ ] **Step 5: Build, check, commit, and push**

Run: `npm run build; node_modules/.bin/tsgo --noEmit -p packages/coding-agent/tsconfig.build.json; git diff --check`

Expected: 所有命令退出 `0`。

```powershell
git add packages/coding-agent/test/ansteel-cli.test.ts packages/coding-agent/docs/ansteel.md packages/coding-agent/docs/ansteel-adaptive-budget-plan.md
git commit -m "feat(鞍钢): 让长任务按 epoch 自动续跑" -m "通过持久化检查点监督独立短生命周期审查进程，避免数小时任务持有模型会话。"
git push origin main
```

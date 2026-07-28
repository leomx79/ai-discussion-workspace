# Ansteel Team 高难度真实编码探针执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在隔离仓库中运行真实 `/ansteel-team`，客观验证受控写入、测试、冻结 diff、双评审和隐藏验收。

**Architecture:** 主仓库只保存设计和计划；公开夹具位于 `C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632`，隐藏验收与 RPC 记录位于相邻的 `ansteel-team-hard-probe-oracle-20260728-230632`。使用当前 `main` 的 Pi 源码和本机已有认证启动 RPC，不向夹具写入凭据。

**Tech Stack:** Node.js 22、ES modules、`node:test`、PowerShell、Git、Pi RPC、Ansteel Team 扩展。

---

## 文件结构

- 创建：`C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\README.md`，保存完整题目契约。
- 创建：`C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\package.json`，提供公开测试命令。
- 创建：`C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\src\lease-queue.mjs`，只包含失败实现桩，后续仅由 Staff 修改。
- 创建：`C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\test\lease-queue.test.mjs`，公开行为与持久化测试。
- 创建：`C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\.pi\ansteel.json`，显式角色、工具与所有者策略。
- 创建：`C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-oracle-20260728-230632\hidden.test.mjs`，团队不可见的验收测试。
- 创建：`C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-oracle-20260728-230632\run-team-probe.mjs`，RPC 驱动和脱敏事件记录。

### Task 1: 创建公开夹具和基线仓库

**Files:**
- Create: `C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\README.md`
- Create: `C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\package.json`
- Create: `C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\.gitignore`
- Create: `C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\.pi\ansteel.json`

- [ ] **Step 1: 创建隔离目录并确认目标不存在**

Run:

```powershell
$probeRoot = 'C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632'
$oracleRoot = 'C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-oracle-20260728-230632'
Test-Path -LiteralPath $probeRoot
Test-Path -LiteralPath $oracleRoot
New-Item -ItemType Directory -Path $probeRoot
New-Item -ItemType Directory -Path $oracleRoot
```

Expected: 两次 `Test-Path` 均为 `False`，两个目录创建成功。

- [ ] **Step 2: 写入公开仓库元数据**

`package.json` 必须是：

```json
{
  "name": "ansteel-hard-lease-queue-probe",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/lease-queue.test.mjs"
  }
}
```

`.gitignore` 必须是：

```gitignore
.pi/ansteel-team/
*.log
```

`.pi/ansteel.json` 必须显式使用：

```json
{
  "roles": {
    "tech-lead": {
      "model": "qwen-token-plan-cn/glm-5.2",
      "tools": ["read", "grep", "find", "ls"],
      "teamTools": ["read", "grep", "find", "ls", "bash"]
    },
    "staff-engineer": {
      "model": "volcengine-agent-plan/glm-5.2",
      "thinkingLevel": "off",
      "tools": ["read", "grep", "find", "ls"],
      "teamTools": ["read", "grep", "find", "ls", "bash", "edit", "write"]
    },
    "qa-engineer": {
      "model": "micuapi/gpt-5.5",
      "thinkingLevel": "high",
      "tools": ["read", "grep", "find", "ls"],
      "teamTools": ["read", "grep", "find", "ls", "bash"]
    }
  },
  "stageTimeoutMs": 600000,
  "teamTaskOwners": ["staff-engineer"]
}
```

`README.md` 必须是：

````markdown
# Durable Lease Queue Challenge

Implement `DurableLeaseQueue` in `src/lease-queue.mjs` using only the Node.js standard library. Do not modify this README, tests, package metadata, Git metadata, or `.pi`.

```javascript
export class DurableLeaseQueue {
  constructor({ logPath, clock });
  async recover();
  async enqueue({ id, payload, dependsOn });
  async claim({ workerId, leaseMs });
  async renew({ id, workerId, token, leaseMs });
  async complete({ id, workerId, token, result });
  async fail({ id, workerId, token, reason });
  getState(id);
}
```

`clock()` returns a non-negative integer millisecond timestamp. Task states are `waiting`, `leased`, `completed`, and `failed`. `claim()` returns `null` when no task is runnable, otherwise `{ id, payload, workerId, token, leaseUntil }`. `renew()` returns the updated lease. The other mutating methods return a JSON-serializable task snapshot; `getState()` returns a snapshot or `null`.

Requirements:

1. Tasks may reference not-yet-enqueued dependencies. Reject the insertion that would create a dependency cycle without changing memory or the log.
2. A task is runnable only after every dependency is `completed`. A failed dependency leaves its downstream task in `waiting` and permanently unrunnable.
3. Claim the lexicographically smallest runnable ID. A live lease has one owner, deadline, and non-reusable token.
4. Renewal extends a live matching lease from the current clock value. Expired work may be re-claimed with a different token; every stale owner operation must throw.
5. Identical enqueue and completion requests are idempotent and do not append duplicate events. Conflicting repeats throw.
6. Serialize concurrent mutations in one process so concurrent claims cannot create two valid leases.
7. Persist every accepted mutation as one JSON Lines event containing a monotonic sequence, previous SHA-256 hash, and current SHA-256 hash. Append and sync it before changing memory.
8. `recover()` deterministically verifies and replays the log. Ignore only one incomplete JSON record at the physical tail. Reject committed malformed JSON, sequence gaps, and hash mismatches.

Run `npm test`. The Staff Engineer may claim and modify only `src/lease-queue.mjs`, then must submit the change through `ansteel_submit_change` with command `npm test`.
````

- [ ] **Step 3: 初始化单独 Git 仓库**

Run:

```powershell
git init
git checkout -b main
git config user.name 'Ansteel Runtime Probe'
git config user.email 'ansteel-probe@localhost'
```

Expected: 当前目录成为独立 `main` 仓库，不影响 `F:\codex\ai群讨论`。

### Task 2: 建立公开红灯测试

**Files:**
- Create: `C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\src\lease-queue.mjs`
- Create: `C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\test\lease-queue.test.mjs`

- [ ] **Step 1: 写入最小失败实现**

```javascript
export class DurableLeaseQueue {
  constructor() {
    throw new Error("NOT_IMPLEMENTED");
  }
}
```

- [ ] **Step 2: 写入公开测试**

测试辅助函数固定为：

```javascript
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableLeaseQueue } from "../src/lease-queue.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "lease-queue-public-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  return {
    logPath: join(root, "queue.jsonl"),
    clock: () => now,
    setNow: (value) => { now = value; }
  };
}
```

公开测试必须覆盖以下完整断言：

```javascript
test("enqueues, orders ready work, and waits for dependencies", async (t) => {
  const f = await fixture(t);
  const q = new DurableLeaseQueue(f);
  await q.recover();
  await q.enqueue({ id: "b", payload: 2, dependsOn: [] });
  await q.enqueue({ id: "a", payload: 1, dependsOn: ["b"] });
  assert.equal((await q.claim({ workerId: "w1", leaseMs: 50 })).id, "b");
  assert.equal(await q.claim({ workerId: "w2", leaseMs: 50 }), null);
});

test("rejects a forward dependency cycle without changing durable state", async (t) => {
  const f = await fixture(t);
  const q = new DurableLeaseQueue(f);
  await q.recover();
  await q.enqueue({ id: "a", payload: 1, dependsOn: ["b"] });
  await assert.rejects(q.enqueue({ id: "b", payload: 2, dependsOn: ["a"] }));
  assert.equal(q.getState("b"), null);
});

test("expires leases and rejects the stale token", async (t) => {
  const f = await fixture(t);
  const q = new DurableLeaseQueue(f);
  await q.recover();
  await q.enqueue({ id: "a", payload: 1, dependsOn: [] });
  const first = await q.claim({ workerId: "w1", leaseMs: 10 });
  f.setNow(1_011);
  const second = await q.claim({ workerId: "w2", leaseMs: 10 });
  assert.notEqual(first.token, second.token);
  await assert.rejects(q.complete({ id: "a", workerId: "w1", token: first.token, result: 1 }));
});

test("serializes concurrent claims", async (t) => {
  const f = await fixture(t);
  const q = new DurableLeaseQueue(f);
  await q.recover();
  await q.enqueue({ id: "a", payload: 1, dependsOn: [] });
  const claims = await Promise.all(
    Array.from({ length: 20 }, (_, i) => q.claim({ workerId: `w${i}`, leaseMs: 10 }))
  );
  assert.equal(claims.filter(Boolean).length, 1);
});

test("replays completion and tolerates only a partial final line", async (t) => {
  const f = await fixture(t);
  const q = new DurableLeaseQueue(f);
  await q.recover();
  await q.enqueue({ id: "a", payload: { x: 1 }, dependsOn: [] });
  const lease = await q.claim({ workerId: "w", leaseMs: 10 });
  await q.complete({ id: "a", workerId: "w", token: lease.token, result: 7 });
  const before = await readFile(f.logPath, "utf8");
  await writeFile(f.logPath, `${before}{"partial":`, "utf8");
  const recovered = new DurableLeaseQueue(f);
  await recovered.recover();
  assert.equal(recovered.getState("a").status, "completed");
  assert.equal(recovered.getState("a").result, 7);
});

test("rejects an altered committed event", async (t) => {
  const f = await fixture(t);
  const q = new DurableLeaseQueue(f);
  await q.recover();
  await q.enqueue({ id: "a", payload: 1, dependsOn: [] });
  const log = await readFile(f.logPath, "utf8");
  await writeFile(f.logPath, log.replace('"a"', '"tampered"'), "utf8");
  await assert.rejects(new DurableLeaseQueue(f).recover());
});
```

续租、重复入队、幂等完成和失败依赖阻塞测试固定为：

```javascript
test("renews a live lease and delays re-claim", async (t) => {
  const f = await fixture(t);
  const q = new DurableLeaseQueue(f);
  await q.recover();
  await q.enqueue({ id: "a", payload: 1, dependsOn: [] });
  const lease = await q.claim({ workerId: "w1", leaseMs: 10 });
  f.setNow(1_005);
  const renewed = await q.renew({ id: "a", workerId: "w1", token: lease.token, leaseMs: 20 });
  assert.equal(renewed.leaseUntil, 1_025);
  f.setNow(1_011);
  assert.equal(await q.claim({ workerId: "w2", leaseMs: 10 }), null);
  f.setNow(1_026);
  assert.equal((await q.claim({ workerId: "w2", leaseMs: 10 })).workerId, "w2");
});

test("makes identical enqueue idempotent and rejects conflicting duplicates", async (t) => {
  const f = await fixture(t);
  const q = new DurableLeaseQueue(f);
  await q.recover();
  const first = await q.enqueue({ id: "a", payload: { x: 1 }, dependsOn: ["b"] });
  const second = await q.enqueue({ id: "a", payload: { x: 1 }, dependsOn: ["b"] });
  assert.deepEqual(second, first);
  await assert.rejects(q.enqueue({ id: "a", payload: { x: 2 }, dependsOn: ["b"] }));
});

test("makes identical completion idempotent without appending twice", async (t) => {
  const f = await fixture(t);
  const q = new DurableLeaseQueue(f);
  await q.recover();
  await q.enqueue({ id: "a", payload: 1, dependsOn: [] });
  const lease = await q.claim({ workerId: "w", leaseMs: 10 });
  const first = await q.complete({ id: "a", workerId: "w", token: lease.token, result: { ok: true } });
  const lineCount = (await readFile(f.logPath, "utf8")).trim().split("\n").length;
  const second = await q.complete({ id: "a", workerId: "w", token: lease.token, result: { ok: true } });
  assert.deepEqual(second, first);
  assert.equal((await readFile(f.logPath, "utf8")).trim().split("\n").length, lineCount);
  await assert.rejects(q.complete({ id: "a", workerId: "w", token: lease.token, result: { ok: false } }));
});

test("keeps dependants blocked after a dependency fails", async (t) => {
  const f = await fixture(t);
  const q = new DurableLeaseQueue(f);
  await q.recover();
  await q.enqueue({ id: "child", payload: 2, dependsOn: ["root"] });
  await q.enqueue({ id: "root", payload: 1, dependsOn: [] });
  const lease = await q.claim({ workerId: "w", leaseMs: 10 });
  assert.equal(lease.id, "root");
  await q.fail({ id: "root", workerId: "w", token: lease.token, reason: "permanent" });
  assert.equal(await q.claim({ workerId: "w2", leaseMs: 10 }), null);
  assert.equal(q.getState("child").status, "waiting");
});
```

- [ ] **Step 3: 运行公开测试确认红灯**

Run: `npm test`

Expected: 非零退出，错误包含 `NOT_IMPLEMENTED`。

- [ ] **Step 4: 提交夹具基线**

```powershell
git add -- README.md package.json .gitignore .pi/ansteel.json src/lease-queue.mjs test/lease-queue.test.mjs
git commit -m 'test: establish durable lease queue challenge'
git status --short
```

Expected: 提交成功且状态为空。

### Task 3: 建立团队不可见的隐藏验收

**Files:**
- Create: `C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-oracle-20260728-230632\hidden.test.mjs`

- [ ] **Step 1: 写入动态导入和独立临时目录**

```javascript
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const modulePath = process.env.LEASE_QUEUE_MODULE;
assert.ok(modulePath, "LEASE_QUEUE_MODULE is required");
const { DurableLeaseQueue } = await import(`${pathToFileURL(modulePath).href}?hidden=${Date.now()}`);
```

- [ ] **Step 2: 写入隐藏行为**

在动态导入代码后追加：

```javascript
async function hiddenFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "lease-queue-hidden-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 10_000;
  return {
    logPath: join(root, "queue.jsonl"),
    clock: () => now,
    setNow: (value) => { now = value; }
  };
}

test("executes a deterministic 50-task DAG in ready order", async (t) => {
  const f = await hiddenFixture(t);
  const q = new DurableLeaseQueue(f);
  await q.recover();
  const dependencies = new Map();
  for (let i = 49; i >= 0; i -= 1) {
    const id = `t${String(i).padStart(2, "0")}`;
    const dependsOn = [];
    if (i > 0 && i % 3 === 0) dependsOn.push(`t${String(i - 1).padStart(2, "0")}`);
    if (i > 1 && i % 5 === 0) dependsOn.push(`t${String(i - 2).padStart(2, "0")}`);
    dependencies.set(id, dependsOn);
    await q.enqueue({ id, payload: i, dependsOn });
  }
  const completed = new Set();
  while (completed.size < 50) {
    const expected = [...dependencies]
      .filter(([id, deps]) => !completed.has(id) && deps.every((dep) => completed.has(dep)))
      .map(([id]) => id)
      .sort()[0];
    const lease = await q.claim({ workerId: "dag", leaseMs: 100 });
    assert.equal(lease.id, expected);
    await q.complete({ id: lease.id, workerId: "dag", token: lease.token, result: lease.id });
    completed.add(lease.id);
  }
  assert.equal(await q.claim({ workerId: "dag", leaseMs: 100 }), null);
});

test("serializes 32 identical completions into one durable event", async (t) => {
  const f = await hiddenFixture(t);
  const q = new DurableLeaseQueue(f);
  await q.recover();
  await q.enqueue({ id: "once", payload: 1, dependsOn: [] });
  const lease = await q.claim({ workerId: "w", leaseMs: 100 });
  const before = (await readFile(f.logPath, "utf8")).trim().split("\n").length;
  const calls = await Promise.all(
    Array.from({ length: 32 }, () =>
      q.complete({ id: "once", workerId: "w", token: lease.token, result: { value: 7 } })
    )
  );
  assert.ok(calls.every((state) => state.status === "completed"));
  const after = (await readFile(f.logPath, "utf8")).trim().split("\n").length;
  assert.equal(after, before + 1);
});

test("rejects old tokens after renewal expiry and re-claim", async (t) => {
  const f = await hiddenFixture(t);
  const q = new DurableLeaseQueue(f);
  await q.recover();
  await q.enqueue({ id: "lease", payload: 1, dependsOn: [] });
  const first = await q.claim({ workerId: "w1", leaseMs: 10 });
  f.setNow(10_005);
  await q.renew({ id: "lease", workerId: "w1", token: first.token, leaseMs: 20 });
  f.setNow(10_026);
  const second = await q.claim({ workerId: "w2", leaseMs: 10 });
  assert.notEqual(second.token, first.token);
  await assert.rejects(q.renew({ id: "lease", workerId: "w1", token: first.token, leaseMs: 10 }));
  await assert.rejects(q.fail({ id: "lease", workerId: "w1", token: first.token, reason: "stale" }));
});

test("replays the same JSON state three times", async (t) => {
  const f = await hiddenFixture(t);
  const original = new DurableLeaseQueue(f);
  await original.recover();
  await original.enqueue({ id: "a", payload: { x: 1 }, dependsOn: [] });
  const lease = await original.claim({ workerId: "w", leaseMs: 100 });
  await original.complete({ id: "a", workerId: "w", token: lease.token, result: 9 });
  const expected = JSON.stringify(original.getState("a"));
  for (let i = 0; i < 3; i += 1) {
    const recovered = new DurableLeaseQueue(f);
    await recovered.recover();
    assert.equal(JSON.stringify(recovered.getState("a")), expected);
  }
});

test("ignores one partial tail but rejects committed middle corruption", async (t) => {
  const f = await hiddenFixture(t);
  const q = new DurableLeaseQueue(f);
  await q.recover();
  await q.enqueue({ id: "a", payload: 1, dependsOn: [] });
  await q.enqueue({ id: "b", payload: 2, dependsOn: [] });
  const original = await readFile(f.logPath, "utf8");
  await writeFile(f.logPath, `${original}{"seq":999`, "utf8");
  const tailRecovered = new DurableLeaseQueue(f);
  await tailRecovered.recover();
  assert.equal(tailRecovered.getState("b").payload, 2);
  const lines = original.trimEnd().split("\n");
  lines[0] = lines[0].replace('"a"', '"corrupt"');
  await writeFile(f.logPath, `${lines.join("\n")}\n`, "utf8");
  await assert.rejects(new DurableLeaseQueue(f).recover());
});

test("never schedules a dependant of failed work", async (t) => {
  const f = await hiddenFixture(t);
  const q = new DurableLeaseQueue(f);
  await q.recover();
  await q.enqueue({ id: "child", payload: 2, dependsOn: ["root"] });
  await q.enqueue({ id: "root", payload: 1, dependsOn: [] });
  const lease = await q.claim({ workerId: "w", leaseMs: 100 });
  await q.fail({ id: "root", workerId: "w", token: lease.token, reason: "fatal" });
  assert.equal(await q.claim({ workerId: "other", leaseMs: 100 }), null);
  assert.equal(q.getState("child").status, "waiting");
});
```

- [ ] **Step 3: 在实现桩上确认隐藏测试红灯**

Run:

```powershell
$env:LEASE_QUEUE_MODULE='C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\src\lease-queue.mjs'
node --test 'C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-oracle-20260728-230632\hidden.test.mjs'
```

Expected: 非零退出，且隐藏测试文件不在夹具 Git 仓库中。

### Task 4: 启动真实团队并等待初始调查

**Files:**
- Create: `C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-oracle-20260728-230632\run-team-probe.mjs`

- [ ] **Step 1: 创建 RPC 驱动**

源码 CLI 已内置 Ansteel Team 扩展，驱动不得再用 `-e` 重复加载；重复加载会把命令重命名为 `ansteel-team:1` 和 `ansteel-team:2`，导致文档入口 `/ansteel-team` 无法命中。

`run-team-probe.mjs` 必须完整写入：

```javascript
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = "C:\\Users\\leomx\\AppData\\Local\\Temp\\ansteel-team-hard-probe-20260728-230632";
const oracleRoot = "C:\\Users\\leomx\\AppData\\Local\\Temp\\ansteel-team-hard-probe-oracle-20260728-230632";
const statePath = join(projectRoot, ".pi", "ansteel-team", "team.json");
const eventPath = join(projectRoot, ".pi", "ansteel-team", "events.jsonl");
const rpcLogPath = join(oracleRoot, "rpc-events.jsonl");
const stderrPath = join(oracleRoot, "stderr.log");
const piScript = "F:\\codex\\ai群讨论\\pi-agent\\pi-test.ps1";
const child = spawn(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", piScript, "--mode", "rpc"],
  { cwd: projectRoot, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] }
);

let stdoutBuffer = "";
let stderr = "";
let nextId = 1;
const waiters = new Map();

function recordSafeEvent(record) {
  const safe = {
    at: new Date().toISOString(),
    type: record.type,
    id: record.id,
    command: record.command,
    success: record.success,
    toolName: record.toolName,
    method: record.method
  };
  appendFileSync(rpcLogPath, `${JSON.stringify(safe)}\n`, "utf8");
}

function answerUi(record) {
  if (record.type !== "extension_ui_request") return;
  if (["select", "confirm", "input", "editor"].includes(record.method)) {
    child.stdin.write(`${JSON.stringify({
      type: "extension_ui_response",
      id: record.id,
      cancelled: true
    })}\n`);
  }
}

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString();
  while (stdoutBuffer.includes("\n")) {
    const index = stdoutBuffer.indexOf("\n");
    const line = stdoutBuffer.slice(0, index).trim();
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (!line) continue;
    const record = JSON.parse(line);
    recordSafeEvent(record);
    answerUi(record);
    if (record.type === "response" && record.id && waiters.has(record.id)) {
      const waiter = waiters.get(record.id);
      waiters.delete(record.id);
      waiter.resolve(record);
    }
  }
});

child.on("error", (error) => {
  for (const waiter of waiters.values()) waiter.reject(error);
  waiters.clear();
});

child.on("exit", (code) => {
  for (const waiter of waiters.values()) {
    waiter.reject(new Error(`Pi RPC exited before responding, code=${code}`));
  }
  waiters.clear();
});

function sendPrompt(message, timeoutMs = 60 * 60 * 1_000) {
  const id = `probe-${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`RPC response timeout for ${id}`));
    }, timeoutMs);
    waiters.set(id, {
      resolve: (record) => {
        clearTimeout(timer);
        if (record.success === false) reject(new Error(`RPC command ${id} failed`));
        else resolve(record);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
  });
}

function readState() {
  return existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
}

function readEvents() {
  if (!existsSync(eventPath)) return [];
  return readFileSync(eventPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function rolesSettled(state) {
  return state && Object.values(state.roles).every((role) => role.status !== "working");
}

function roundEventCount() {
  return readEvents().filter((event) =>
    event.type === "role-report" || event.type === "role-failure"
  ).length;
}

async function waitFor(description, predicate, deadline) {
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    if (child.exitCode !== null) {
      throw new Error(`${description}: Pi RPC exited with ${child.exitCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function stopTeam() {
  if (child.exitCode !== null) return;
  try {
    await sendPrompt("/ansteel-team stop", 60_000);
    await waitFor(
      "team stop",
      () => {
        const state = readState();
        return state?.status === "stopped" ? state : null;
      },
      Date.now() + 60_000
    );
  } finally {
    child.stdin.end();
  }
}

const overallDeadline = Date.now() + 60 * 60 * 1_000;
let finalState = null;
let outcome = "not-started";

try {
  await sendPrompt(
    "/ansteel-team start Implement the durable lease queue exactly as specified in README.md. Treat tests and Git evidence as authoritative."
  );
  await waitFor(
    "six initial role stages",
    () => {
      const state = readState();
      return roundEventCount() >= 6 && rolesSettled(state) ? state : null;
    },
    overallDeadline
  );
  const initialState = readState();
  if (Object.values(initialState.roles).some((role) => role.status === "failed")) {
    outcome = "initial-role-failure";
  } else {
    const before = roundEventCount();
    await sendPrompt(
      "/ansteel-team ask Deliver one task named TASK-LEASE-QUEUE. Staff Engineer must claim only src/lease-queue.mjs, implement the README contract, and submit with test command npm test. Tech Lead and QA Engineer must independently review the frozen revision. Do not edit tests, README, package.json, Git metadata, or .pi."
    );
    await waitFor(
      "implementation collaboration round",
      () => {
        const state = readState();
        return roundEventCount() >= before + 3 && rolesSettled(state) ? state : null;
      },
      overallDeadline
    );
    let task = readState().tasks.find((item) => item.id === "TASK-LEASE-QUEUE");
    if (task?.status === "revision-required") {
      const revision = task.revision;
      const revisionBefore = roundEventCount();
      await sendPrompt(
        "/ansteel-team ask Staff Engineer: address every recorded peer-review issue for TASK-LEASE-QUEUE without changing its file scope, rerun npm test, and resubmit. Reviewers must inspect the new frozen revision independently."
      );
      await waitFor(
        "bounded revision collaboration round",
        () => {
          const state = readState();
          const current = state?.tasks.find((item) => item.id === "TASK-LEASE-QUEUE");
          return roundEventCount() >= revisionBefore + 3
            && rolesSettled(state)
            && current?.revision > revision
            ? state
            : null;
        },
        overallDeadline
      );
      task = readState().tasks.find((item) => item.id === "TASK-LEASE-QUEUE");
    }
    outcome = task?.status ?? "task-missing";
  }
  finalState = readState();
} catch (error) {
  outcome = `driver-error:${error instanceof Error ? error.message : String(error)}`;
  finalState = readState();
} finally {
  writeFileSync(stderrPath, stderr, "utf8");
  await stopTeam().catch((error) => {
    outcome = `${outcome};stop-error:${error instanceof Error ? error.message : String(error)}`;
  });
  console.log(JSON.stringify({
    outcome,
    statePath,
    eventPath,
    models: finalState
      ? Object.fromEntries(Object.entries(finalState.roles).map(([role, value]) => [role, value.model]))
      : null,
    task: finalState?.tasks.find((item) => item.id === "TASK-LEASE-QUEUE") ?? null
  }, null, 2));
}
```

- [ ] **Step 2: 启动团队**

RPC 发送：

```json
{
  "id": "start",
  "type": "prompt",
  "message": "/ansteel-team start Implement the durable lease queue exactly as specified in README.md. Treat tests and Git evidence as authoritative."
}
```

Expected: `team.json` 出现，三个角色模型与配置一致，初始调查和交叉质疑结束后角色均不再是 `working`。

- [ ] **Step 3: 失败时保留现场**

若角色解析、认证、超时或提供商调用失败，停止发送新工作，只记录 `team.json`、`events.jsonl`、stderr、退出码和脱敏 RPC 事件。不得修改状态制造通过。

### Task 5: 运行受控实现、测试和双评审

**Files:**
- Modify by Staff only: `C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\src\lease-queue.mjs`

- [ ] **Step 1: 发送精确协作任务**

RPC 发送：

```json
{
  "id": "implement",
  "type": "prompt",
  "message": "/ansteel-team ask Deliver one task named TASK-LEASE-QUEUE. Staff Engineer must claim only src/lease-queue.mjs, implement the README contract, and submit with test command npm test. Tech Lead and QA Engineer must independently review the frozen revision. Do not edit tests, README, package.json, Git metadata, or .pi."
}
```

- [ ] **Step 2: 等待持久化终态**

每五秒读取 `team.json`，最长 60 分钟。终止条件为：

- `TASK-LEASE-QUEUE.status === "approved"`；
- 任一角色为 `failed` 且任务无法继续；
- 任务为 `revision-required` 且一次补充 `/ansteel-team ask` 后仍未重新提交；
- RPC 子进程退出；
- 到达 60 分钟。

- [ ] **Step 3: 允许一次有边界修订**

若任务为 `revision-required`，发送：

```json
{
  "id": "revise",
  "type": "prompt",
  "message": "/ansteel-team ask Staff Engineer: address every recorded peer-review issue for TASK-LEASE-QUEUE without changing its file scope, rerun npm test, and resubmit. Reviewers must inspect the new frozen revision independently."
}
```

Expected: 不超过一次修订；不得由宿主直接编辑实现。

- [ ] **Step 4: 停止团队并关闭 RPC**

发送 `/ansteel-team stop`，等待 `team.json.status === "stopped"`，然后正常关闭 stdin。若进程无响应，先保留 PID 和状态，再终止本次 RPC 子进程，不删除临时仓库。

### Task 6: 独立验证交付证据

**Files:**
- Inspect: `C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\.pi\ansteel-team\team.json`
- Inspect: `C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\.pi\ansteel-team\events.jsonl`
- Test: `C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-oracle-20260728-230632\hidden.test.mjs`

- [ ] **Step 1: 重跑公开测试**

Run: `npm test`

Expected for full pass: 退出码零。

- [ ] **Step 2: 运行隐藏测试**

Run:

```powershell
$env:LEASE_QUEUE_MODULE='C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-20260728-230632\src\lease-queue.mjs'
node --test 'C:\Users\leomx\AppData\Local\Temp\ansteel-team-hard-probe-oracle-20260728-230632\hidden.test.mjs'
```

Expected for full pass: 退出码零。

- [ ] **Step 3: 审计 Git 和治理状态**

Run:

```powershell
git diff --name-only HEAD
git diff --check
git status --short
```

Expected for full pass: 产品差异只有 `src/lease-queue.mjs`；`.pi/ansteel-team/` 被忽略；diff 非空且无空白错误。

检查 `team.json` 中任务所有者、测试退出结果、revision、两名非所有者的批准和 `approved` 状态；重新计算 `events.jsonl` 的序号及 SHA-256 前向链，任何不一致按系统缺陷处理。

### Task 7: 形成事实分层报告

**Files:**
- No project files modified.

- [ ] **Step 1: 汇总运行事实**

记录当前产品提交 `20c1103c9fbb717d52d6939e27a3c6becf96cd22`、临时路径、模型标识、各阶段耗时、工具事件、公开测试、隐藏测试、Git diff、任务终态和失败原因。不得记录凭据、环境变量值或隐藏推理。

- [ ] **Step 2: 给出唯一结果等级**

严格按设计规格选择：`通过`、`部分通过`、`正确失败关闭` 或 `系统缺陷`。确定性测试、真实模型响应和代码正确性分别陈述，不互相代替。

- [ ] **Step 3: 仅在发现产品缺陷时另立修复任务**

本轮不直接修改 `pi-agent`。若发现系统缺陷，先给出文件、事件和复现命令，再按独立设计与 TDD 流程修复。

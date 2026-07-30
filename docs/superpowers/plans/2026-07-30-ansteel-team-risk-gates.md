# Ansteel Team 机械风险门禁实施计划

> **执行约束：** 按清单逐项执行并记录机械证据，不依赖或触发外部流程技能。步骤使用 checkbox（`- [ ]`）跟踪。

**Goal:** 把持续协作协议迁移第 6 步落实为真正位于工具执行前的机械风险门禁，并补齐自动恢复公开审计与历史运行索引遗留项。

**Architecture:** 协调器从工具类型、规范化目标、目标当前版本和项目策略计算动作风险，模型声明只能把风险提高。黄色和红色动作必须绑定一个不可变检查点及其动作版本，由另外两名角色分别留下结构化确认；任何开放的 `blocking`/`critical` 问题、缺失确认、拒绝、目标漂移或版本漂移都在 `beforeToolCall` 阶段阻断。绿色动作无需等待确认，但仍由运行日志和公共动作事件广播。状态仍由追加式事件账本重放得到；恢复修复通过新的公开审计事件记录，历史查询通过持久索引定位所有运行。

**Tech Stack:** TypeScript、Vitest、Pi Agent 扩展工具 API、SHA-256 事件账本、OpenTelemetry 语义、本地 JSONL、PowerShell、GitHub Actions

---

## 规范边界

本计划落实以下规范：

- `持续协作协议` 第 9 节：绿色、黄色、红色动作分级。
- `持续协作协议` 第 10 节：检查点、机械风险判定、双同伴检查、问题阻断、执行和观察。
- `持续协作协议` 第 18 节：黄色/红色动作缺少检查点或存在开放阻断问题时失败关闭。
- 迁移第 6 步：引入三色风险分类与对应阻断规则。
- 上一阶段遗留：任何自动修复必须追加公开审计事件；历史运行不能只依赖当前进程内存或单次目录猜测。

本计划不开放任意写 shell，也不把 Git 提交、推送或发布权限交给角色模型。红色分类先建立统一门禁和测试契约；实际 Git 上传仍由受控协调器在本计划完整验证后执行。

## 文件边界

- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team.ts`
  - 状态 v8、动作绑定、机械风险分类、同伴确认、事件重放和执行前判定。
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts`
  - 历史运行索引和恢复修复记录。
- Modify: `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts`
  - 角色确认工具、`beforeToolCall` 风险门禁、公共时间线和恢复审计接线。
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team.test.ts`
  - 分类、风险升级、状态迁移、确认绑定、漂移和开放问题对抗测试。
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts`
  - 真正的 `edit`/`write` 执行前门禁和绿色广播测试。
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-cli.test.ts`
  - 确定性 RPC 双同伴确认与缺失确认失败关闭。
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-observability.test.ts`
  - 自动恢复公开审计输入和历史索引损坏测试。
- Modify: `pi-agent/packages/coding-agent/docs/ansteel.md`
  - 用户可见风险规则、命令行为和恢复诊断。
- Modify: `docs/superpowers/specs/2026-07-29-ansteel-team-continuous-collaboration-protocol-design.md`
  - 只更新迁移进度证据，不改变已批准语义。
- Create: `docs/superpowers/reviews/2026-07-30-ansteel-team-risk-gates-spec-review.md`
  - 独立规范符合性复审。
- Create: `docs/superpowers/reviews/2026-07-30-ansteel-team-risk-gates-quality-review.md`
  - 独立代码质量复审。
- Create: `docs/superpowers/reports/2026-07-30-ansteel-team-risk-gates-report.md`
  - 阶段验证证据和剩余协议差距。

### Task 1: 定义状态 v8、动作绑定与机械风险分类

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team.ts`
- Test: `pi-agent/packages/coding-agent/test/ansteel-team.test.ts`

- [x] **Step 1: 写状态迁移和分类 RED 测试**

在 `ansteel-team.test.ts` 增加：

```ts
it("migrates v7 state with an empty action review ledger", () => {
	const cwd = createTemporaryProject();
	const team = createTeam(cwd);
	const legacy = { ...team, version: 7 };
	delete (legacy as Partial<typeof legacy>).actionReviews;
	writeFileSync(getAnsteelTeamStatePath(cwd), `${JSON.stringify(legacy)}\n`, "utf8");

	expect(loadAnsteelTeamState(cwd)).toMatchObject({
		version: 8,
		actionReviews: [],
	});
});

it.each([
	[{ toolName: "read", args: { path: "src/parser.ts" } }, "green"],
	[{ toolName: "edit", args: { path: "src/parser.ts" } }, "yellow"],
	[{ toolName: "write", args: { path: "src/new.ts" } }, "yellow"],
	[{ toolName: "write", args: { path: "src/parser.ts" } }, "red"],
	[{ toolName: "bash", args: { command: "git commit -m governed" } }, "red"],
	[{ toolName: "bash", args: { command: "git push origin main" } }, "red"],
])("mechanically classifies %o as %s", (action, expected) => {
	const cwd = createTemporaryProject();
	initializeGitProject(cwd);
	expect(classifyAnsteelTeamActionRisk(cwd, action)).toBe(expected);
});
```

再增加目标策略测试：`.pi/ansteel-team/**` 必须直接拒绝；`.github/workflows/**`、权限、安全配置、迁移目录和删除动作至少为红色；只读工具不能因为模型声明而变成写入。

- [x] **Step 2: 运行 RED**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team.test.ts -t "migrates v7|mechanically classifies|target policy"
```

Expected: FAIL，原因是 `actionReviews`、`classifyAnsteelTeamActionRisk` 和状态 v8 尚不存在。

- [x] **Step 3: 增加公共类型和稳定动作版本**

在 `ansteel-team.ts` 定义：

```ts
export type AnsteelActionRisk = "green" | "yellow" | "red";

export interface AnsteelGovernedAction {
	toolName: string;
	kind: AnsteelWorkCheckpoint["nextAction"]["kind"];
	target: string;
	version: string;
	computedRisk: AnsteelActionRisk;
	effectiveRisk: AnsteelActionRisk;
}

export interface AnsteelActionReview {
	checkpointId: string;
	reviewer: AnsteelRole;
	action: Pick<AnsteelGovernedAction, "kind" | "target" | "version">;
	verdict: "approve" | "reject";
	reason: string;
	reviewedAt: string;
}
```

把状态版本提升到 8，并给 `AnsteelTeamState` 增加 `actionReviews: AnsteelActionReview[]`。v7 到 v8 迁移只增加空数组，不能推导虚假历史确认。
给 `AnsteelWorkCheckpoint` 增加协调器生成的 `governedAction: AnsteelGovernedAction`，并把
`AnsteelWorkCheckpointInput` 明确排除 `governedAction`，禁止模型自行填写绑定。`nextAction.kind` 增加
`write`，使新增文件与覆盖已有文件可以在检查点中精确区分。

动作版本必须由协调器生成：

```ts
function getAnsteelActionVersion(
	cwd: string,
	state: AnsteelTeamState,
	checkpoint: AnsteelWorkCheckpoint,
	target: string,
): string
```

文件目标使用当前内容 SHA-256 或 `missing`，并结合任务 ID、任务 revision 和检查点 ID。Git 动作使用当前 `HEAD`；无法解析目标版本时拒绝黄色/红色动作，不使用模型文本代替。

- [x] **Step 4: 实现机械分类和只升不降**

导出：

```ts
export function classifyAnsteelTeamActionRisk(
	cwd: string,
	action: { toolName: string; args: unknown },
): AnsteelActionRisk
```

分类优先级为 `green < yellow < red`。基础规则：

```ts
read | grep | find | ls -> green
edit -> yellow
write(existing file) -> red
write(new file) -> yellow
delete | overwrite | commit | push | release | permission | migration -> red
unknown mutating tool -> red
```

发布检查点时根据 `nextAction.kind`、目标和项目策略计算 `computedRisk`，最终风险取
`max(computedRisk, input.risk)`。模型可以把黄色声明成红色，不能把红色声明成黄色。

- [x] **Step 5: 运行 GREEN**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team.test.ts -t "migrates v7|mechanically classifies|target policy|cannot downgrade"
```

Expected: PASS。

- [x] **Step 6: 提交并推送状态与分类基础**

```powershell
git add -- pi-agent/packages/coding-agent/src/core/ansteel-team.ts pi-agent/packages/coding-agent/test/ansteel-team.test.ts docs/superpowers/plans/2026-07-30-ansteel-team-risk-gates.md
git diff --cached --check
git commit -m "feat(鞍钢协作): 建立机械动作风险分类基础" -m "将团队状态升级到 v8，加入不可变动作绑定和同伴确认账本。协调器根据工具、目标和当前版本计算三色风险，模型只能主动升级风险，不能降低系统判定。补充状态迁移、敏感路径和覆盖写入对抗测试。"
git push origin main
```

### Task 2: 实现双同伴确认和执行前核心门禁

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team.ts`
- Test: `pi-agent/packages/coding-agent/test/ansteel-team.test.ts`

- [x] **Step 1: 写确认绑定和阻断 RED 测试**

覆盖以下行为：

```ts
it("blocks a yellow edit until both peers approve the exact action binding", () => {
	const assessment = assessAnsteelTeamAction(cwd, team, "staff-engineer", {
		toolName: "edit",
		args: { path: "src/parser.ts" },
	});
	expect(assessment.blockReason).toContain("requires active checkpoint");

	const checkpoint = publishEditCheckpoint(cwd, team);
	expect(assessEdit(cwd, team).blockReason).toContain("tech-lead, qa-engineer");

	reviewAnsteelTeamAction(cwd, team, "tech-lead", exactReview(checkpoint, "approve"));
	expect(assessEdit(cwd, team).blockReason).toContain("qa-engineer");

	reviewAnsteelTeamAction(cwd, team, "qa-engineer", exactReview(checkpoint, "approve"));
	expect(assessEdit(cwd, team).blockReason).toBeUndefined();
});
```

再分别验证：

- actor 不能确认自己的动作；
- 同一 reviewer 不能重复确认；
- 另一检查点、另一目标、另一动作类型或旧版本的确认不能复用；
- `reject` 始终阻断；
- 任一 `blocking`/`critical` 问题未关闭时阻断；
- `advisory` 不阻断；
- 文件内容在确认后漂移时阻断并要求新检查点；
- 红色动作缺失、拒绝或超时确认均阻断；
- 绿色只读动作不要求检查点或确认。

- [x] **Step 2: 运行 RED**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team.test.ts -t "yellow edit|action binding|action review|target drift|green action"
```

Expected: FAIL，原因是动作评估和确认函数不存在。

- [x] **Step 3: 实现确认事件和状态重放**

扩展公共事件：

```ts
type: "action-assessed" | "action-review"
payload: {
	kind: "action-assessed";
	assessment: AnsteelActionAssessment;
} | {
	kind: "action-review";
	review: AnsteelActionReview;
}
```

新增：

```ts
export function reviewAnsteelTeamAction(
	cwd: string,
	state: AnsteelTeamState,
	reviewer: AnsteelRole,
	input: Omit<AnsteelActionReview, "reviewer" | "reviewedAt">,
	persistence?: AnsteelTeamPersistenceContext,
): AnsteelActionReview
```

事件解析、哈希校验、预览应用、状态重放和共享工作板必须都从同一结构化事件得到确认，不允许直接改 `team.json`。
`action-assessed` 是只追加的公共工具事实，不改变确认状态；绿色动作也必须追加该事件，以满足“立即执行并
广播”。`action-review` 才进入 `actionReviews` 投影。

- [x] **Step 4: 实现统一动作评估**

新增：

```ts
export interface AnsteelActionAssessment {
	action: AnsteelGovernedAction;
	checkpointId?: string;
	requiredReviewers: AnsteelRole[];
	approvedReviewers: AnsteelRole[];
	blockReason?: string;
}

export function assessAnsteelTeamAction(
	cwd: string,
	state: AnsteelTeamState,
	role: AnsteelRole,
	input: { toolName: string; args: unknown },
): AnsteelActionAssessment
```

黄色/红色动作只匹配该角色最新的 active 检查点。检查点的动作类型、规范化目标和当前版本必须与真实工具调用完全一致。评估顺序固定为：

1. 项目/治理路径硬拒绝；
2. 机械风险；
3. 精确 active 检查点；
4. 动作版本和目标漂移；
5. 开放 `blocking`/`critical` 问题；
6. 两个非 actor 角色的精确确认；
7. reviewer 拒绝或缺失；
8. 允许执行。

- [x] **Step 5: 运行核心 GREEN 和事件篡改回归**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team.test.ts
```

Expected: 全部 PASS；篡改 `action-review` 的 checkpoint、target、version 或 reviewer 后，加载或重放必须失败关闭。

- [x] **Step 6: 提交并推送核心门禁**

```powershell
git add -- pi-agent/packages/coding-agent/src/core/ansteel-team.ts pi-agent/packages/coding-agent/test/ansteel-team.test.ts
git diff --cached --check
git commit -m "feat(鞍钢协作): 强制双同伴动作确认门禁" -m "新增动作确认结构化事件和状态重放。黄色与红色动作必须绑定精确检查点、动作类型、规范化目标和当前版本，并取得两名非负责角色的独立确认；开放阻断问题、拒绝、缺失确认和版本漂移全部失败关闭。"
git push origin main
```

### Task 3: 把门禁接到真实角色工具执行前

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts`
- Test: `pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts`

- [x] **Step 1: 写扩展执行前 RED 测试**

导出并测试角色工具门禁入口 `getAnsteelTeamRoleToolBlockReason`，该函数是默认角色 session
`beforeToolCall` 唯一调用的风险判定入口：

```ts
expect(
	getAnsteelTeamRoleToolBlockReason(cwd, state, "staff-engineer", "edit", {
		path: "src/parser.ts",
	}),
).toContain("checkpoint");
```

随后发布黄色检查点并只让 TL 确认，仍然阻断；QA 也确认后才返回 `undefined`。再验证：

- 模型把 `write(existing)` 声明为黄色时，仍按红色门禁；
- 确认后修改目标文件，真实 `edit` 被版本漂移阻断；
- 绿色 `read` 立即放行并形成可查询动作事实；
- 工具执行失败不能生成成功动作结果；
- host session 现有绕过阻断不回归。

- [x] **Step 2: 运行 RED**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-extension.test.ts -t "risk gate|peer action review|version drift|green action"
```

Expected: FAIL；当前 `beforeToolCall` 只调用 `getAnsteelTeamWriteBlockReason`。

- [x] **Step 3: 暴露 `ansteel_review_action`**

给 `AnsteelTeamTaskOperations` 增加：

```ts
reviewAction: (
	input: Omit<AnsteelActionReview, "reviewer" | "reviewedAt">
) => Promise<AnsteelActionReview>;
```

注册工具：

```text
ansteel_review_action
```

工具参数必须包含 `checkpointId`、`action.kind`、`action.target`、`action.version`、`verdict` 和 `reason`。核心函数校验这些值，工具层不得自动修正错误绑定。

- [x] **Step 4: 在 `beforeToolCall` 调用统一门禁**

把现有 `edit`/`write` 分支改为：

```ts
const assessment = assessAnsteelTeamAction(
	options.cwd,
	options.taskOperations.state,
	options.role,
	{ toolName: context.toolCall.name, args: context.args },
);
if (assessment.blockReason !== undefined) {
	return { block: true, reason: assessment.blockReason };
}
```

`getAnsteelTeamWriteBlockReason` 的任务所有权和冻结 revision 规则不能删除；它作为机械评估的一部分继续执行。`read`/`grep`/`find`/`ls` 和只读 bash 也经过分类，但绿色无需同行确认。

- [x] **Step 5: 广播评估与动作结果**

工具开始前写 `action.assessed` 运行记录和 `action-assessed` 公共事件，包含 risk、checkpoint、target 和
version；允许执行后由既有工具事件写 `action.started`/`action.result`。公开时间线只展示结构化摘要，
不写入参数原文、凭据或完整输出。

被阻断动作写 `tool-policy-denied`，并携带 `traceId`、`checkpointId` 和稳定原因；不能只返回一段模型可改写文本。

- [x] **Step 6: 运行扩展 GREEN**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-extension.test.ts
```

Expected: 全部 PASS。

- [x] **Step 7: 提交并推送扩展门禁**

```powershell
git add -- pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts
git diff --cached --check
git commit -m "feat(鞍钢协作): 在真实工具执行前接入风险门禁" -m "新增角色动作确认工具，把机械风险评估接入 edit、write 和只读工具的 beforeToolCall。没有精确检查点、双同伴确认或当前目标版本时，黄色和红色动作不会进入工具执行；阻断结果写入统一运行追踪。"
git push origin main
```

### Task 4: 增加确定性 CLI/RPC 与对抗回归

**Files:**
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-cli.test.ts`
- Modify: `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts`

- [x] **Step 1: 写真实 RPC 双确认成功夹具**

确定性 provider 顺序必须是：

```text
Staff publish yellow edit checkpoint
TL review exact action -> approve
QA review exact action -> approve
Staff edit
Staff submit
TL/QA final task review
```

测试断言目标文件确实变化、RPC 退出成功、账本包含两条不同 reviewer 的 `action-review`，且运行日志在 edit 前已有成功 `action.assessed`。

- [x] **Step 2: 写缺失确认和确认复用失败夹具**

分别覆盖：

- 只有 TL 确认，Staff edit 被阻断；
- QA 使用旧 checkpoint/version 确认，Staff edit 被阻断；
- QA 提出 `blocking` 问题后即使已有两票，Staff edit 仍被阻断；
- 对已有文件执行 `write`，只完成黄色确认仍被红色门禁阻断；
- provider 随后用文本声称“已写入”不能改变文件或状态。

- [x] **Step 3: 运行 RED**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-cli.test.ts -t "risk gate|action confirmation"
```

Expected: FAIL，确定性 provider 尚未执行新确认工具。

- [x] **Step 4: 更新 provider 响应和任务驱动提示**

任务 owner 在黄色/红色动作前必须发布检查点。两名同伴接收同一不可变动作绑定，独立调用 `ansteel_review_action`；不得把其中一个 reviewer 的文本转发给另一个 reviewer。

在 `runTaskEpochs` 中增加 `requestPendingActionReviews`：

1. 每个 owner epoch 后读取该 owner 最新 active 黄色/红色检查点；
2. 若动作绑定尚缺确认，用 `Promise.all` 把完全相同的 checkpoint、kind、target、version、risk 和证据引用
   并行发送给两个非 owner session；
3. reviewer 必须调用 `ansteel_review_action`；有阻断问题时先调用 `ansteel_raise_process_issue` 再拒绝；
4. 两个 reviewer 的提示均不包含对方本轮输出；
5. 任一 reviewer 超时、失败、未调用确认工具或明确拒绝时，动作保持阻断并记录稳定原因；
6. 两票批准且没有开放 `blocking`/`critical` 问题时，下一 epoch 恢复 owner 执行；
7. owner 发布替代检查点后，旧确认不再参与判定。

任务循环发现 `tool-policy-denied` 后保持任务未提交，记录精确原因，不把 provider 后续自然语言当作成功。
如果阻断来自“等待同伴确认”，协调器先运行上述并行检查而不是立即把整个任务判为失败；如果来自拒绝、
开放问题或漂移，则进入纠错/替代检查点流程。

- [x] **Step 5: 运行 CLI/RPC GREEN**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-cli.test.ts
```

Expected: 全部 PASS。

- [x] **Step 6: 提交并推送 CLI/RPC 回归**

```powershell
git add -- pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts pi-agent/packages/coding-agent/test/ansteel-team-cli.test.ts
git diff --cached --check
git commit -m "test(鞍钢协作): 固定风险门禁真实RPC边界" -m "加入双同伴确认成功、缺失确认、旧确认复用、开放阻断问题和覆盖写入升级等确定性 RPC 场景。验证模型文本不能绕过工具执行前门禁，CLI 退出状态与持久事件保持一致。"
git push origin main
```

### Task 5: 补齐自动恢复审计和历史运行索引

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts`
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team.ts`
- Modify: `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts`
- Test: `pi-agent/packages/coding-agent/test/ansteel-team-observability.test.ts`
- Test: `pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts`

- [x] **Step 1: 写自动恢复公开审计 RED 测试**

构造一个含开放 span 的旧运行，恢复后断言：

```ts
expect(listAnsteelTeamEvents(cwd)).toContainEqual(
	expect.objectContaining({
		type: "runtime-recovery",
		role: "coordinator",
		reasonCode: "process-orphaned",
	}),
);
```

事件 payload 必须包含 runId、恢复 span 数、旧链头、新链头和恢复时间，不能包含 stdout、环境变量或密钥。

- [x] **Step 2: 写历史索引 RED 测试**

创建多个运行和多个日志段，关闭进程后重新查询，验证 `trace` 能通过 runId、traceId、taskId、issueId、toolCallId 定位全部历史记录。删除或篡改索引后，查询必须机械重建或明确返回 `event-chain-invalid`，不能静默漏掉历史运行。

- [x] **Step 3: 运行 RED**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-observability.test.ts test/ansteel-team-extension.test.ts -t "recovery audit|historical run index"
```

Expected: FAIL，当前孤儿修复只有运行日志，没有公共恢复事件；查询每次扫描目录且没有受校验持久索引。

- [x] **Step 4: 实现恢复结果和索引**

让 `abandonOrphanedAnsteelTeamRun` 返回结构化结果：

```ts
interface AnsteelRuntimeRecoveryResult {
	runId: string;
	abandonedSpanCount: number;
	previousHeadHash: string | null;
	recoveredHeadHash: string | null;
}
```

扩展在取得单写者锁并完成修复后追加 `runtime-recovery` 公共审计事件。修复失败时不伪造成功事件。

新增内容可校验的 `run-index.json`，索引只保存脱敏关联 ID 到 runId 的映射和日志段哈希。writer 在关键记录落盘后更新索引；读取时校验版本、哈希和实际日志链。索引损坏可以从有效日志重建，但重建本身必须追加 `runtime-index-rebuilt` 审计事件或运行审计记录。

- [x] **Step 5: 运行 GREEN**

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team-observability.test.ts test/ansteel-team-extension.test.ts
```

Expected: 全部 PASS。

- [x] **Step 6: 提交并推送恢复可追溯性**

```powershell
git add -- pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts pi-agent/packages/coding-agent/src/core/ansteel-team.ts pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts pi-agent/packages/coding-agent/test/ansteel-team-observability.test.ts pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts
git diff --cached --check
git commit -m "fix(鞍钢协作): 补齐自动恢复审计与历史运行索引" -m "孤儿 span 自动修复现在返回旧新链头并写入公开恢复审计事件。新增可校验历史运行索引，支持跨进程按关联 ID 定位日志；索引损坏只允许从有效日志机械重建并留下审计事实。"
git push origin main
```

### Task 6: 文档、独立复审与完整验证

**Files:**
- Modify: `pi-agent/packages/coding-agent/docs/ansteel.md`
- Modify: `docs/superpowers/specs/2026-07-29-ansteel-team-continuous-collaboration-protocol-design.md`
- Create: `docs/superpowers/reviews/2026-07-30-ansteel-team-risk-gates-spec-review.md`
- Create: `docs/superpowers/reviews/2026-07-30-ansteel-team-risk-gates-quality-review.md`
- Create: `docs/superpowers/reports/2026-07-30-ansteel-team-risk-gates-report.md`
- Modify: `docs/superpowers/plans/2026-07-30-ansteel-team-risk-gates.md`
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team.ts`
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts`
- Create: `pi-agent/packages/coding-agent/src/core/tools/guarded-file-mutation.ts`
- Modify: `pi-agent/packages/coding-agent/src/core/tools/edit.ts`
- Modify: `pi-agent/packages/coding-agent/src/core/tools/write.ts`
- Modify: `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team.test.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-observability.test.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts`
- Modify: `pi-agent/packages/coding-agent/test/ansteel-team-cli.test.ts`

- [x] **Step 1: 更新用户文档**

文档必须明确：

- 风险由协调器计算，角色声明只能升级；
- `edit` 通常黄色，覆盖已有文件、删除、提交和推送为红色；
- 黄色/红色动作必须使用精确检查点和两名同伴确认；
- 确认不能跨 checkpoint、kind、target、version 复用；
- 开放 `blocking`/`critical` 问题阻断动作；
- 绿色只读动作立即执行并记录；
- 自动恢复和索引重建都会留下公开审计事实；
- 这些门禁不等于最终交付正确，双独立验收仍保留。

- [x] **Step 2: 做独立规范复审**

复审逐条检查规范第 9、10、18、19.6 节和本计划目标。每条结论引用具体文件、测试名和命令证据。任何未满足项写成 blocking finding；不得用“测试通过”代替语义检查。

- [x] **Step 3: 做独立代码质量复审**

重点检查：

- 状态重放是否与直接状态一致；
- 风险优先级是否存在降级路径；
- reviewer 身份与绑定是否可伪造；
- 文件/Git 版本漂移是否在执行前检查；
- `beforeToolCall` 是否覆盖真实 `edit` 和 `write`；
- 日志索引是否会静默漏项；
- 自动修复是否会修改活跃旧宿主；
- 是否泄露用户曾提供的 API Key 或环境变量；
- Windows 进程、文件锁和路径规范化边界。

- [x] **Step 4: 运行定向串行回归**

不要把完整 RPC 子进程回归和构建并行运行。

Run:

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team.test.ts test/ansteel-team-observability.test.ts test/ansteel-team-extension.test.ts test/ansteel-team-cli.test.ts
```

Expected: 4 files 全部 PASS。

- [x] **Step 5: 运行构建和静态检查**

依次执行：

```powershell
npm run build
npx biome check packages/coding-agent/src/core/ansteel-team.ts packages/coding-agent/src/core/ansteel-team-observability.ts packages/coding-agent/src/core/tools/guarded-file-mutation.ts packages/coding-agent/src/core/tools/edit.ts packages/coding-agent/src/core/tools/write.ts packages/coding-agent/src/extensions/ansteel-team/index.ts packages/coding-agent/test/ansteel-team.test.ts packages/coding-agent/test/ansteel-team-observability.test.ts packages/coding-agent/test/ansteel-team-extension.test.ts packages/coding-agent/test/ansteel-team-cli.test.ts
npx tsgo --noEmit
npm run check:pinned-deps
npm run check:ts-imports
npm run check:shrinkwrap
npm run check:install-lock:coding-agent
git diff --check
```

Expected: 全部退出码 0。

- [x] **Step 6: 审计提交范围和敏感信息**

Run:

```powershell
git status --short
git diff --name-only
git diff --cached --name-only
$secretPattern = '(^|[^A-Za-z0-9])s' + 'k-[A-Za-z0-9._-]{20,}|Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}|(?:api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'']?[A-Za-z0-9._-]{32,}'
rg -l --pcre2 --hidden --glob '!node_modules/**' --glob '!.git/**' $secretPattern <本次声明文件>
```

Expected:

- 只包含本计划声明文件；
- `.workbuddy/`、`github-work-profile.md`、`input-output-flow.md`、`overview.md` 不进入提交；
- 高熵密钥扫描无命中；短假测试夹具由人工核对，不得当作真实凭据或无条件加入忽略列表；
- 没有 `.pi/`、日志、事故包或本机配置。

- [ ] **Step 7: 提交阶段报告并推送 main**

```powershell
git add -- docs/superpowers/plans/2026-07-30-ansteel-team-risk-gates.md docs/superpowers/reviews/2026-07-30-ansteel-team-risk-gates-spec-review.md docs/superpowers/reviews/2026-07-30-ansteel-team-risk-gates-quality-review.md docs/superpowers/reports/2026-07-30-ansteel-team-risk-gates-report.md docs/superpowers/specs/2026-07-29-ansteel-team-continuous-collaboration-protocol-design.md pi-agent/packages/coding-agent/docs/ansteel.md pi-agent/packages/coding-agent/src/core/ansteel-team.ts pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts pi-agent/packages/coding-agent/src/core/tools/guarded-file-mutation.ts pi-agent/packages/coding-agent/src/core/tools/edit.ts pi-agent/packages/coding-agent/src/core/tools/write.ts pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts pi-agent/packages/coding-agent/test/ansteel-team.test.ts pi-agent/packages/coding-agent/test/ansteel-team-observability.test.ts pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts pi-agent/packages/coding-agent/test/ansteel-team-cli.test.ts
git diff --cached --check
git commit -m "docs(鞍钢协作): 完成机械风险门禁阶段验收" -m "记录规范复审、代码质量复审、CLI/RPC 对抗回归、构建和静态检查证据。明确迁移第 6 步已经完成，同时保留完整持续协作协议尚未实现的后续迁移项和真实三提供商探针边界。"
git push origin main
```

- [ ] **Step 8: 核验 GitHub Actions**

使用仓库当前 `main` 对应的 workflow run，确认 commit SHA 与本地 `HEAD` 一致。若检查失败，读取具体 job 日志，先用最小机械反例复现根因再修复，不创建分支。

## 自审清单

- [x] 所有黄色/红色工具调用都在执行前经过门禁，而不是事后记录。
- [x] 风险由协调器机械计算，模型不能降级。
- [x] 两名 reviewer 相互独立，actor 不能自批。
- [x] 确认绑定 checkpoint、action kind、target 和 version。
- [x] 绿色动作无需审批，但保留运行事实。
- [x] 开放 blocking/critical 问题始终阻断受影响动作。
- [x] 自动恢复和索引重建都有公开审计事实。
- [x] CLI/RPC、扩展 harness、核心状态和对抗边界均有测试。
- [x] 最终交付双独立验收没有被风险确认替代。
- [x] 计划没有空白占位、模糊实现步骤或未定义接口。
- [x] 本阶段提交范围、详细中文提交消息和唯一 `main` 目标已完成预审。

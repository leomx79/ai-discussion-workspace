# Task 6 实施报告

日期：2026-07-30

## 实施范围

本次实现完成 Task 6 的持久化协作账本完整性验收。重点是修复 `doctor` 只诊断历史运行、却不验证当前落盘公开协作状态的缺口，并关闭“无日志或没有合法终态的运行被误判健康”、活跃旧宿主被误恢复和多恢复者共享旧哈希链头的诊断与并发漏洞。没有创建或切换分支、工作树，也没有提交或推送。

## RED 证据

在生产代码改动前新增扩展集成测试并执行：

```powershell
node node_modules/vitest/vitest.mjs --run --no-file-parallelism test/ansteel-team-extension.test.ts -t "rejects a previously healthy doctor run"
```

实际输出为 `Test Files 1 failed (1)`、`Tests 1 failed | 26 skipped (27)`。失败断言是：

```text
AssertionError: promise resolved "undefined" instead of rejecting
```

这证明在公开事件内容被篡改且未重新计算哈希后，`doctor <capturedHealthyRunId>` 仍把已捕获的健康运行报告为健康。该测试捕获的生产变异是：**移除 doctor 的落盘状态和事件重放预检，会让 doctor 错误通过。**

## GREEN 实现

`src/extensions/ansteel-team/index.ts` 新增 `verifyPersistedAnsteelTeamIntegrity()`，并在 `doctor` 的 `runObservedCommand()` 内、旧运行诊断前调用。它只使用现有核心函数：

1. `loadAnsteelTeamState()` 重新读取并验证 `team.json` 与完整 `events.jsonl` 哈希链；
2. `listAnsteelTeamEvents()` 读取完整事件链；
3. `getAnsteelTeamSharedBoard()` 重放公开协作事件并比较持久化投影。

完整性错误不会在 observed command 外抛出，因此 doctor 自己的失败运行和追踪都会持久化。公开事件链先独立验证，损坏时映射为 `event-chain-invalid`；事件链有效但 `team.json` 解析失败、账本游标改变或重放与持久化协作状态不一致时映射为 `state-projection-mismatch`。选择团队 ID 时不再把活动内存状态用作完整性证据；预检通过后仍保留原有的选定运行日志链和工件诊断。

同一测试在实现后输出 `Test Files 1 passed (1)`、`Tests 1 passed | 26 skipped (27)`。

第二轮独立规范审查发现，合法格式但不存在的 `runId` 会得到 `healthy: true`、`entryCount: 0`；只有
`started` 起点、没有同一 `spanId` 合法终态的中断运行也可能被误判。修复前从 `pi-agent` 根目录执行：

```powershell
node packages/coding-agent/node_modules/vitest/vitest.mjs --run --no-file-parallelism packages/coding-agent/test/ansteel-team-observability.test.ts packages/coding-agent/test/ansteel-team-cli.test.ts -t "returns artifact-missing|returns process-orphaned|returns RPC failure when doctor diagnoses"
```

结果为 `3 failed | 13 skipped`：两个单元断言实际得到健康诊断，真实 RPC doctor 实际返回成功。最小修复后，
空日志运行返回唯一 `artifact-missing`；每条 `started` span 必须存在序号更大、相同 `spanId` 与
`eventName` 的 `succeeded/failed/cancelled/abandoned` 终态，否则追加 `process-orphaned`。同一命令得到
`3 passed | 13 skipped`，两文件完整串行回归得到 `16 passed`。

后续规范审查用只读探针发现三个边界：第一根已结束会掩盖第二根未结束；不存在根 span 的既有低层成功
日志被误报；重启路径只看 `team.json`，没有阻断历史孤儿 span。生产修复前，新增多根、无根兼容和恢复
测试得到 `3 failed | 35 skipped`；终态早于对应起点的对抗测试另得到 `1 failed | 10 skipped`。
修复后逐一匹配所有起点；首次恢复会在原运行哈希链上为孤儿 span 追加 `abandoned/process-orphaned`，
保留父子 span、角色、会话、任务、provider、tool、process 和 lease 关联，并让本次 `start` 失败。
测试使用第二个全新 extension 实例读取同一项目目录，证明它不依赖第一个宿主的内存状态；第二次显式
启动才进入既有角色恢复。四条定向回归得到 `4 passed | 35 skipped`，两文件完整回归得到 `39 passed`。

第二轮复审继续发现已结束根 span 会掩盖未结束 `provider.request` 子 span。单元与新宿主恢复测试先得到
`2 failed | 38 skipped`；将相同配对和恢复规则推广到所有 `started` span 后，同一命令得到
`2 passed | 38 skipped`。这轮修复不再只保护根命令。

最终规范复审发现，串行恢复测试仍不能证明活跃旧宿主和并发恢复者安全：原实现没有跨进程写租约，
会把仍在运行的 span 改写为 `abandoned`，两个写者也能从同一序号和哈希链头追加；恢复还覆盖了原
`causeEventId`，并把有效事件链配合损坏状态游标误报为 `event-chain-invalid`。新增 6 条对抗回归后，
生产修复前得到 `6 failed | 40 skipped`。修复使用仓库已有 `proper-lockfile` 为每个 run 建立单写者
租约；活跃 logger 持续续租，恢复者取得租约后必须重读链头再追加，且原因果字段被保留，起点哈希写入
独立的 `recoveredFromEventHash`。同一命令修复后得到 `6 passed | 40 skipped`。

## 新增机械证据

`test/ansteel-team.test.ts` 新增了完整公开纠错链：检查点、问题、替代检查点、解决方案和问题提出者接受复核。测试将状态从磁盘重新加载后重新生成共享工作板，并与重启前投影相等。

同一文件还使用四个独立临时项目，逐一篡改 `work-checkpoint`、`process-issue`、`process-resolution` 和 `process-resolution-review` 的内容而不重算哈希。每种情况均由 `listAnsteelTeamEvents()` 和 `loadAnsteelTeamState()` 以哈希不匹配拒绝。

执行：

```powershell
node node_modules/vitest/vitest.mjs --run --no-file-parallelism test/ansteel-team.test.ts -t "replays a complete public correction loop|rejects a hash-preserving-state tamper"
```

结果：`2 passed | 55 skipped`。

独立规范审查进一步发现，原始回归只在扩展 harness 中证明了损坏拒绝，尚未通过真实 RPC 命令边界锁定
`success: false`，且 `doctor` 对两类完整性错误的原因码断言过宽。修复后：

1. 哈希链损坏精确断言为 `event-chain-invalid`；
2. 合法哈希链与 `team.json` 投影不一致精确断言为 `state-projection-mismatch`；
3. 真实 RPC 在篡改 `events.jsonl` 后分别执行 `doctor <healthyRunId>` 和 `board`，两者都必须返回
   `success: false`，且篡改后的输出不得包含 `Health: healthy` 或工作板健康内容。

为证明新增回归能够捕获生产缺陷，控制器临时移除 `doctor` 的持久化完整性预检并执行：

```powershell
node node_modules/vitest/vitest.mjs --run --no-file-parallelism test/ansteel-team-extension.test.ts test/ansteel-team-cli.test.ts -t "rejects a previously healthy doctor run|rejects doctor with a projection mismatch|returns RPC failure for board and doctor"
```

变异版本得到 `2 failed` 文件、`3 failed | 32 skipped`；其中 RPC 的 `doctor` 实际返回 `success: true`，
两个扩展测试均得到 `promise resolved "undefined" instead of rejecting`。恢复生产预检后，同一命令得到
`2 passed` 文件、`3 passed | 32 skipped`。临时变异未保留在最终差异中。

## 文档

`docs/ansteel.md` 现在说明公开工作理由与隐藏思维链的界限、四个协作工具的字段和身份限制、问题提出者专属复核/关闭规则、`board` 的落盘来源与协调器派生计数，以及 `doctor` 的持久化完整性预检、空日志拒绝、所有 span 终态检查和重启孤儿 span 失败关闭。文档明确：检查点中的黄色/红色风险目前仅记录，不会单独阻断行动；既有任务所有权和精确文件变更门禁是另一套机制。

`docs/superpowers/plans/2026-07-29-ansteel-team-public-collaboration-board.md` 已补全 Task 6 的实际源文件、测试文件与本报告，并只勾选拥有本次证据的步骤。提交/上传步骤保持未完成，遵从本任务的禁止提交和推送要求。

## 完整验证

从 `pi-agent/packages/coding-agent`：

```powershell
node node_modules/vitest/vitest.mjs --run --no-file-parallelism test/ansteel-team.test.ts test/ansteel-team-observability.test.ts test/ansteel-team-extension.test.ts test/ansteel-team-cli.test.ts
npm run build
npx biome check src/core/ansteel-team-observability.ts src/extensions/ansteel-team/index.ts test/ansteel-team.test.ts test/ansteel-team-observability.test.ts test/ansteel-team-extension.test.ts test/ansteel-team-cli.test.ts
```

最终规范审查修复后，控制器重新执行完整四文件串行回归，结果为 `4 passed` 文件、`111 passed` 测试。
`npm run build` 成功。首次把可观测性文件纳入 Biome 后，安全修复 3 个文件的格式与 import 顺序；
随后完整 6 文件 Biome 命令报告 `Checked 6 files` 且未应用修复。

从 `pi-agent`：

```powershell
.\node_modules\.bin\tsgo.cmd --noEmit
npm run check:pinned-deps
npm run check:ts-imports
npm run check:shrinkwrap
npm run check:install-lock:coding-agent
```

结果：全仓 `tsgo --noEmit` 和四项依赖检查全部退出码为 0；`check:shrinkwrap` 和
`check:install-lock:coding-agent` 分别确认对应生成文件为最新。

## 工作区检查和遗留事项

根目录 `git diff --check` 以退出码 0 完成；输出只有 Git 对计划文件的既有 LF/CRLF 转换提示，没有空白错误。`git status --short --branch` 显示当前分支为 `main...origin/main [ahead 5]`，本阶段声明边界内有 8 个受跟踪修改文件，并将强制加入本报告。工作区中原有的 `.workbuddy/`、`github-work-profile.md`、`input-output-flow.md`、`overview.md` 仍是未跟踪文件，且未被本次任务触碰。

未执行提交或推送，保留给控制器按用户要求处理。

完整持续协作协议仍有后续阶段：黄色/红色动作阻断、自动恢复对应的公共审计事件、运行日志轮转索引、
三轴终态和独立最终交付验收均不属于本次阶段完成声明。

# Ansteel Team 机械风险门禁阶段验证报告

> 状态：`阶段验收通过`
> 验收日期：`2026-07-30`
> 实现基线：`76c3918f48cdb0972334c3ae0f497eb9c75aae57`
> 当前提交前 HEAD：`980f0e9756909b07017246867e235921717db6ce`
> 阶段边界：持续协作协议迁移第 6 步
> 交付提交：`d86ebc58f218f9ca82021f8e58070d3f106796b5`
> 远端验收：GitHub Actions `Ansteel governance gate` 运行 `30548808891`，结论 `success`

## 一、阶段结果

本阶段已经实现并验收：

- 协调器机械计算绿色、黄色、红色风险，角色只能升级风险；
- 黄色/红色动作绑定精确检查点、动作类型、规范目标与版本；
- actor 之外两名同伴必须分别确认同一不可变动作；
- 开放阻断问题、拒绝、确认缺失、身份或内容漂移在真实工具执行前失败关闭；
- 默认 Ansteel `edit/write` 绑定批准文件的 `dev/ino + SHA-256` 与一次性授权；
- 可信根运行终态、共享工作板历史筛选、自动恢复审计和可校验历史索引；
- 运行日志、artifact、公共事件账本、UI 与宿主异常的统一凭据脱敏。

两份相互独立的最终复审均已通过：

- 规格复审：`APPROVED`
- 代码质量复审：`VERDICT: APPROVED / Ready to merge: Yes`

## 二、重要失败关闭修复

### 1. 可信根终态

历史工作板最初仅根据最后结果或不完整根关系筛选，可能把成功子工具或伪造父关系的终态误当作成功 run。当前要求：

- 唯一无父根起点；
- 更晚的唯一根终态；
- `spanId`、事件名与父关系一致；
- 终态 `succeeded`；
- 完整诊断健康。

伪根、孤儿、失败、进行中或废弃运行不能成为工作板事实。

### 2. 路径校验后的 junction/symlink 竞态

仅重复 `realpath` 仍存在检查与使用间竞态。最终实现把批准身份和真实 I/O 连接成同一链：

```text
检查点同句柄取得 dev/ino + SHA-256
  -> 双同伴批准完整 action.version
  -> beforeToolCall 发放一次性身份授权
  -> open 既有文件
  -> 句柄 dev/ino 匹配批准身份
  -> 当前路径、句柄、大小、SHA-256 同链重验
  -> edit 直接使用该次验证返回的 buffer
  -> write/truncate 复用已验证句柄
  -> finally 关闭句柄
```

这关闭了：

- 门禁后一次链接替换；
- 路径校验与 `open()` 之间交替 junction 替换；
- 同 inode 内容漂移；
- `edit` 二次未校验读取导致的 ABA；
- 缺失新文件降级为路径字符串创建。

受治理的 `write` 当前只能覆盖已经取得稳定身份的普通文件。Node 没有可移植的目录句柄相对原子创建能力，因此缺失文件失败关闭；普通非 Ansteel Pi `write` 仍保留原新建行为。

### 3. 凭据脱敏

脱敏器覆盖 `=`、`:`、JSON、Provider 前缀、Basic/Bearer 与 `sk-`。统一边界包括：

- runtime message；
- 嵌套 data；
- artifact；
- 公共 `events.jsonl` 在哈希前；
- UI 时间线入口；
- 向 AgentSession/RPC/print/TUI 抛出的异常。

成功角色输出与失败 provider 异常都具备对抗回归。

## 三、测试证据

工作目录：`pi-agent/packages/coding-agent`

最终七文件串行命令：

```powershell
npx vitest --run --no-file-parallelism test/ansteel-team.test.ts test/ansteel-team-observability.test.ts test/ansteel-team-extension.test.ts test/ansteel-team-cli.test.ts test/tools.test.ts test/edit-tool-legacy-input.test.ts test/edit-tool-no-full-redraw.test.ts
```

最终结果：

- 退出码：`0`
- Test Files：`7 passed`
- Tests：`241 passed / 1 skipped`
- Duration：`293.16s`

其中：

- 核心、可观测性、扩展：`145/145`
- CLI/RPC：`12/12`
- 新增对抗覆盖：交替 junction、同 inode 内容漂移、成功角色公共输出脱敏、provider 失败对宿主异常脱敏

CLI/RPC 首次完整运行曾有一项 15 秒进程启动等待超时，stderr 为空；同名用例单独重跑通过，随后完整文件重跑 `12/12`，最终七文件回归再次通过。因此该次超时按可复现证据判定为启动抖动，不作为最终失败。

## 四、构建与静态检查

工作目录：`pi-agent`

以下命令均取得退出码 `0`：

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

`git diff --check` 只有 Markdown 的 LF/CRLF 策略提示，没有 whitespace 错误。

## 五、提交范围与敏感信息

阶段提交只包含计划声明的文档、实现与测试。明确排除：

- `.workbuddy/`
- `github-work-profile.md`
- `input-output-flow.md`
- `overview.md`
- `docs/superpowers/reports/2026-07-30-ansteel-team-section-17-evidence-matrix.md`
- `.pi/`、运行日志、事故包和本机配置

高熵密钥扫描无命中。测试中的 `provider-secret`、`json-secret`、`artifact-secret` 等均为短假夹具，不是真实凭据。

## 六、独立复审轨迹

复审不是一次性形式批准。两名审查者先后发现并推动关闭：

- 伪根终态；
- 门禁后链接漂移；
- validate/open/stat 交替 junction 竞态；
- 同 inode 内容漂移；
- `edit` 二次读取 ABA；
- artifact 冒号/JSON/Basic 脱敏；
- provider 原异常重新进入公开通道；
- 正常角色输出绕过公共账本/UI 脱敏；
- 新增守卫文件和 CLI 测试遗漏提交范围；
- 计划中残留的外部流程技能调用要求。

最终两份批准均绑定当前最新工作树，且互不读取对方结论。

## 七、自审结论

- 工具执行前门禁：通过；
- 风险只升不降：通过；
- 双同伴独立确认：通过；
- 精确动作与版本绑定：通过；
- 绿色动作记录：通过；
- 开放问题阻断：通过；
- 自动恢复与索引重建审计：通过；
- 核心、扩展、CLI/RPC 和对抗边界测试：通过；
- 最终双独立验收保留：通过；
- 计划接口与步骤完整性：通过；
- 提交范围、中文提交消息和唯一 `main` 目标：预审通过。

## 八、未完成边界

本阶段交付时不把以下事项写成已完成：

- 迁移第 8 至 10 步；
- `collaborationStatus`、`governanceStatus`、`deliveryStatus` 三轴；
- 角色签名、日志段签名、里程碑 Merkle Root 与外部锚定；
- 日志轮转和保留自动化；
- 真实三个不同 provider 的完整链路探针；
- 最终交付正确性。

提交 `d86ebc58f218f9ca82021f8e58070d3f106796b5` 对应的 GitHub Actions 已成功，迁移第 6 步完成远端验收。第 7 步的三角色类型化并行任务迁移由独立计划继续记录，不反向改写本报告的第 6 步验收边界。

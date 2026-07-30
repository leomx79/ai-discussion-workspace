# Ansteel Team 机械风险门禁独立规格复审

> 最终状态：`APPROVED`
> 复审日期：`2026-07-30`
> 复审基线：`980f0e9756909b07017246867e235921717db6ce` 加当前未提交工作树
> 独立性：规格复审者未读取或依赖代码质量复审结论，未修改文件、暂存、提交或推送

## 一、结论

独立规格复审按持续协作协议第 9、10、18 节和迁移表第 6 步检查真实生产调用链、失败关闭语义、对抗测试与提交边界。复审中发现的阻断已逐条修复并复核，当前没有阻止迁移第 6 步验收的规格偏差。

最终判定：

`VERDICT: APPROVED`

## 二、机械风险与动作批准

- L1：风险由协调器根据工具、规范目标、覆盖语义和当前版本计算，角色声明只能升级，不能降低。
- L1：黄色与红色动作绑定活动检查点、动作类型、规范目标和版本；actor 不能自批，必须取得另外两名角色的独立确认。
- L1：开放的 `blocking`/`critical` 问题、确认缺失或拒绝、目标或版本漂移均在工具执行前阻断。
- L1：绿色只读动作无需等待确认，但仍写入公共动作评估和运行事实。

主要实现位于：

- `pi-agent/packages/coding-agent/src/core/ansteel-team.ts`
- `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts`
- `pi-agent/packages/coding-agent/test/ansteel-team.test.ts`
- `pi-agent/packages/coding-agent/test/ansteel-team-cli.test.ts`

## 三、文件身份与最终 I/O 边界

初始修复只在路径校验后复用打开句柄，仍无法证明 `open()` 取得的对象就是批准时的项目文件。最终实现增加了不可变文件身份：

1. 检查点发布时以同一个只读句柄取得非零 `dev/ino` 与内容 SHA-256，并把三者写入 `action.version`；
2. 两名同伴批准完整版本；
3. `beforeToolCall` 只在动作批准后把该身份交给当前角色会话的一次性 mutation 授权；
4. 守卫打开文件后立即比较批准 `dev/ino`；
5. 每次读取或写入前，通过同一 `FileHandle` 和显式 position 读取，核对当前路径、句柄身份、文件大小与批准 SHA-256；
6. `edit` 使用的 buffer 就是同一次 `revalidateAndRead()` 校验后返回的 buffer，不再执行第二次未校验读取；
7. 真正覆盖和截断继续使用该句柄，不按路径字符串重新打开。

因此：

- L1：校验后交替切换 Windows junction，若 `open()` 得到项目外对象，会因身份不符在写入前拒绝；
- L1：打开批准对象后再替换 junction/symlink，后续 I/O 仍绑定批准句柄；
- L1：同 inode 内容漂移会因 SHA-256 不符拒绝；
- L1：缺失目标、零 inode、旧纯内容哈希版本、身份或内容漂移均失败关闭；
- L1：普通非 Ansteel Pi `write` 未启用此守卫，仍保留原有新建文件行为。

## 四、可信运行历史

- L1：可信根终态必须与唯一无父 `run.started` 的 `spanId`、事件名和父关系严格一致。
- L1：伪造 `parentSpanId` 的子终态不能关闭根运行。
- L1：工作板只接纳同团队、非当前、根终态成功且完整诊断健康的历史运行。
- L1：孤儿、失败、进行中、废弃或伪成功运行不能成为共享工作板事实。

主要实现与测试位于：

- `pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts`
- `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts`
- `pi-agent/packages/coding-agent/test/ansteel-team-observability.test.ts`
- `pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts`

## 五、统一脱敏边界

- L1：运行日志、嵌套数据和 artifact 共用统一脱敏器，覆盖 `=`、`:`、JSON 键值、Provider 前缀、Basic/Bearer 和 `sk-`。
- L1：公共事件在哈希、重放和持久化前递归脱敏。
- L1：UI 时间线入口再次脱敏，正常成功角色输出也不能绕过。
- L1：最外层命令不再向 AgentSession、RPC、print 或 TUI 重新抛出原始 provider 错误，而是抛出保留稳定原因码、仅含脱敏消息的新异常。

## 六、提交边界

`guarded-file-mutation.ts` 和 `ansteel-team-cli.test.ts` 已同时列入 Task 6 Files、Biome 检查命令与显式 `git add` 清单。计划内不再包含任何要求调用外部流程技能的指令。

明确排除：

- `.workbuddy/`
- `github-work-profile.md`
- `input-output-flow.md`
- `overview.md`
- 未声明的历史报告
- `.pi/`、运行日志、事故包与本机配置

## 七、验证证据

协调器在最终批准后的同一源码快照上取得：

- 七文件串行回归：`7/7` 文件通过，`241 passed / 1 skipped`；
- `npm run build`：退出码 `0`；
- 目标类型检查和对抗回归：退出码 `0`。

独立复审者通过静态追踪真实默认角色工厂、一次性授权、句柄读取/覆盖、公共事件和 UI 输出链，并逐条复核阻断修复后给出批准。

## 八、边界

本复审只批准迁移第 6 步，不证明迁移第 7 至 10 步、真实三提供商链路、角色签名、Merkle 外部锚定或最终交付正确性。动作确认不能替代任务、里程碑和最终交付的双独立验收。

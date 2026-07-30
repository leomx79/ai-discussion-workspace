# 鞍钢三角色持续协作后的最终独立验证实施计划

> 日期：2026-07-31
> 对应协议步骤：第 8 步
> 范围：把任务与里程碑的“双评审”从提交后的主要协作机制，迁移为公开持续协作完成后的末端独立验证。

## 目标与边界

本步骤保留不可变提交证据、双非 owner 验证、QA 否决、依赖仅在批准后释放，以及风险动作的既有双确认。变化是：owner 提交证据后，不再立刻把两名同伴拉入最终 APPROVE/REJECT；两名同伴必须先在公共账本中完成一次带证据的协作更新。只有协作更新齐备、阻断问题已闭合且证据未漂移时，协调器才开始彼此不见当轮答复的最终独立验证。

本步骤不实现第 9 步的 `collaborationStatus`、`governanceStatus`、`deliveryStatus` 三轴，也不把任务批准解释为项目交付、真实三提供商运行或外部签名证明。

## 状态与兼容迁移

1. 状态版本从 v9 升至 v10。
2. 任务和里程碑增加 `collaborationUpdates`。每条更新固定到一个不可变 revision，记录非 owner 角色、公开摘要、证据引用、不确定点和时间；同一角色对同一 revision 最多一条。
3. 任务状态增加 `final-verification`，里程碑状态同样增加该值：
   - `submitted`：owner 的证据包已冻结，处于公开持续协作阶段；不能直接评审。
   - `final-verification`：协调器已机械确认协作准备条件，允许两名非 owner 执行最终独立 `approve/reject`。
   - `revision-required`：公开协作中的 blocking/critical 问题，或最终验证的 reject，均退回 owner 重做证据。
4. v9 的 `submitted` 任务和里程碑迁移到 `final-verification`，并补空的 `collaborationUpdates`。这是历史语义保留：旧版本已经把 submitted 解释为立即双评审，迁移不能假称它经历了新的持续协作阶段。
5. v8 必须先迁移到 v9，再迁移到 v10；不得以当前版本常量跳过 v9 的任务类型补全。

## 机械门禁

任务开始最终验证前必须同时满足：

1. 状态为 `submitted`，最新提交与当前 revision 一致，且冻结测试为成功结果。
2. 两名非 owner 都已为该 revision 写入各自的公开协作更新。
3. 没有绑定到该任务检查点的未关闭 `blocking` 或 `critical` 过程问题。
4. 当前精确 claimed-file Git diff 与冻结 diff 字节一致。发生漂移时，协调器把任务退回 `revision-required`，清空可复用测试证据，并公开记录原因；不能让同伴批准过期包。

里程碑使用同样的两名非 owner 协作更新和成功冻结集成测试条件；其关联任务检查点上的未关闭 blocking/critical 问题也会阻断收口。

在 `submitted` 阶段，非 owner 若发现需要返工的问题，必须针对公开检查点使用既有 `ansteel_raise_process_issue`。该问题若为 `blocking` 或 `critical` 且目标属于已提交任务，核心状态机立即退回 owner；普通散文不能替代这一结构化退回。

## 扩展调度

1. `ansteel_submit_change` 和 `ansteel_submit_integration` 只冻结证据并启动或排队“持续协作更新”提示。
2. 新工具 `ansteel_publish_task_collaboration` 与 `ansteel_publish_integration_collaboration` 只记录公开协作材料，不提供批准权。
3. 协作更新齐备后，协调器发出 `*-final-verification-requested` 公共事件，将状态转为 `final-verification`，再向两名同伴并发发送现有独立验证提示。两份最终提示共享同一冻结包，但不包含另一人的当轮答复。
4. 并行 owner wave 期间，协作提示和最终验证提示使用同一个按 `kind/id/revision` 去重的延迟队列。所有 owner settle 后才顺序 flush；失败项保留，重启从 v10 状态只重建缺失协作或缺失最终验证。
5. `/ansteel-team task TASK-ID` 保持唯一恢复入口：它不会新建任务，也只补齐当前阶段缺失的角色操作。

## 事件、文档与可观测性

新增公开事件区分 `task-collaboration`、`milestone-collaboration`、最终验证请求和协作退回；既有 `task-review`、`milestone-review` 在 v10 中只表示最终独立验证。事件正文不承载秘密，运行日志继续只记录脱敏结构化结果。

交互文档须说明：协作更新不是批准；最终批准不是交付成功；真实三提供商探针仍未执行。

## 验收与反例

核心测试至少覆盖：

1. 没有两份协作更新时，`reviewTask` 和 `reviewMilestone` 均失败，依赖不释放。
2. 两份更新齐备后，只有协调器开始最终验证才允许两名非 owner 独立批准；任一 reject 仍退回 owner。
3. blocking/critical 过程问题把已提交任务退回 owner，且未关闭问题不能开启最终验证。
4. 冻结后 claimed-file diff 漂移不能进入最终验证，也不会留下可复用的成功测试证据。
5. v9 已提交状态迁移为遗留 `final-verification`，v7/v8 连续迁移不跳过任务类型。
6. 单任务、三 owner 并行任务、延迟队列失败重启、里程碑集成的扩展与 CLI/RPC 回归，都能观察到“协作更新在最终验证之前”的事件顺序。
7. 回归仍包含构建、类型检查、Biome、`git diff --check`、高熵凭据扫描、串行 Vitest 及远端 GitHub Actions。

## 自审清单

- [x] v10 状态断言不允许 owner 在 `final-verification` 中自评或修改。
- [x] 协作更新按 revision、参与者和证据引用去重并持久化。
- [x] 最终验证启动前检查冻结包、公开协作、过程问题和当前 diff。
- [x] 任务与里程碑均保留双独立最终验证，不把协作更新当作会签。
- [x] 并行 deferral、失败重试和重启重建不会丢失或提前执行跨角色提示。
- [x] 旧 v9 状态不被伪造为已完成持续协作。
- [ ] 远端 GitHub Actions 与实现一致。

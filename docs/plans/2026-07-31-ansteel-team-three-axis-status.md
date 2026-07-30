# 鞍钢三轴状态实施计划

> 日期：2026-07-31
> 对应协议步骤：第 9 步
> 范围：以持久团队事实机械投影 `collaborationStatus`、`governanceStatus`、`deliveryStatus` 与 `workflowStatus`；不把模型文本、任务批准或动作确认伪装成已交付。

## 状态边界

1. 三轴是从现有团队状态、公开协作更新、最终评审、过程问题与动作会签计算出的只读投影，不是角色可直接写入的字段。
2. `collaborationStatus` 使用设计中的 `orienting`、`active`、`disputed`、`resolving`、`ready-for-verification`、`collaboration-complete` 与 `blocked`。仅当每个当前任务或里程碑都具有所需协作更新和最终批准，且没有开放问题时，才会得到 `collaboration-complete`。
3. `governanceStatus` 使用 `not-required`、`pending`、`approved` 与 `rejected`。最终评审拒绝或非绿色动作会签拒绝才得到 `rejected`；未完成协作、验证或动作会签保持 `pending`。
4. 当前运行时没有受信任、可重放的交付验证记录，因此 `deliveryStatus` 固定为 `not-started` 并给出机械原因。任务或里程碑批准、动作会签以及 GitHub Actions 文本均不能把它提升为 `passed`。
5. `workflowStatus` 只有在协作完成、治理满足且交付已通过时才会是 `completed`。当前没有交付证据记录通道，因此它保持 `in-progress` 或由未闭合争议导出的 `blocked`；本步骤不改变已有任务依赖释放语义。

## 接入点

1. 在 `ansteel-team.ts` 定义轴类型、解释对象和纯 `getAnsteelTeamStatusAxes` 投影，并将结果加入共享工作板。
2. 在交互扩展的 `/ansteel-team status` 与 `board` 文本中显示三轴、工作流状态及派生原因。
3. 维持 v10 持久状态版本，不从旧 `approved` 或 v9 遗留状态制造协作或交付完成。
4. 添加核心与扩展确定性测试，覆盖初始状态、公开争议、最终验证、批准未交付、非绿色动作会签和 v9 遗留迁移。

## 验收清单

- [x] 三轴类型和投影只依赖已验证持久事实，且状态断言失败时关闭读取。
- [x] 开放 blocking/critical 问题、升级问题和角色失败不会被显示为协作完成。
- [x] 最终双独立批准可得到协作与治理完成，但仍不能得到交付通过或工作流完成。
- [x] 旧 v9/v10 遗留批准状态不会伪造持续协作或交付成功。
- [x] `status --explain` 与工作板显示相同的机械三轴与原因。
- [x] 构建、类型检查、串行 Vitest、双独立复审、详细中文提交、推送和 GitHub Actions 完成。

## 本地自审记录

- `getAnsteelTeamStatusAxes` 先校验持久状态，再按失败、升级、争议、最终验证和正常协作的安全优先级投影状态；它不写入 `team.json`，因此旧状态不会在读取时被篡改。
- `deliveryStatus` 当前只会给出 `not-started`。没有新增受信任、可重放的交付证据记录之前，任务/里程碑批准、动作会签、Git 或 CI 文本不能导出 `passed`。
- 两份独立复审分别发现并关闭了三类假阳性：遗留 v9 `final-verification`/`approved` 不得声称协作就绪、动作-only 会签拒绝必须阻断工作流、`status` 必须和工作板一样拒绝持久状态投影不一致。
- 已运行 `npm run build`、`tsgo --noEmit -p packages/coding-agent/tsconfig.build.json` 与 GitHub workflow 等价的六文件串行 Vitest：`325 passed`。讨论超时和扩展集成测试仅放宽 Vitest 外层等待，内部协议超时与失败关闭断言保持不变。
- 提交 `f5f571140a86e34b6873b465a574fc729bc7b756` 已推送 `main`。GitHub Actions `Ansteel governance gate` 运行 `30574642567`、`Ansteel delivery candidate` 运行 `30574826383` 均为 `success`；候选工作流只产出并上传未发布的包，因此不改变 `deliveryStatus: not-started` 的协议边界。

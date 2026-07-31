# 鞍钢真实三提供商探针运行报告（耐久租约队列）

> 日期：2026-07-31（r1-r7）
> 对应方案：《鞍钢宪法式三 AI 持续协作协议设计》第 20.4 节真实提供商探针
> 探针项目（gitignored 运行区）：`artifacts/runtime/ansteel-e2e-real-three-provider/`

## 一、三角色 provider/model 映射（L1：四个真实端点探测/运行连通）

| 角色 | provider/model | 端点 | 运行证据 |
|---|---|---|---|
| tech-lead | `volcengine-agent-plan/glm-5.2` | https://ark.cn-beijing.volces.com/api/plan/v3 | r1-r7 TL 阶段全部真实完成 |
| staff-engineer | `deepseek-flash/deepseek-v4-flash`（r1-r6）/ `deepseek-v4-pro`（r7） | https://api.deepseek.com/v1 | r2-r7 全部真实完成（修复 401 与空输出后） |
| qa-engineer | `volcengine-coding/doubao-seed-2.1-turbo` | https://ark.cn-beijing.volces.com/api/coding/v3 | r2-r7 全部真实完成，含 L1 证据否决与会签 |

## 二、运行记录与治理结果

| 轮次 | 结果 | 说明 |
|---|---|---|
| r1（08-22-06Z） | REJECTED / stage-failure | TL 完成；Staff 401（`auth.json` 过期 key），fail-closed |
| r1 resume | 配置拒绝 | failed 状态 checkpoint 不可续跑（按设计拒绝） |
| r2（08-29-01Z） | REJECTED / stage-failure | 三角色 critique 全过；Staff 交叉质询空输出（`empty-public-update`）fail-closed |
| r3（08-52-26Z） | REJECTED / stage-timeout | 完整循环 + 13 个 ISSUE；QA-4 REJECT；TL 修订 210s 超时 |
| r4（09-34-03Z） | REJECTED / QA 否决 | 两轮修订+两轮验证全完成；QA-5 行号证据否决（design.md 15-18 行目标区 vs 卡内 20-23） |
| r5（09-57-10Z） | REJECTED / invalid-verdict | 14 个 ISSUE 全部 resolved；Staff 最终验证未给出精确 VERDICT 行 |
| r6（10-22-26Z） | REJECTED / QA 否决 | QA-6/7/8 高质量证据争议（design.md 可读性、JSON.stringify 换行转义）；两轮上限后拒绝 |
| **r7（11-01-44Z）** | **APPROVED / 双会签** | 两轮修订+两轮验证+TL 共识+Staff/QA 最终会签全部完成（118/120 工具调用）；共识带出六项跟进 |

r7 报告状态原文：`Three revised work cards passed independent three-role verification, then received final Staff Engineer and QA Engineer sign-off.`

## 三、执行中发现问题与修复（“有什么问题解决什么问题”）

1. **Staff 401**：pi 鉴权解析顺序为 auth.json > 环境变量 > models.json，`~/.pi/agent/auth.json` 里 `deepseek-flash` 是过期 key。修复：更新为新 DeepSeek key。
2. **Staff 空公开输出**：DeepSeek 推理模型在 `maxTokens` 预算不足时返回 `stop` 但 content 为空。修复：models.json `deepseek-flash` 显式 `maxTokens: 8192`。系统按 `empty-public-output` fail-closed。
3. **修订预算不足**：r3 TL 修订 210s 超时。修复：探针 `stageTimeoutMs 300000`、`maxStageExtensions 2`、`projectTimeoutMs 2700000`。r4-r7 全流程在预算内完成。
4. **评审对象安全缺陷**：修复 `src/lease-queue.mjs`（安全整数、确定性 canonicalize 保留 `__proto__`、不透明 token、原子 fsync），6 个回归测试通过。
5. **design.md 编码损坏（r6 争议根因）**：探针文件首次创建时协调器管道未设 UTF-8 输出编码，中文被写成 `?`（字节级证实：首字节 `35,32,63`）。修复：重写为 UTF-8（字节 `35,32,232,128,144,...`，首行 `# 耐久租约队列真实三提供商探针`），r7 起可读可 grep。同时修正 canary 模型说明（r7 Staff=deepseek-v4-pro）。
6. **r5 格式门禁**：Staff 最终验证未输出精确 `VERDICT` 行（invalid-verdict fail-closed，系统按规格行为）。r7 更换 Staff 为 `deepseek-v4-pro` 后完成会签。

## 四、对照设计 20.4 验收项

1. 三个不同 provider/model 独立 canary：通过（r1-r7 三角色全部真实调用）。
2. 三个角色形成同一共享工作框架：通过。
3. 安全整数与 canonicalization 假设在实现过程中公开：通过。
4. 其他角色用独立工具构造边界反例：通过（QA-4/QA-5/QA-6/QA-7/QA-8、STAFF-9 等 L1 证据挑战）。
5. 错误在最终提交前触发问题、修正和复验：通过（r4-r7 多轮修订+验证；r7 达成 APPROVED 共识）。
6. 公共时间线可完整重放认知变化：通过（checkpoint + 报告保留全部阶段审计轨迹）。
7. 最终独立验收通过后才解锁依赖：通过（r7 会签通过后才形成共识；此前 r1-r6 全部 fail-closed 未解锁）。
8. 人为制造 provider/工具失败后诊断：通过（401/空输出/超时/格式拒绝均 fail-closed，checkpoint 记录失败阶段与原因码）。
9. 无 Oracle、协调器私有状态或遗留子进程：通过（角色会话全部退出；仅存 MCP 基础设施进程）。

## 五、r7 APPROVED 共识带出的跟进项（部分需产品/规格负责人决策）

1. design.md 编码与目标文本规范化：已由协调器修复（UTF-8 字节级验证），全部四项验收条件可逐字引用。
2. 每项缺口（过期自动回收、审计持久化、损坏行行为等）的 in-scope/out-of-scope 分类：需负责人决策。
3. 并发模型边界（单进程 vs 多进程 flock）：需负责人决策。
4. 确认必需缺口的实现+测试：随第 2/3 项决策。
5. QA 扩展边界测试（expired-reacquire、renew-after-expiry、corrupt-line、list 形状）：已完成。探针测试扩至 10/10：新增 4 个行为捕获测试；`load()` 对损坏行统一为稳定的 `corrupt lease record` 失败关闭错误。
6. 模型标识一致性：已由协调器修正（design.md 注明 r7=deepseek-v4-pro，r1-r6=deepseek-v4-flash）。

## 六、边界声明（不得过度宣称）

- 本次运行使用 `pi --ansteel` 非交互证据优先评审路径；`/ansteel-team` 持久化交互团队流程（start/ask/task/status/anchor）仍需在交互式 Pi 中单独运行验证。
- 治理结果：r7 `APPROVED`（双会签）；交付结果：`NOT_DELIVERED`（评审不实现任务）。APPROVED 表示规定角色完成规定检查并达成共识，不表示代码已正确交付。
- 跨模型 L1 证据已升级：三个真实 provider/model 在评审管线中完成完整持续协作循环并获得 APPROVED 共识与会签（r7）。


## 七、持久化团队 /ansteel-team 真实三提供商验证（RPC 无头驱动 r2-r8）

### 7.1 运行记录

| 轮次 | 结果 | 关键事件 |
|---|---|---|
| r2 | 失败（checkpoint 引用未分配任务 ID） | TL/Staff 读取正常；模型发明 TASK-SE-LEASE-REVIEW → checkpoint 校验失败 → role-failure fail-closed |
| r3 | 失败（ID 格式 / bash 跑测试） | TL 首个 checkpoint 成功、第二个违反 CP-<UPPERCASE-ID>；Staff 三次尝试 bash 跑测试被工具策略拒绝 |
| r4 | 失败（交叉质询 TL 300s 超时） | **investigation 三角色全部完成（3 份独立报告）**；QA 交叉质询完成；TL 交叉质询超时 fail-closed |
| r7 | 失败（checkpoint 漏必填 risk/confidence） | investigation TL/QA 完成；Staff 第二次 checkpoint 漏字段 → 校验失败 |
| r8 | 失败（同 r7 模式，交叉质询 Staff） | **investigation 三角色完成（3 报告 + 4 checkpoint）**；交叉质询 TL/QA 完成，QA 发布 CP-QA-CROSS-EXAM-FINDINGS 并产生 1 个 process-issue；Staff 交叉质询 checkpoint 漏必填字段 → fail-closed |
| r9 | 失败（交叉质询 TL checkpoint supersedes 未知） | investigation 三角色完成；TL 交叉质询 checkpoint 报错（supersedes 未知）后未重试即收尾 → fail-closed（新语义生效） |
| r10 | 失败（重试语义正确判死） | 错误信息升级为 without a successful retry；TL 交叉质询 checkpoint 报错后未重试 |
| r11 | 失败（无任务时误调任务工具） | Staff 在 investigation 轮调用 ansteel_publish_task_collaboration（无已分配任务）→ 正确判死 |
| **r12** | **成功（start 返回 success=true）** | **investigation + 交叉质询两轮三角色全部完成**：6 份角色报告、4 个合规 checkpoint、零角色失败、零未决问题 |

全部轮次均产生签名账本（Ed25519 manifest + 事件链）、team.json（checkpoint/问题台账）、运行日志（精确原因码）、角色会话文件；无 Oracle/协调器私有状态访问。

### 7.2 已修复的四个真实根因（均有 153 项回归 + 治理门禁）

1. `34aab2d`：角色提示词约束不得引用未分配任务 ID（r2 根因）
2. `e7921df`：结构化 ID 格式（CP/PI/PR/TASK-<UPPERCASE-ID>）写入提示词与工具说明（r3 根因）
3. `78371b7`：investigation 阶段不得用 bash 跑测试（r3 根因）
4. `e33cc73`：checkpoint 工具说明显式列出全部必填字段（r7 根因；r8 表明 deepseek-v4-pro 在交叉质询仍可能漏 risk/confidence）
5. `3645bd4`：**治理工具入参错误阶段内可重试（核心语义修复）**——agent-loop 本就返回工具错误给模型，扩展层 fail-closed 检查改为"最后一次仍失败或累计超 3 次才判死"；新增 3 个回归用例；docs/ansteel.md 记录语义
6. `64393f4`：提示词要求治理工具报错必须修正重试，不得带错收尾
7. `b54242c`：未分配任务前禁止调用任务/里程碑工具

### 7.3 边界与设计观察（诚实声明）

- 持久化团队 `start` 流程（investigation + 交叉质询两个轮次）已在 r12 **完整跑通**：三角色全部完成、零角色失败。修订/验证/共识/会签等后续轮次由任务驱动（`/ansteel-team task` 分配任务后的 epoch 流程），超出只读评审探针范围，需任务型运行另行验证。`--ansteel` 评审管线已取得 APPROVED 共识（见第五节），二者是不同执行路径。
- 设计观察（待负责人决策）：工具入参 schema 校验错误当前直接杀死整个角色阶段（模型看不到错误、无法重试）；而"可修复的入参遗漏"与"治理违规"在语义上不同。是否让工具入参错误在当前阶段内可重试（作为工具结果返回给模型），同时保留治理违规 fail-closed，是协议语义决策，需用户拍板。
- 恢复语义：`start` 对已存在团队只恢复会话不重跑轮次；续跑用 `ask`，且 `ask` 只在账本存在未决义务时产出新事件（r4 后 openChallenges=0 时空跑属正常）。


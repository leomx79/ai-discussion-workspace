# 鞍钢真实三提供商探针运行报告（耐久租约队列）

> 日期：2026-07-31 至 2026-08-01（`--ansteel` r1-r7；`/ansteel-team` r2-r20）
> 对应方案：《鞍钢宪法式三 AI 持续协作协议设计》第 20.4 节真实提供商探针
> 探针项目（gitignored 运行区）：`artifacts/runtime/ansteel-e2e-real-three-provider/`、`artifacts/runtime/ansteel-team-dual-counter-r19/`、`artifacts/runtime/ansteel-team-dual-counter-r20/`
> 最终结论：L1，真实治理机制已验证；双计数修复后的 r20 首次触达持久化任务级交付闭环。该单次成功证明链路可达，不证明真实模型下已稳定收敛

## 一、三角色 provider/model 映射（L1：真实端点探测与运行连通）

| 角色 | provider/model | 端点 | 运行证据 |
|---|---|---|---|
| tech-lead | `volcengine-agent-plan/glm-5.2` | https://ark.cn-beijing.volces.com/api/plan/v3 | r1-r7 TL 阶段全部真实完成 |
| staff-engineer | `deepseek-flash/deepseek-v4-flash`（r1-r6）/ `deepseek-v4-pro`（r7） | https://api.deepseek.com/v1 | r2-r7 全部真实完成（修复 401 与空输出后） |
| qa-engineer | `volcengine-coding/doubao-seed-2.1-turbo` | https://ark.cn-beijing.volces.com/api/coding/v3 | r2-r7 全部真实完成，含 L1 证据否决与会签 |

持久化任务阶段随后轮换了六个显式模型身份：GLM-5.2、DeepSeek v4-pro、DeepSeek v4-flash、Doubao Seed 2.1 Turbo、Kimi K2.7 Code、GPT-5.5。r17-r20 的最终组合为 TL=`micuapi/gpt-5.5`、Staff=`deepseek-flash/deepseek-v4-flash`、QA=`volcengine-coding/kimi-k2.7-code`。L1：配置、真实调用记录与 r20 状态快照能证明每轮使用的显式身份和端点响应。L3：这些外部证据不能证明供应商内部没有路由到共享后端。

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

- L1：`pi --ansteel` 非交互证据优先评审路径已在 r7 得到 APPROVED 与双会签；`/ansteel-team start` 已在 r12 完整跑通，r13-r18 真实进入三角色并行任务、检查点、动作评审、过程问题、有限重试和修复回合，r20 首次完成任务提交至双最终审批。两条路径证明不同能力，不能互相替代。
- L1：治理评审结果为 r7 `APPROVED`（双会签）；r20 的 `TASK-MINIMAL-DELIVERY` 为 `approved`（任务级双审批）。APPROVED 只表示对应门禁已通过，不能越级解释为系统级 delivery 验证已经完成。
- 跨模型 L1 证据已升级：三个真实 provider/model 在评审管线中完成完整持续协作循环并获得 APPROVED 共识与会签（r7）。
- L1：r13-r18 均未形成任务 submission；双计数修复后的 r20 已形成 revision 1 submission、两个协作更新、最终独立验证请求和 TL/QA 两个 `approve`，任务状态为 `approved`。r20 的系统三轴状态仍将 delivery 显示为 `not-started`，因为未配置独立、可重放的 delivery-verification 证据；任务批准不能伪造成 `deliveryStatus: passed`。


## 七、持久化团队 /ansteel-team 真实三提供商验证（RPC 无头驱动 r2-r20）

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
| r13 | 终态：任务未交付（正确 fail-closed） | **三角色并行任务迁移真实运行**：3 个并行任务全部认领（TL 架构/Staff 实现/QA 验证，文件互不重叠）；424 事件、44 checkpoint、10 process-issue、18 次动作评审、11 次角色失败；QA 测试编辑被 TL/Staff 以 critical（PI-STF-TEST-BUGS：writeFileSync 未导入、空白 owner 语义不符）否决，任务 8 轮 epoch 上限停止（submissions=0） |
| r14 | 终态：任务未交付（retry-limit） | start 完成 6 份报告、7 个 checkpoint、2 个 process-issue、零角色失败；三任务认领后 QA（Doubao）连续 4 次 checkpoint 入参错误，达到阶段重试上限并失败关闭；没有形成 submission。 |
| r15 | start 失败（跨模型合规复现） | QA 换为 Kimi 后端点探测和合规 checkpoint 均成功；TL（GLM-5.2）在 checkpoint 报错后未成功重试，证明同类工具契约摩擦并非 Doubao 单点问题。 |
| r16 | 终态：任务未交付（no-progress + 工具错误） | TL 换为 GPT-5.5；start 完成 6 份报告、7 个 checkpoint、零失败。任务阶段观察到 201 个事件：TL 的 `TASK-LEASE-CONTRACT` 连续两个 epoch 无受治理交付进展而停止；Staff（DeepSeek v4-pro）在任务协作工具报错后未成功重试；没有形成 submission。 |
| r17 | 终态：任务未交付（外部配额 + no-progress） | 2b 生效且 Staff 换为 DeepSeek v4-flash；start 完成 6 份报告、7 个 checkpoint、零失败。QA（Kimi）连续 5 次收到 `429 AccountQuotaExceeded`（5 小时配额），Staff/QA 随后触发连续无进展停止；最终观察到 179 个事件。 |
| **r18** | **终态：已停止；工作流 blocked，交付 not-started** | Kimi 配额探测恢复后启动；start 再次零失败。任务阶段最终落盘 233 个公共事件、25 个 checkpoint、3 个 process-issue、8 次动作评审、1 个 process-resolution、3 个 role-failure；三个任务均保持 claimed，submission/collaboration/final review 均为 0。 |
| r19 | 无效探针（夹具泄漏，已正式停止） | 驱动文件误放入被审项目 `.pi/`，QA 读取到未来任务 ID 并在任务分配前引用；checkpoint 累计 3 次输入错误后 fail-closed。L1：公共账本只有 31 个事件、1 个 role-failure、tasks=0，源文件无差异；通过受支持 RPC `stop` 后 team=`stopped`、三角色均 idle。该轮不能用于评价双计数。 |
| **r20** | **成功：任务级持久化交付闭环首次可达** | 外置驱动消除夹具泄漏；start/task/stop 均 `success=true`。`TASK-MINIMAL-DELIVERY` revision 1 从任务分配、两组 peer action review、测试与提交、两个协作更新、最终验证请求走到 TL/QA 双 `approve`，终态 `approved`；零 role-failure。 |

r14-r17 的明细来自本地 Codex 任务 `019fb556-a152-70d0-ba4f-b1d9b30c3f16` 的运行转录；后续轮次会重建同一个 gitignored 探针目录，因此不能把 r14-r17 写成可由 GitHub checkout 单独重放的产物。L1：当前文件系统分别保留 r18、r19、r20 的签名账本（Ed25519 manifest + 事件链）、team.json、运行日志与角色会话；r20 另有外置驱动、RPC 转录和汇总 JSON。L3：没有证据表明角色访问了 Oracle 或协调器私有状态，但该否定结论受现有审计面限制。

### 7.2 已修复的真实根因（均有确定性回归 + 治理门禁）

1. `34aab2d`：角色提示词约束不得引用未分配任务 ID（r2 根因）
2. `e7921df`：结构化 ID 格式（CP/PI/PR/TASK-<UPPERCASE-ID>）写入提示词与工具说明（r3 根因）
3. `78371b7`：investigation 阶段不得用 bash 跑测试（r3 根因）
4. `e33cc73`：checkpoint 工具说明显式列出全部必填字段（r7 根因；r8 表明 deepseek-v4-pro 在交叉质询仍可能漏 risk/confidence）
5. `3645bd4`：**治理工具入参错误阶段内可重试（核心语义修复）**——agent-loop 本就返回工具错误给模型，扩展层 fail-closed 检查改为"最后一次仍失败或累计超 3 次才判死"；新增 3 个回归用例；docs/ansteel.md 记录语义
6. `64393f4`：提示词要求治理工具报错必须修正重试，不得带错收尾
7. `b54242c`：未分配任务前禁止调用任务/里程碑工具
8. `6e57592`：**机械修复回合 + 协调器风险推导（2b）**——模型在阶段最后一次治理工具错误后不能直接带错收尾；协调器强制一次定向修复回合，未调用治理工具或再次失败仍按原始工具名失败关闭。checkpoint `risk` 改由协调器按动作机械推导并取不低于模型声明的风险，`confidence` 仍由模型必填。核心、CLI/RPC 与扩展定向回归为 159/159；`dcd8eb4` 同步运行语义文档。
9. `c99317c`：**交付进展 / 协作进展双计数**——保留严格交付指纹，同时新增绑定当前任务 revision 的协作指纹；task checkpoint、process issue、resolution/review 与 peer action review 可为每次 task 调度提供至多一次协作续跑，但不修改 revision、交付状态、测试、提交或最终评审证据，且 `teamTaskMaxEpochs` 始终是硬上限。L1：核心测试 97/97、扩展测试 52/52、浏览器 smoke 通过；提交已推送至 `origin/main`。L1：相关四个改动文件的独立 Biome 检查通过。L3：仓库全量 `npm run check` 仍受既有 shrinkwrap/install-lock 漂移与两处原有测试空值类型错误影响，因此不能宣称全仓静态检查全绿。

### 7.3 边界与设计观察（诚实声明）

- L1：持久化团队 `start` 流程（investigation + 交叉质询）已在 r12 **完整跑通**；三角色并行任务迁移在 r13-r18 **持续产生真实治理动态**。r13 的 peer 以行级证据抓出两个测试缺陷，缺陷修复后 43 个探针测试通过；r14-r18 继续验证了有限重试、模型轮换、机械修复回合、配额失败、过程解决和 epoch 停止，但没有任务提交。
- L1：双计数并未放宽提交、测试、协作更新、最终评审或 epoch 硬上限，仅使有 revision 绑定的真实协作证据获得一次有界续跑机会。r20 表明该机制下完整任务链可达。L3：当前只有一个成功样本，尚不能量化成功率或证明多任务、长任务和多轮运行能稳定收敛。
- 恢复语义：`start` 对已存在团队只恢复会话不重跑轮次；续跑用 `ask`，且 `ask` 只在账本存在未决义务时产出新事件（r4 后 openChallenges=0 时空跑属正常）。

### 7.4 r18 冻结诊断与正式关闭（2026-08-01）

1. r18 最终公共账本为 233 个事件。三项 role-failure 分别是：QA 阶段超过 600000ms；TL 的 `TASK-LEASE-CONTRACT` 在两个并行 epoch 后 `owner-no-progress`；Staff 的 `ansteel_publish_checkpoint` 连续 3 次工具输入错误达到重试上限。
2. 三个 blocking process issue 中，两个保持 open；`PI-LEASE-QA-CONTROL-CHARS` 已由 QA 提出 `REFUTED` resolution，但尚无同伴复核，状态保持 `resolution-proposed`。这不能算问题已关闭。
3. `/ansteel-team trace RUN-c0e3e032-a57b-4f01-afb8-877e036c9d04` 成功重放该主运行的 1197 条结构化日志。
4. `/ansteel-team doctor RUN-c0e3e032-a57b-4f01-afb8-877e036c9d04` 通过公共事件链、状态投影和运行索引前置完整性检查后，按设计返回 unhealthy：根因为 `task.submit` 序号 214 的 `unclassified-runtime-error`，并检测到 3 个缺少合法终态的 span（`process-orphaned`）。这是可诊断的失败运行，不是健康交付或证据损坏。
5. 通过受支持的 `/ansteel-team stop` 关闭遗留团队，未手工修改 `team.json`。关闭后的 `status --explain` 明确给出：team=`stopped`、collaboration=`blocked`、governance=`rejected`、delivery=`not-started`、workflow=`blocked`；三角色均为 idle。关闭操作对应的最新诊断运行健康（3 条日志）。

### 7.5 r19 夹具隔离与 r20 首次任务级闭环（2026-08-01）

1. L1：r19 的失败源于探针自身夹具泄漏。驱动放在项目 `.pi/` 后被 QA 当作可读证据，暴露了尚未由协调器分配的任务 ID；QA 连续三次以该 ID 发布 checkpoint，触发 `ansteel_publish_checkpoint exceeded the stage retry limit`。该轮 tasks=0、源码无 diff，不能支持“双计数失败”的结论。
2. L1：r19 已通过受支持的 RPC `stop` 关闭，team=`stopped`，三角色均 idle；未手工修改状态文件。
3. L1：r20 将驱动移到被审项目之外，基线提交为 `431e36b`。三角色仍为 TL=`micuapi/gpt-5.5`、Staff=`deepseek-flash/deepseek-v4-flash`、QA=`volcengine-coding/kimi-k2.7-code`，start、task、stop 三个 RPC 均成功。
4. L1：r20 公共账本共 121 个事件：81 个 `action-assessed`、4 个 `action-review`、17 个 `role-report`、1 个 `task-assigned`、12 个 `work-checkpoint`、1 个 `task-submitted`、2 个 `task-collaboration`、1 个 `task-final-verification-requested`、2 个 `task-review`，role-failure=0。关键序列为 57（分配）、62/78（任务 checkpoint）、72/74 与 91/93（两组 action review）、98（提交）、108/109（双协作）、112（最终验证请求）、117/119（TL/QA APPROVE）。
5. L1：`TASK-MINIMAL-DELIVERY` 终态为 `approved`、revision=1、testEvidence=2、submissions=1、collaborationUpdates=2、reviews=2；两名 reviewer 分别为 tech-lead 与 qa-engineer，verdict 均为 approve。唯一源码差异为 `deliveryMarker` 从 `"NOT_IMPLEMENTED"` 改为 `"implemented"`，独立复跑 `node --test test/delivery.test.mjs` 为 1/1 通过。
6. L1：r20 证明“任务提交 → 双协作更新 → 最终独立验证请求 → 双审批”的任务级持久化链路真实可达。L3：单次、单文件、单任务成功不足以证明真实模型下的稳定收敛，也不等同于系统三轴中的独立 delivery-verification 已完成。

## 八、最终收口决策

### 8.1 已接受的证据

- `--ansteel`：真实跨模型评审在 r7 完成双会签并形成 APPROVED 共识。
- `/ansteel-team start`：r12 完成 investigation 与交叉质询两轮，三角色零失败退出。
- `/ansteel-team task`：r13-r18 验证并行任务认领、精确文件所有权、checkpoint、peer 动作评审、过程问题与解决、有限重试、机械修复回合、provider 配额失败和 epoch 失败关闭。
- L1：`/ansteel-team task` 的 r20 首次形成可信 submission、双协作更新、最终验证请求与 TL/QA 双审批，任务 revision 1 达到 `approved`；唯一受控源文件差异经独立测试复跑 1/1 通过。
- L1：确定性门禁方面，2b 定向回归为 159/159；双计数定向回归为核心 97/97、扩展 52/52，浏览器 smoke 通过；`c99317c` 已推送至 `origin/main`。L3：全仓 `npm run check` 的既有锁文件与测试类型漂移仍需另案处理。

### 8.2 未接受的证据与最终边界

- r20 已补齐任务级 submission、双协作更新、最终验证请求和双审批证据；因此原结论“持久化任务交付闭环未验证”不再成立。L1：可接受的新结论是“单任务持久化交付闭环已验证可达”。
- 配额恢复后的 r18 仍复现 `owner-no-progress`、阶段超时与工具重试上限，说明阻塞不能只归因于 r17 的临时配额耗尽。
- L1：r20 的任务批准不构成独立 delivery-verification，系统状态明确保持 delivery=`not-started`；不得写成 `deliveryStatus: passed`。
- L3：当前只有一次单任务成功，不能据此证明真实模型下的稳定收敛、成功率、多任务并发可靠性或长任务耐久性。若要回答稳定性问题，下一阶段应使用固定夹具进行多轮重复探针并预先定义成功率与失败分类，而不是继续无指标重跑。
- 本目标按“治理机制已验证、双计数实现已回归、持久化单任务闭环首次真实可达，但稳定性未证明”收口。任何后续变更都必须继续保留交付证据边界、epoch 硬上限和治理违规的失败关闭。

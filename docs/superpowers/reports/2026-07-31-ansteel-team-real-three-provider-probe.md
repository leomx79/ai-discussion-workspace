# 鞍钢真实三提供商探针运行报告（耐久租约队列）

> 日期：2026-07-31 至 2026-08-01（`--ansteel` r1-r7；`/ansteel-team` r2-r18）
> 对应方案：《鞍钢宪法式三 AI 持续协作协议设计》第 20.4 节真实提供商探针
> 探针项目（gitignored 运行区）：`artifacts/runtime/ansteel-e2e-real-three-provider/`
> 最终结论：真实治理机制已验证；持久化任务交付闭环未触达，按失败关闭边界收口

## 一、三角色 provider/model 映射（L1：真实端点探测与运行连通）

| 角色 | provider/model | 端点 | 运行证据 |
|---|---|---|---|
| tech-lead | `volcengine-agent-plan/glm-5.2` | https://ark.cn-beijing.volces.com/api/plan/v3 | r1-r7 TL 阶段全部真实完成 |
| staff-engineer | `deepseek-flash/deepseek-v4-flash`（r1-r6）/ `deepseek-v4-pro`（r7） | https://api.deepseek.com/v1 | r2-r7 全部真实完成（修复 401 与空输出后） |
| qa-engineer | `volcengine-coding/doubao-seed-2.1-turbo` | https://ark.cn-beijing.volces.com/api/coding/v3 | r2-r7 全部真实完成，含 L1 证据否决与会签 |

持久化任务阶段随后轮换了六个显式模型身份：GLM-5.2、DeepSeek v4-pro、DeepSeek v4-flash、Doubao Seed 2.1 Turbo、Kimi K2.7 Code、GPT-5.5。r17-r18 的最终组合为 TL=`micuapi/gpt-5.5`、Staff=`deepseek-flash/deepseek-v4-flash`、QA=`volcengine-coding/kimi-k2.7-code`。这些配置与真实调用记录能证明每轮使用的显式身份和端点响应，不能证明供应商内部没有路由到共享后端。

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

- `pi --ansteel` 非交互证据优先评审路径已在 r7 得到 APPROVED 与双会签；`/ansteel-team start` 已在 r12 完整跑通，r13-r18 也真实进入三角色并行任务、检查点、动作评审、过程问题、有限重试和修复回合。两条路径证明不同能力，不能互相替代。
- 治理结果：r7 `APPROVED`（双会签）；交付结果：`NOT_DELIVERED`（评审不实现任务）。APPROVED 表示规定角色完成规定检查并达成共识，不表示代码已正确交付。
- 跨模型 L1 证据已升级：三个真实 provider/model 在评审管线中完成完整持续协作循环并获得 APPROVED 共识与会签（r7）。
- 持久化任务路径的最远证据是任务认领、真实编辑意图、peer 动作评审、过程问题与修复、测试命令尝试和失败关闭；r13-r18 均未形成任务 submission，因此没有进入“两个协作更新 → 最终独立验证 → 双会签”的交付链。其 `deliveryStatus` 必须保持 `not-started`。


## 七、持久化团队 /ansteel-team 真实三提供商验证（RPC 无头驱动 r2-r18）

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

r14-r17 的明细来自本地 Codex 任务 `019fb556-a152-70d0-ba4f-b1d9b30c3f16` 的运行转录；后续轮次会重建同一个 gitignored 探针目录，因此当前文件系统只保留 r18 的完整运行态，不能把 r14-r17 写成可由 GitHub checkout 单独重放的产物。r18 保留签名账本（Ed25519 manifest + 事件链）、team.json、运行日志、角色会话和内容寻址错误产物；无证据表明角色访问了 Oracle 或协调器私有状态。

### 7.2 已修复的真实根因（均有确定性回归 + 治理门禁）

1. `34aab2d`：角色提示词约束不得引用未分配任务 ID（r2 根因）
2. `e7921df`：结构化 ID 格式（CP/PI/PR/TASK-<UPPERCASE-ID>）写入提示词与工具说明（r3 根因）
3. `78371b7`：investigation 阶段不得用 bash 跑测试（r3 根因）
4. `e33cc73`：checkpoint 工具说明显式列出全部必填字段（r7 根因；r8 表明 deepseek-v4-pro 在交叉质询仍可能漏 risk/confidence）
5. `3645bd4`：**治理工具入参错误阶段内可重试（核心语义修复）**——agent-loop 本就返回工具错误给模型，扩展层 fail-closed 检查改为"最后一次仍失败或累计超 3 次才判死"；新增 3 个回归用例；docs/ansteel.md 记录语义
6. `64393f4`：提示词要求治理工具报错必须修正重试，不得带错收尾
7. `b54242c`：未分配任务前禁止调用任务/里程碑工具
8. `6e57592`：**机械修复回合 + 协调器风险推导（2b）**——模型在阶段最后一次治理工具错误后不能直接带错收尾；协调器强制一次定向修复回合，未调用治理工具或再次失败仍按原始工具名失败关闭。checkpoint `risk` 改由协调器按动作机械推导并取不低于模型声明的风险，`confidence` 仍由模型必填。核心、CLI/RPC 与扩展定向回归为 159/159；`dcd8eb4` 同步运行语义文档。

### 7.3 边界与设计观察（诚实声明）

- 持久化团队 `start` 流程（investigation + 交叉质询）已在 r12 **完整跑通**；三角色并行任务迁移在 r13-r18 **持续产生真实治理动态**。r13 的 peer 以行级证据抓出两个测试缺陷，缺陷修复后 43 个探针测试通过；r14-r18 继续验证了有限重试、模型轮换、机械修复回合、配额失败、过程解决和 epoch 停止，但仍没有任务提交。
- 工具入参 schema 错误已经从“一次错误立即杀死阶段”修订为“阶段内有限重试”，并在 2b 中增加一次机械修复回合；治理越权和修复失败仍保持 fail-closed。r14-r18 表明该机制改善了可诊断性和协作深度，但不足以稳定产生交付提交。
- 恢复语义：`start` 对已存在团队只恢复会话不重跑轮次；续跑用 `ask`，且 `ask` 只在账本存在未决义务时产出新事件（r4 后 openChallenges=0 时空跑属正常）。

### 7.4 r18 冻结诊断与正式关闭（2026-08-01）

1. r18 最终公共账本为 233 个事件。三项 role-failure 分别是：QA 阶段超过 600000ms；TL 的 `TASK-LEASE-CONTRACT` 在两个并行 epoch 后 `owner-no-progress`；Staff 的 `ansteel_publish_checkpoint` 连续 3 次工具输入错误达到重试上限。
2. 三个 blocking process issue 中，两个保持 open；`PI-LEASE-QA-CONTROL-CHARS` 已由 QA 提出 `REFUTED` resolution，但尚无同伴复核，状态保持 `resolution-proposed`。这不能算问题已关闭。
3. `/ansteel-team trace RUN-c0e3e032-a57b-4f01-afb8-877e036c9d04` 成功重放该主运行的 1197 条结构化日志。
4. `/ansteel-team doctor RUN-c0e3e032-a57b-4f01-afb8-877e036c9d04` 通过公共事件链、状态投影和运行索引前置完整性检查后，按设计返回 unhealthy：根因为 `task.submit` 序号 214 的 `unclassified-runtime-error`，并检测到 3 个缺少合法终态的 span（`process-orphaned`）。这是可诊断的失败运行，不是健康交付或证据损坏。
5. 通过受支持的 `/ansteel-team stop` 关闭遗留团队，未手工修改 `team.json`。关闭后的 `status --explain` 明确给出：team=`stopped`、collaboration=`blocked`、governance=`rejected`、delivery=`not-started`、workflow=`blocked`；三角色均为 idle。关闭操作对应的最新诊断运行健康（3 条日志）。

## 八、最终收口决策

### 8.1 已接受的证据

- `--ansteel`：真实跨模型评审在 r7 完成双会签并形成 APPROVED 共识。
- `/ansteel-team start`：r12 完成 investigation 与交叉质询两轮，三角色零失败退出。
- `/ansteel-team task`：r13-r18 验证并行任务认领、精确文件所有权、checkpoint、peer 动作评审、过程问题与解决、有限重试、机械修复回合、provider 配额失败和 epoch 失败关闭。
- 确定性门禁：2b 提交的定向回归为 159/159；当前 `dcd8eb4` 的 GitHub Actions `Ansteel governance gate` 运行 `30681263222` 为 success。本次收口前在本机复跑同一六文件治理回归为 336/336，构建、类型检查与 `git diff --check` 均通过。

### 8.2 未接受的证据与最终边界

- 没有任何持久化任务轮次形成可信 submission，因此没有证据支持双协作更新、最终独立验证、双会签或 `deliveryStatus: passed`。
- 配额恢复后的 r18 仍复现 `owner-no-progress`、阶段超时与工具重试上限，说明阻塞不能只归因于 r17 的临时配额耗尽。
- 不继续在相同协议和相同任务上无变化重跑。无新假设的成功样本只能证明单次可达，不能证明真实模型下的稳定收敛。
- 本目标按“治理机制已验证、持久化任务交付闭环未验证”收口。后续若继续研发，应单独设计有硬上限的“协作进展/交付进展”双计数实验，而不是直接放宽阶段超时或无进展阈值；任何变更都必须继续保留交付证据和治理违规的失败关闭。

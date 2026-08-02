# 鞍钢真实三提供商探针运行报告（耐久租约队列）

> 日期：2026-07-31 至 2026-08-02（`--ansteel` r1-r7；`/ansteel-team` r2-r34）
> 对应方案：《鞍钢宪法式三 AI 持续协作协议设计》第 20.4 节真实提供商探针
> 探针项目（gitignored 运行区）：`artifacts/runtime/ansteel-e2e-real-three-provider/`、`artifacts/runtime/ansteel-team-stability-r21/` 至 `r30/`、`artifacts/runtime/ansteel-team-recovery-r31/` 至 `r34/`
> 最终结论：L1，真实治理机制、冻结单任务重复稳定性和双任务失败交付恢复均已验证；r28-r30 同一源码基线 3/3 完整成功，r34 首次完成前置任务 revision 1 失败、revision 2 恢复、下游解锁与双任务可信交付。该证据不外推为长任务、任意模型组合或生产成功率

## 一、三角色 provider/model 映射（L1：真实端点探测与运行连通）

| 角色 | provider/model | 端点 | 运行证据 |
|---|---|---|---|
| tech-lead | `volcengine-agent-plan/glm-5.2` | https://ark.cn-beijing.volces.com/api/plan/v3 | r1-r7 TL 阶段全部真实完成 |
| staff-engineer | `deepseek-flash/deepseek-v4-flash`（r1-r6）/ `deepseek-v4-pro`（r7） | https://api.deepseek.com/v1 | r2-r7 全部真实完成（修复 401 与空输出后） |
| qa-engineer | `volcengine-coding/doubao-seed-2.1-turbo` | https://ark.cn-beijing.volces.com/api/coding/v3 | r2-r7 全部真实完成，含 L1 证据否决与会签 |

持久化任务阶段随后轮换了六个显式模型身份：GLM-5.2、DeepSeek v4-pro、DeepSeek v4-flash、Doubao Seed 2.1 Turbo、Kimi K2.7 Code、GPT-5.5。r17-r34 的最终组合为 TL=`micuapi/gpt-5.5`、Staff=`deepseek-flash/deepseek-v4-flash`、QA=`volcengine-coding/kimi-k2.7-code`。L1：配置、真实调用记录与 r20-r34 状态快照能证明每轮使用的显式身份和端点响应。L3：这些外部证据不能证明供应商内部没有路由到共享后端。

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

- L1：`pi --ansteel` 非交互证据优先评审路径已在 r7 得到 APPROVED 与双会签；`/ansteel-team start` 已在 r12 完整跑通，r13-r18 真实进入三角色并行任务、检查点、动作评审、过程问题、有限重试和修复回合，r20 首次完成任务提交至双最终审批，r23/r26 首次两次完成可信 delivery，r27 首次达到四轴完整终态，r28-r30 在冻结源码基线上 3/3 重复该终态，r34 首次完成双任务失败交付恢复。两条路径证明不同能力，不能互相替代。
- L1：治理评审结果为 r7 `APPROVED`（双会签）；r20 的 `TASK-MINIMAL-DELIVERY` 为 `approved`（任务级双审批）。APPROVED 只表示对应门禁已通过，不能越级解释为系统级 delivery 验证已经完成。
- 跨模型 L1 证据已升级：三个真实 provider/model 在评审管线中完成完整持续协作循环并获得 APPROVED 共识与会签（r7）。
- L1：r13-r18 均未形成任务 submission；双计数修复后的 r20 已形成 revision 1 submission、两个协作更新、最终独立验证请求和 TL/QA 两个 `approve`，任务状态为 `approved`。r20 的批准仍不能追认为 delivery；v11 的 r23、r26、r27-r30、r34 分别执行项目外 manifest 和独立检查后才产生 `task-delivery-passed`。r34 还保留了 predecessor revision 1 的 `task-delivery-failed/check-failed`，只有 revision 2 passed 后才解锁 dependent。


## 七、持久化团队 /ansteel-team 真实三提供商验证（RPC 无头驱动 r2-r34）

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
| r21 | start 失败（严格工具输入门禁） | QA 的 checkpoint 连续 4 次输入错误达到阶段上限；无任务、无源码 diff、1 个 role-failure，正确失败关闭。 |
| r22 | 任务未交付 | start/task/stop 成功，但任务保持 claimed revision 0；无 submission、delivery 或源码 diff，1 个 role-failure。 |
| **r23** | **真实 delivery 首次 passed；投影未完成** | 任务 approved revision 1；2 个协作更新、2 个最终批准、2 项 coordinator delivery 检查、公开与隐藏测试均通过，零 role-failure。旧 revision/taskless 黄色 checkpoint 仍令 governance pending，因而 full workflow 未通过。 |
| r24 | 提交与双协作完成，最终评审未触发 | 任务 submitted revision 1，submission=1、collaboration=2、reviews=0、零 role-failure；没有进入 delivery。 |
| r25 | 任务未交付（epoch 上限） | 221 个事件；真实动作评审持续发生，但 owner 在 8 个 epoch 内未执行已批准绑定，最终 `task-epoch-limit`，源码无 diff。 |
| **r26** | **真实 delivery 再次 passed；确认 taskless 投影缺口** | 任务 approved、delivery 两项检查通过、公开/隐藏测试通过、唯一源码 diff、零 role-failure；`status --explain` 仅因两个 taskless 非绿色 checkpoint 保持 governance pending。 |
| **r27** | **成功：首个四轴完整真实终态** | 106 个签名公共事件；start/task/verify/status/stop 全成功，任务 approved revision 1、submission=1、collaboration=2、reviews=2；两项 delivery 检查通过，唯一 diff 为 `src/delivery.mjs`，公开/隐藏测试均通过，role-failure=0；stop 前状态为 collaboration-complete、governance approved、delivery passed、workflow completed。 |
| **r28** | **成功：冻结基线重复 1/3** | 99 个事件，628.9s；源码基线 hash 前后一致；完整工作流通过，role-failure=0。 |
| **r29** | **成功：冻结基线重复 2/3** | 112 个事件，540.0s；同一 HEAD、同一 11 文件 diff hash；完整工作流通过，role-failure=0。 |
| **r30** | **成功：冻结基线重复 3/3** | 110 个事件，763.5s；同一冻结源码基线；完整工作流通过，role-failure=0。三次均值 644.1s，范围 540.0-763.5s。 |
| r31 | 任务创建拒绝（重复 owner） | start 成功；两个并行任务都分配给 Staff，机械门禁以 `parallel task batch requires distinct task owners` 拒绝，tasks=0、role-failure=0。驱动错误，不是模型或生产交付失败。 |
| r32 | 任务创建拒绝（同批依赖） | start 成功；原子并行批次包含尚未批准的前置依赖，机械门禁以 `requires every dependency to be approved` 拒绝，tasks=0、role-failure=0。驱动改为顺序建账。 |
| r33 | 失败（活动状态未同步） | 前置 revision 1 完成 submission/双协作/双审批；下游保持 blocked；强制 delivery `check-failed` 后持久化状态正确进入 `revision-required`，但活动内存仍为 approved，续跑误报 `already approved`。暴露 `/verify` 失败路径状态分叉。 |
| **r34** | **成功：双任务失败交付恢复完整终态** | 255 个签名事件，1212.4s，role-failure=0。前置 revision 1 的失败回执保留；revision 2 重新提交、4 个累计协作更新、4 个累计评审并通过 2 项 delivery 检查；下游只在此前置通过后解锁，revision 1 通过 2 项检查。两个源码 diff、4 项公开/隐藏测试全绿，四轴完整完成，源码基线前后一致。 |

r14-r17 的明细来自本地 Codex 任务 `019fb556-a152-70d0-ba4f-b1d9b30c3f16` 的运行转录；后续轮次会重建同一个 gitignored 探针目录，因此不能把 r14-r17 写成可由 GitHub checkout 单独重放的产物。L1：当前文件系统保留 r18-r34 的签名账本、team.json、运行日志与角色会话；r20-r34 另有外置驱动、RPC 转录和汇总 JSON，成功 delivery 轮次还保留项目外 manifest 与隐藏测试。L3：没有证据表明角色访问了 Oracle 或协调器私有状态，但该否定结论受现有审计面限制。

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
10. `05ca4c8`：**可信独立 delivery verification**——状态 v11、项目外严格 manifest、环境白名单、内容寻址输出、任务 diff/整仓 workspace/Git HEAD/manifest 哈希绑定及四类签名 delivery 事件；GitHub Actions `30697009634` 成功。遗漏的 `json-canonicalize@2.0.0` shrinkwrap/install-lock 条目已由仓库生成器补齐并通过各自 `--check`。
11. 当前工作树：**真实稳定性探针调度与 17.3 可观测性整改**——明确 green `report`、可修复的 literal-union 错误提示、完整动作批准单调计数、process-resolution 作者复核优先调度、旧 revision/taskless checkpoint 投影隔离，以及 owner prompt 中已批准绑定回显；补齐持久团队恢复 trace 连续性和根运行环境指纹。validation 4/4、核心 109/109、可观测性 28/28、扩展 55/55、CLI/RPC 14/14、根 TypeScript、browser smoke、shrinkwrap 与 install-lock 检查均通过；r27-r30 为同一版本真实终态证据。当前尚未提交，不把它写成远端已验收提交。
12. 当前工作树：**历史 delivery 回执重放边界**——r34 前的综合确定性回归先复现 `state-projection-mismatch: delivery verification ... no longer matches its task revision`。修复后，回执必须引用不高于当前 revision 且确有 submission 的修订；历史终态回执保留审计但不再回滚当前任务或依赖，未来 revision 和无 submission 回执继续失败关闭。核心综合用例同时覆盖前置失败、revision 2、下游解锁、里程碑和磁盘重载。
13. 当前工作树：**失败 `/verify` 的活动状态同步**——r33 证明持久化状态已为 `revision-required`，但活动状态仍为 approved。扩展在成功和异常两条路径都从磁盘刷新活动快照；确定性扩展回归证明同一会话可从 revision 1 `check-failed` 继续到 revision 2 approved，r34 再以真实 RPC 完成该恢复。
14. 当前工作树：**第 17.5 节 37 个运行事件产品接线与 incident schema v2 收口**——真实 AgentSession `auto_retry_start`、provider `stopReason: length`、工具绑定受控进程 heartbeat 和损坏链 incident 分别产生 `provider.request.retry`、`role.session.truncated`、`tool.call.progress` 与 `event.chain.invalid`。损坏链诊断写入独立哈希链/fsync 段，不重建或替换受信索引；正常 writer 仍失败关闭。incident v2 机械聚合任务/revision、审计区间、span 树、脱敏配置摘要、完整性、工作区、最后合法检查点和恢复入口。五文件串行回归 243/243，其中可观测性 52/52、核心与进程 runner 118/118、扩展 55/55、CLI/RPC 18/18。该结论只收口事件写路径和事故包基础，不等于日志轮转、每事件 data schema、任务/文件租约或其他预算类型已经完成。

### 7.3 边界与设计观察（诚实声明）

- L1：持久化团队 `start` 流程（investigation + 交叉质询）已在 r12 **完整跑通**；三角色并行任务迁移在 r13-r18 **持续产生真实治理动态**。r13 的 peer 以行级证据抓出两个测试缺陷，缺陷修复后 43 个探针测试通过；r14-r18 继续验证了有限重试、模型轮换、机械修复回合、配额失败、过程解决和 epoch 停止，但没有任务提交。
- L1：双计数及后续动作批准计数均未放宽提交、测试、协作更新、最终评审或 epoch 硬上限；只允许不可重复的 revision 绑定事实重置 no-progress。r20 证明任务链可达，r23/r26/r27-r30 证明真实 delivery 可达，r27 首次证明四轴完整终态可达；冻结源码后的 r28-r30 为同一版本 3/3 重复。r34 首次证明双任务依赖在失败 delivery 后可由新 revision 恢复。L3：样本仍小，不能外推为生产成功率；长任务与任意模型组合仍未证明。
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

### 7.6 r21-r30 固定夹具稳定性与 v11 delivery 收口（2026-08-01 至 2026-08-02）

1. L1：r21-r27 每轮都创建全新 Git 仓库，驱动、manifest 和隐藏测试保留在被审项目之外；基线公开测试必须先失败。预定义 task-delivery 与 full-workflow 两级验收，避免看到结果后改口径。
2. L1：r23、r26、r27 三轮 task-delivery 验收通过：任务当前 revision 为 approved，两项 manifest 检查与公开/隐藏测试全绿，签名账本各有 1 个 `task-delivery-started`、2 个 `task-delivery-check`、1 个 `task-delivery-passed`，无 `task-delivery-failed` 和 role-failure，且只有 `src/delivery.mjs` 一处源码 diff。
3. L1：r23 暴露旧 revision checkpoint 污染当前治理；r26 在修复旧 revision 后又把问题收敛到 taskless 非绿色 checkpoint。两轮 delivery 均为 passed，但 full workflow 均正确保持未完成，没有把局部成功伪装成系统成功。
4. L1：当前修复把 taskless checkpoint 明确限制为任务建立后的公共上下文，仍保留“尚无 revisioned work 时真实未绑定决策会令治理 pending”。动作批准计数使用当前 revision 内曾获完整双批准的唯一绑定集合，checkpoint 改名、替换或批准撤销不能制造推进。
5. L1：r27 在 106 个签名事件内直接达到首个完整终态。任务 `TASK-STABILITY-DELIVERY` 为 approved revision 1，submission=1、collaborationUpdates=2、reviews=2；delivery receipt `DV-D25EB5EE-8110-4487-9E8A-823CD959DB3A` 的 public/oracle 两项检查均通过。`status --explain` 在 stop 前返回 collaboration=`collaboration-complete`、governance=`approved`、delivery=`passed`、workflow=`completed`。
6. L1：r28-r30 在 r27 冻结源基线上重复运行。三轮的 HEAD 均为 `05ca4c803f5b0d5932a84129b74d8741ee279c16`，原始 `git diff --binary --no-ext-diff` SHA-256 均为 `ec7d83244809a87bab7b8e66653c512b1ae54952bb136b799987d680abe55cd9`，11 个改动文件逐项 hash 前后一致；三轮 full workflow 3/3 通过，耗时均值 644.1s、范围 540.0-763.5s，role-failure 均为 0。
7. L3：r21-r27 仍是逐轮定位与修复证据，不能混入 r28-r30 的同版本重复统计。3/3 只说明这个固定单任务夹具在三次样本中稳定，不是生产成功率，也不覆盖长任务和任意模型组合。

### 7.7 r31-r34 双任务失败交付恢复（2026-08-02）

1. L1：确定性核心综合回归先构造 predecessor 与 dependent，证明治理批准不解锁依赖、revision 1 `check-failed` 进入 `revision-required`、revision 2 passed 后才解锁、旧失败回执持久保留且不能满足当前修订；随后完成 dependent 与双任务 milestone，磁盘重载和共享工作板投影一致。该测试使核心文件达到 109/109。
2. L1：r31/r32 分别验证两项任务创建门禁：并行批次 owner 必须不同；同一原子并行批次不能含尚未批准的依赖。两轮均 start 成功、tasks=0、role-failure=0，属于驱动输入被正确拒绝。
3. L1：r33 顺序建账后，predecessor revision 1 完成 submission、双协作与双审批，dependent 保持 blocked；强制检查以 `check-failed` 失败并持久化 `revision-required`。随后 `/task TASK-RECOVERY-PREDECESSOR` 因活动内存未同步而误报 `already approved`，定位到 `/verify` 只在成功路径执行 `Object.assign(active.state, persisted)`。
4. L1：修复使用 `finally` 在 delivery 成功或失败后都重载持久化状态；扩展确定性回归从 revision 1 失败恢复至 revision 2 approved，扩展文件 55/55 通过。
5. L1：r34 用同一三模型组合完成 255 个签名事件，耗时 1212.4s，零 role-failure。predecessor 终态 approved revision 2（2 submissions、4 collaboration updates、4 reviews），delivery 回执同时保留 revision 1 failed/check-failed 与 revision 2 passed/2 checks；dependent 在此前保持 blocked，随后 approved revision 1 并通过 2 checks。
6. L1：r34 的 `task-delivery-started/check/passed/failed` 分别为 3/5/2/1；唯一源码差异为 `src/predecessor.mjs` 与 `src/dependent.mjs`，两项公开测试和两项项目外 Oracle 均通过，源码基线前后一致；stop 前 `status --explain` 返回 collaboration-complete、governance approved、delivery passed、workflow completed。
7. L3：r34 是一次顺序依赖恢复成功，不等同于三个 owner 同时编辑的并行成功率，也不覆盖数小时长任务、进程崩溃恢复或其他模型组合。

## 八、最终收口决策

### 8.1 已接受的证据

- `--ansteel`：真实跨模型评审在 r7 完成双会签并形成 APPROVED 共识。
- `/ansteel-team start`：r12 完成 investigation 与交叉质询两轮，三角色零失败退出。
- `/ansteel-team task`：r13-r18 验证并行任务认领、精确文件所有权、checkpoint、peer 动作评审、过程问题与解决、有限重试、机械修复回合、provider 配额失败和 epoch 失败关闭。
- L1：`/ansteel-team task` 的 r20 首次形成可信 submission、双协作更新、最终验证请求与 TL/QA 双审批，任务 revision 1 达到 `approved`；唯一受控源文件差异经独立测试复跑 1/1 通过。
- L1：v11 远端 Actions：`05ca4c8` 对应 `Ansteel governance gate` 运行 `30697009634` 成功；r23、r26、r27 的真实 coordinator manifest 均产生 passed delivery receipt。
- L1：r27 首次完成真实四轴终态；106 个签名事件、零 role-failure、唯一受控源码 diff、公开/隐藏测试与两项 delivery 检查均通过。
- L1：r28-r30 在冻结 HEAD 和原始 diff hash 上 3/3 重复完整终态；不是把逐轮修复样本混算为稳定性。
- L1：r34 完成真实双任务失败交付恢复，历史失败回执、新 revision、依赖解锁、下游可信交付和最终四轴状态均由签名事件与持久化状态支持。
- L1：当前工作树最新五文件串行回归为 243/243：可观测性 52/52、核心与进程 runner 118/118、扩展 55/55、CLI/RPC 18/18；加 validation 4/4 后共 247/247，定向 Biome、根 TypeScript、pinned dependency、shrinkwrap、install-lock、browser smoke、coding-agent build 和 `git diff --check` 全部通过。仓库格式化命令会改写与本增量无关的既有文件，因此收口使用无写入的定向 Biome 检查，不把格式噪声混入本次改动。

### 8.2 未接受的证据与最终边界

- r20 已补齐任务级 submission、双协作更新、最终验证请求和双审批；r27 又补齐独立 delivery 与四轴完成证据。因此原结论“持久化任务交付闭环未验证”不再成立。L1：可接受的新结论是“单任务固定夹具的完整持续协作与可信交付终态已真实验证可达”。
- 配额恢复后的 r18 仍复现 `owner-no-progress`、阶段超时与工具重试上限，说明阻塞不能只归因于 r17 的临时配额耗尽。
- L1：r20 的任务批准仍不能追认为 delivery；只有 r23/r26/r27 的项目外 manifest 和签名 delivery receipt 可以支持 `deliveryStatus: passed`。该边界继续保留。
- L3：r28-r30 的 3/3 是固定单任务小样本，r34 是一次双任务顺序依赖恢复；两者都不能证明任意多任务并发可靠性、数小时长任务耐久性或任意模型组合成功率。
- 本阶段按“协议十步迁移已实现；单任务四轴在冻结版本上 3/3 重复；双任务失败 delivery 后新 revision 恢复与依赖解锁真实可达；长任务、崩溃恢复和更广模型组合仍待验收”收口。任何后续变更都必须继续保留独立交付证据、epoch 硬上限和治理违规的失败关闭。

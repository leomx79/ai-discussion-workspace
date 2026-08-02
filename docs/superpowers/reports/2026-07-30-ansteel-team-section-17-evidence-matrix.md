# Ansteel Team 第 17 节日志与全链路可观测性证据矩阵

> 审计基线：`main@05ca4c803f5b0d5932a84129b74d8741ee279c16` 加当前未提交治理、delivery 恢复与 17.3 可观测性整改。
>
> 本矩阵只描述当前仓库中可机械复现的事实。`部分实现` 和 `缺失` 均不得写成协议完成。

## 一、逐项状态

| 协议条目 | 当前状态 | 已有直接证据 | 不足或反证 | 完成所需证据 |
|---|---|---|---|---|
| 17.1 四类持久记录 | 部分实现 | `events.jsonl`、运行 JSONL、内容寻址 artifact、incident manifest 已有实现和测试。 | 运行日志没有自动轮转与保留；没有状态快照；账本角色签名尚未实现；incident 对账本区间的关联不完整。 | 四类目录均有确定性生成、校验、引用保护、清理和恢复测试；签名与快照能够从磁盘独立验证。 |
| 17.2 可观测性数据流 | 部分实现 | 扩展命令根 span、角色/provider span、任务工具与受控子进程、run writer lease、内容寻址 artifact、Budget、Security、状态持久化和事件追加共享 trace。真实 RPC 任务测试验证 `lease.acquired -> tool.call -> process.spawned -> process.heartbeat + tool.call.progress -> process.exited -> lease.released` 同 run 事实链，并在 Staff 的同一角色 span 验证 `budget.reserved -> budget.consumed × 4 -> budget.exhausted`；AgentSession 权威 retry 与 provider 长度截断分别产生 retry/truncated；失败 RPC 与 doctor 又验证 artifact 生命周期，无日志 run 验证 missing；角色越权读取验证 access-denied；损坏链 incident 在独立诊断 run 写 chain-invalid 且不改受信索引。 | 尚未覆盖任务/文件租约以及项目总量、token、时间和磁盘预算因果链；provider token、首 token 与 HTTP 状态仍缺底层权威回调。 | CLI/RPC 故障注入证明用户命令到最终状态的所有父子 span、Budget/Security 事实和 artifact 可由同一 trace 查询。 |
| 17.3 统一关联标识 | 已实现基础，真实跨进程探针通过 | 日志 schema、索引和查询覆盖 run、trace、角色、任务、检查点、问题、工具、provider、进程、租约、revision、diff 和 cause ID。持久团队重启和显式 `/task TASK-ID` 恢复均生成新 `runId` 并记录 `resumedFromRunId/resumedFromSequence`。真实 RPC 探针在 TL provider 请求中强制终止第一个宿主；第二个宿主发现 1 个孤儿运行，先以原 `leaseId` 写 `lease.expired`，再以新 `leaseId` 获取恢复写权，把根、角色和 provider 共 3 个开放 span 归档为目录定义的 `run.failed`、`role.session.ended`、`provider.request.completed` 与 `abandoned/process-orphaned`，成功释放恢复 lease；该恢复命令失败关闭，下一次显式 `start` 和后续 `ask` 沿原 `traceId` 成功恢复同一团队。artifact 生命周期事件通过 `causeEventId` 或 source run/sequence 绑定；Security 事件以源事件 hash 作为 `causeEventId`；Budget 与工具进展保留角色 `parentSpanId`、`toolCallId` 和 `processId`，不保存工具参数。环境变量仅记录启用名称，测试密钥值、Bearer 与 `sk-` 形态未进入 trace。当前定向回归为可观测性 59/59、核心与进程 runner 118/118、扩展 55/55、CLI/RPC 18/18，共 250/250；治理补充套件（discussion、adaptive budget、CLI）177/177，完整本地治理回归共 427/427。 | 已证明原宿主明确退出后的 trace 与 run lease 连续性，以及内容 artifact、Budget、Security、retry、truncation、tool progress 和 chain-invalid 的基础因果；没有证明存活或 PID 复用进程的安全重接管，也没有覆盖日志截断和轮转恢复。配置敏感字段先替换为固定脱敏值再计算哈希。 | 将真实宿主、artifact、Budget、Security 和四个补齐事件的 RPC 探针保留为回归门禁；在 17.8 中继续补存活/PID 复用进程身份验证、截断和轮转故障注入。 |
| 17.4 结构化日志格式 | 已实现基础，v1 entry envelope 与每事件 data schema 已闭合 | `ANSTEEL_RUNTIME_EVENT_DATA_SCHEMAS` 与事件目录逐键对应并拒绝非法类型、未知字段和跨字段组合；entry envelope 又机械限制顶层必填/可选字段、未知字段、规范 UTC、单调纳秒、level、message、role、全部关联 ID、安全 revision、SHA-256、前驱哈希及自父 span。`artifactRefs` 只接受精确 `kind/sha256/storageId`，storage ID 必须解析到本项目内容寻址目录且引用不可重复。固定上限为单条 256 KiB、message 8 KiB、data 128 KiB、深度 12、数组/对象成员 128、字符串 64 KiB、artifact 16 个。writer 对整批原始输入、脱敏结果和预生成引用完成校验后才允许首次 artifact I/O；reader 对 `eventCatalogVersion: 1` 执行同一 envelope 和资源校验，无目录版本旧 schema-v1 仍仅只读兼容。重哈希 reader 变形覆盖时间、时钟、level、message、未知/缺失字段、全部 ID、hash、artifact namespace、深度、数组和单行大小；精确上限接受测试及真实 RPC task run 又逐条验证产品日志。 | v1 未知字段明确失败关闭，新增字段必须升级目录版本，不能静默扩宽；旧无目录版本记录保留较弱只读边界。该闭环不代表日志轮转、保留、磁盘预算、截断恢复或跨轮转 artifact 引用图已经实现，也不把普通 `JSON.stringify` 哈希描述为 JCS 签名。 | 保留 writer/reader、重哈希变形、精确边界和真实 CLI/RPC 回归；后续 schema 扩展必须新增目录版本，并在 17.8/17.11/17.12 补轮转、保留、磁盘不足和截断故障注入。 |
| 17.5 必须记录的运行事件 | 已实现基础，目录与产品写路径均 37/37 | 目录 v1 定义全部 37 个协议事件和当前稳定内部事件，真实产品写路径也精确产生 37 个。新增事实来自真实 AgentSession retry、`stopReason: length`、工具绑定进程 heartbeat 和损坏链 incident；它们分别写 provider retry、role truncated、tool progress 和 chain invalid。incident 的隔离诊断段保持自身哈希链与 fsync，但不修复或替换损坏时不可验证的索引，普通 writer 继续失败关闭。artifact、Security、Budget、lease 与 process 的既有真实性边界保持不变。真实 RPC 覆盖正常任务、31 秒 task heartbeat/progress、provider retry、角色截断、损坏链 incident、5-read 预算耗尽、宿主强杀、artifact 存储/校验、无日志 run 缺失、角色越权读取及完整 v1 entry envelope。当前四组定向回归为可观测性 59/59、核心与进程 runner 118/118、扩展 55/55、CLI/RPC 18/18，共 250/250；治理补充套件 177/177，完整本地治理回归共 427/427。 | 37/37 只证明协议事件各有受约束的产品产生路径。Budget 仍只覆盖隔离 stage 的只读工具调用数；runtime lease 不含内部 index 锁、任务/文件授权租约或动态转交；进程事件未直接携带全部执行前后文件哈希；provider token/首 token/HTTP 状态仍需底层权威回调；日志轮转与保留未完成。孤儿检测不等于存活/PID 复用进程已安全重接管。 | 保留每个事件的 writer/reader、entry envelope 和真实 CLI/RPC 回归；下一步扩展预算类型、任务/文件租约、轮转保留与崩溃故障注入。 |
| 17.6 状态转换日志 | 已实现基础，确定性验证通过 | 状态 v12 在 `team.json` 内保存版本化 `transitionLogs`；team、role、challenge、task、milestone、checkpoint、process issue 和 delivery verification 均保存最后一次 applied 的 `transitionLogId`。成功转换写 attempted/applied，已有生命周期对象的 submission、final-verification readiness 和协作退回 guard 拒绝写 attempted/rejected；记录批量镜像到现有哈希链运行日志。状态加载、`status --explain`、共享工作板与 `doctor` 均在展示前重放校验；删除 `transitionLogId`、删除日志或直接篡改状态以 `state-projection-mismatch` 失败关闭，真实 RPC 回归覆盖 status/board/doctor。 | v11 迁移只建立 `legacy-v11-migration-baseline`，不会补写真实历史。对象创建前的格式、身份、授权与命令接纳失败不是生命周期转换；第 17 章其余事件族、状态快照、轮转和保留仍未完成。 | 增加属性/故障注入覆盖所有生命周期边，并在真实宿主中断恢复探针中证明转换日志、运行日志和公共账本的跨进程因果仍一致。 |
| 17.7 稳定原因码 | 已实现基础，集成部分 | `ANSTEEL_RUNTIME_REASON_CODES` 包含协议列出的 21 个原因码并新增 `secret-detected`，写入与读取拒绝未知值。 | 并非所有失败、阻断、停滞和 revision-required 状态都已强制携带三元组。 | 全状态扫描和故障注入证明所有异常终态都有 `reasonCode`、`causeEventId`、`traceId`。 |
| 17.8 时间与崩溃一致性 | 部分实现 | UTC、单调时钟、连续序号、关键日志同步 `fsync`、孤儿 span 恢复为 `abandoned` 和单 run 写锁已有测试。运行段/索引锁的私有 owner sidecar 保存 PID、进程启动时间以及可执行文件/命令/工作目录哈希；只有 schema 与锁类型合法、锁目录为空且 PID 明确 `ESRCH` 时才提前接管。run lease 的释放与新 owner 获取经过同资源短时审计门闩串行化：旧 owner 在 OS 锁真实释放后、允许新 owner 进入前写 release receipt；若释放目录非空而失败，测试证明不写 `lease.released/succeeded`。真实宿主强杀探针验证旧 lease expired、新 lease acquired/released 和原 trace 恢复。 | 当前只使用“PID 明确不存在”决定提前接管；没有验证存活/PID 复用进程的启动时间、命令哈希和工作目录后再重接管，也没有截断段恢复、轮转边界或门闩自身崩溃故障注入。 | 重启、时钟回拨、截断、活进程、PID 复用和审计门闩中断故障注入均不能伪造成功或错误接管。 |
| 17.9 查询与诊断接口 | 部分实现 | `trace`、`doctor`、`incident`、`status --explain` 命令和确定性扩展测试已存在；`status --explain` 从重放后的状态展示协作、治理、交付三轴和 workflow，并附最近运行诊断；doctor/incident 重读目标 artifact 并把 verified/missing 结果写入当前诊断 run；incident v2 还提供 span 树、公共审计区间、检查点和恢复入口。 | `status --explain` 尚未把当前开放 span/租约、最近 guard、恢复检查点和下一机械动作统一展示；doctor 尚未覆盖日志轮转、快照和遗留进程。四个接口尚未对同一故障逐字段证明原因码、根因、span、artifact 与恢复点完全一致。 | 四个接口对同一故障返回一致的原因码、根因事件、span、artifact 和恢复点，异常时 CLI/RPC 非零退出。 |
| 17.10 事故诊断包 | 已实现基础，schema v2 确定性验证通过 | 内容寻址 incident manifest 使用 `mechanical-facts-only` 证据模型，包含 run/trace、任务及 runtime/current revision、首个根因、传播事件、最终运行状态、公共审计事件区间、运行 span 树、artifact 引用、provider/工具脱敏配置摘要、事件链/日志段/artifact 完整性、最后合法检查点、工作区快照哈希和机械恢复入口。无团队状态、团队完整性失败或工作区无法快照时显式标记 unavailable，不伪造上下文；损坏运行链只采信独立验证的日志段哈希。核心、扩展与真实 RPC 测试逐字段覆盖正常失败、缺失 artifact 和损坏链。 | 公共审计区间当前是已验证账本范围，不是按事故因果裁剪的最小区间；项目外或不可快照工作区只能标记 unavailable；推荐恢复入口已机械生成，但尚未在每类故障中执行并证明可恢复。日志轮转、快照和保留未实现，因此事故包也尚未证明跨轮转引用完整。 | 固定故障夹具继续逐字段校验完整事故包；为每类恢复入口增加执行验证，并证明轮转后包内每个引用仍可重新验证且不调用模型推测。 |
| 17.11 脱敏、权限与保留 | 部分实现 | message、嵌套 data、artifact 在落盘前递归脱敏；Bearer、`sk-` 和带前缀敏感环境变量有测试。脱敏函数返回不含值、路径或秘密哈希的计数摘要，只有值真实变化才写 secret-detected/redaction-applied；已脱敏标记、input/output token 计量字段不误报。Security 事件禁止递归 artifact 和携密 payload。真实 RPC 角色越权读取由 `beforeToolCall` 阻断并写 access-denied。 | 没有受控公共查询与协调器私有日志的完整权限边界；没有 30 天/100 次保留、引用保护和 `retention.deleted`。 | 扩大凭据变形和授权矩阵扫描；引用图垃圾回收和保留策略时间/大小测试全部通过。 |
| 17.12 日志系统自身失败 | 部分实现 | 日志和索引关键写入失败抛出稳定错误；损坏链、丢失 artifact 和索引不一致失败关闭。 | 没有磁盘预算保留、受限模式、截断合法前缀转段和自动修复审计的完整实现。 | 磁盘满、短写、`fsync` 失败、截断、索引替换失败和恢复故障注入证明不会静默或伪造历史。 |
| 17.13 指标与主动告警 | 缺失 | 现有日志可作为未来指标原始事实。 | 没有机械指标聚合、阈值、统一时间线告警或 `status --explain` 告警引用。 | 指标快照和阈值测试覆盖协议清单；六类高危异常立即产生带 trace 和原因码的可见告警。 |

### 17.5 事件目录审计明细

| 事件族 | 协议精确事件数 | 当前产品写路径 | 判定 |
|---|---:|---|---|
| run | 4 | started/resumed/completed/failed 全部由真实命令与恢复路径产生 | 已实现基础 |
| role session | 4 | started/output/ended 由角色生命周期产生；provider `stopReason: length` 产生 truncated/failed/budget-exhausted；不记录公开输出正文 | 已实现基础 |
| provider request | 3 | 每次真实请求产生 started/completed；AgentSession `auto_retry_start` 在同一活动请求下产生 retry 并写权威 attempt/delay | 已实现基础；仍缺部分 token/首 token/HTTP 遥测字段 |
| tool call | 3 | 受治理工具执行产生 started/completed；与工具 span 绑定的受控进程 heartbeat 同批派生 progress | 已实现基础 |
| process | 4 | task、milestone、delivery 共用受控异步 runner，产生 spawned/heartbeat/exited；恢复路径产生 orphan-detected 并归档 abandoned 终态 | 已实现基础；仍缺存活/PID 复用进程身份核验、重接管和所有执行前后文件哈希 |
| state transition | 3 | attempted/applied/rejected 全部精确实现 | 已实现基础 |
| lease | 4 | runtime run writer 精确产生 acquired/renewed/expired/released；同资源审计门闩保证 release receipt 写在真实释放后且先于新 owner 进入，强杀恢复沿原/新 `leaseId` 记录过期和接管 | 已实现 runtime run 基础；内部 index 锁、任务/文件租约和动态转交仍未建模 |
| public event durability | 3 | appended、fsync.completed 正常持久；incident 读取损坏目标链时在独立哈希链诊断段写 chain.invalid，且不改不可验证索引 | 已实现基础；隔离诊断段在源链修复前不进入共享索引 |
| artifact | 3 | writer 产生 stored 或去重 verified；doctor/incident 重读磁盘并产生 verified/missing，事件以源哈希或 source run/sequence 关联且禁止自引用 | 已实现基础；data schema 已按 stored/verified/missing 结果失败关闭，仍缺轮转/保留引用图 |
| budget | 3 | 每个隔离角色 stage reset 产生 reserved；允许的只读工具 preflight 产生 consumed；首个超限请求在执行前产生 exhausted/budget-exhausted。记录角色 span、toolCallId 与机械计数，不复制原始参数 | 已实现 stage 只读调用数基础；项目总量、token、时间、磁盘预算和动态扩展仍未建模 |
| security | 3 | 真实工具策略拒绝产生 access-denied；writer 在持久化前真实检测并派生 secret-detected/redaction-applied，三者均带源因果且禁止自引用 | 已实现基础；仍缺完整凭据变形与角色授权矩阵 |

统计边界：目录覆盖是“允许且约束该名称”，产品接线是“真实执行路径确实产生该名称”，两者分别统计。当前
目录为 37/37，产品接线为 37/37；不把测试夹具手写事件、错误原因码或公共账本 `type` 折算为接线。旧 JSONL
没有 `eventCatalogVersion` 时只读兼容，新 writer 不得再生成这种遗留记录。

## 二、当前可信阶段边界

当前可声明的是“可观测性基础和风险动作门禁正在实现”，不能声明“持续协作协议完成”。尤其不能用以下
局部事实替代整体验收：

- 原因码枚举齐全，不等于所有异常状态都已携带三元组；
- `trace`、`doctor` 和 incident 命令存在，不等于四个诊断入口已经给出同一机械事实；
- JSONL 每条 `fsync`，不等于日志轮转、保留、磁盘不足和截断恢复已完成；
- r28-r30 固定三提供商夹具 3/3、r34 双任务恢复和真实 RPC 宿主强杀恢复通过，不等于任意模型组合、长任务或存活/PID 复用进程的安全重接管已经证明；
- 风险动作双确认通过，不等于协作完成、治理批准和最终交付三轴状态已经实现。

## 三、后续实现顺序

1. 先完成并独立复审当前风险门禁整改，冻结一个可回退的 `main` 基线。
2. 17.3 基础和真实宿主中断/重启探针已完成；保留同 trace、两阶段失败关闭和凭据扫描作为后续变更的回归门禁。
3. 17.6 基础与三轴展示门禁已实现；补做全生命周期属性/故障注入，并扩展真实宿主探针对转换日志与公共账本因果的一致性断言。
4. 17.4 的 v1 entry envelope 与每事件 data schema 已在 writer/reader 双边失败关闭，并由重哈希变形、精确上限和真实 RPC 日志断言覆盖；17.5 的 process、runtime run lease、artifact、Budget、Security、role truncated、provider retry、tool progress 与 chain invalid 已完成权威产品接线，下一步补预算类型、任务/文件租约以及轮转保留。
5. 17.10 incident schema v2 已关联任务/revision、审计区间、span 树、配置摘要、完整性、工作区、检查点和恢复入口；下一步补状态快照、最小事故因果区间，并执行验证各类恢复入口。
6. 实现 17.11、17.12 的轮转、保留、引用保护、磁盘预算、截断恢复和受限模式。
7. 实现 17.13 指标、阈值与主动告警，并让统一时间线和 `status --explain` 引用同一事实。
8. 完成确定性 CLI/RPC、对抗故障注入、三个真实 provider/model 探针和逐条验收审计后，才允许更新协议
   为完成。

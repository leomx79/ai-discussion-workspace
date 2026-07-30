# Ansteel Team 机械风险门禁代码质量复审

> 状态：`REJECTED`
> 审查角色：Senior Code Reviewer
> 审查基线：`76c3918f48cdb0972334c3ae0f497eb9c75aae57` 加当前工作树中的声明差异
> 审查边界：源码、测试和本地确定性复现；未调用外部 Provider

## Issues

### Critical

无。

### Important

#### 1. 工作板把“最后一条工具记录成功”误当成“整个运行成功终结”

**位置**

- `pi-agent/packages/coding-agent/src/extensions/ansteel-team/index.ts:2319-2326`
- `pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts:930-972`
- `pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts:1121-1184`
- `pi-agent/packages/coding-agent/test/ansteel-team-extension.test.ts:657-689`

**问题**

`listAnsteelRuntimeRuns()` 的 `lastOutcome` 只是最后一条日志记录的 `outcome`。工作板用
`lastOutcome === "succeeded"` 选择可信历史，却没有验证根 `run.started` span 已产生成功终态，也没有验证
运行中不存在开放 span。一个运行可以依次写入根 span `started` 和子工具 span `succeeded`，随后宿主崩溃；
此时摘要为 `succeeded`，而同一模块的 `diagnoseAnsteelTeamRun()` 会正确判定
`healthy: false / process-orphaned`。

孤儿恢复只在 `/ansteel-team start` 路径执行（`index.ts:2138-2185`）。重启后若先调用 `board`，当前选择器
仍会接纳该孤儿运行。新增正例测试只写入一条独立的成功 `tool.call.completed` 记录，没有构造和成功关闭根
span，因而没有证明运行终态语义。

**影响**

未完成或崩溃运行中的局部工具事实会被共享工作板显示为“可验证的成功历史”，违反协议
`17.8` 和第 `18` 节对无合法终态运行的失败关闭要求。后续角色可能基于一次实际上未完成的命令继续判断。

**复现证据**

使用公开 logger API 在临时目录中启动根 span、成功结束子工具 span、保留根 span 开放并关闭 logger。
同一 run 的新鲜结果为：

```text
summaryLastOutcome = succeeded
diagnosisHealthy = false
diagnosisReasonCodes = [process-orphaned]
```

**建议修复**

把“运行成功终结”建模为机械字段，而不是复用末条记录。历史摘要至少应验证唯一根 span 具有
`succeeded` 终态、没有开放 span、没有失败/废弃终态和完整性问题；`board` 只接纳该机械终态。新增负例
“根 started -> 子工具 succeeded -> 根未结束”和正例“根成功结束”，并让现有单条工具记录正例不再代替
完整运行。

#### 2. 项目路径边界只做词法判断，Windows junction 可把真实编辑导向项目外

**位置**

- `pi-agent/packages/coding-agent/src/core/ansteel-team.ts:1121-1133`
- `pi-agent/packages/coding-agent/src/core/ansteel-team.ts:1151-1165`
- `pi-agent/packages/coding-agent/src/core/ansteel-team.ts:1232-1249`
- `pi-agent/packages/coding-agent/src/core/ansteel-team.ts:1334-1343`
- `pi-agent/packages/coding-agent/src/core/tools/path-utils.ts:48-49`
- `pi-agent/packages/coding-agent/src/core/tools/edit.ts:308-335`
- `pi-agent/packages/coding-agent/test/ansteel-team.test.ts:1574-1611`

**问题**

任务认领、风险分类、动作绑定和版本哈希都使用 `resolvePath()` 与 `getCwdRelativePath()` 的词法路径，没有
跟随 junction/symlink 校验规范路径仍位于项目根内。通用 `edit` 工具同样只把相对路径拼到 `cwd`，随后
正常跟随文件系统联接。现有测试只拒绝显式 `../outside.ts`，没有覆盖项目内联接指向项目外的情况。

**影响**

一个看似普通的项目内黄色目标可以被认领、哈希、取得双同伴确认并通过执行前门禁，实际却修改项目外文件。
这破坏了工作区授权边界，也可能覆盖用户未授权纳入任务的文件。

**复现证据**

在 Windows 临时项目中创建 `linked` junction 指向另一个临时目录，认领
`linked/outside.txt`、发布黄色检查点并完成两名同行确认，然后调用真实 `createEditTool()`。新鲜结果为：

```text
claimedFiles = [linked/outside.txt]
classifiedRisk = yellow
gateBlockReason = null
escapesCanonicalProject = true
outsideContentAfterEdit = mutated-through-junction
```

**建议修复**

建立统一的规范路径边界解析器并同时用于任务认领、敏感目标分类、动作版本计算、执行前评估和实际文件变更：
已存在目标使用 `realpath` 后做平台正确的包含判断；缺失目标规范化最近存在父目录后再验证；执行前再次校验
以拒绝联接漂移。增加 Windows junction 和 POSIX symlink 的已有目标、缺失目标及联接替换回归。

#### 3. 字符串脱敏不匹配常见带前缀 API Key 环境变量

**位置**

- `pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts:290-307`
- `pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts:331-339`
- `pi-agent/packages/coding-agent/src/core/ansteel-team-observability.ts:1347-1349`
- `pi-agent/packages/coding-agent/test/ansteel-team-observability.test.ts:50-70`

**问题**

字符串脱敏正则以 `\b(API_KEY|ACCESS_TOKEN|...)` 开头。下划线属于正则的 word character，因此
`OPENAI_API_KEY=...`、`ANSTEEL_TL_API_KEY=...` 和类似 Provider 前缀变量不会在 `API_KEY` 前形成词边界。
结构化对象字段名可以被 `SENSITIVE_FIELD` 命中，但 message、stdout/stderr artifact 等纯字符串会原样落盘。
现有测试只覆盖无前缀的 `API_KEY=top-secret`。

**影响**

Provider 凭据可能进入运行 JSONL、内容寻址 artifact 和后续事故包，直接违反协议 `17.11` 的“环境变量值
不落盘”要求。artifact 的 SHA-256 完整性不能补救写入前未脱敏。

**复现证据**

通过公开 logger API 写入伪造哨兵值后读取持久结果，新鲜结果为：

```text
messageContainsSentinel = true
artifactContainsSentinel = true
persistedMessage = OPENAI_API_KEY=sentinel-review-value-123
persistedArtifact = ANSTEEL_TL_API_KEY=sentinel-review-value-456
```

**建议修复**

识别完整环境变量赋值，而不是只匹配固定裸名称，例如匹配合法变量名中以
`API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PRIVATE_KEY|SECRET|TOKEN` 结尾的敏感名称，并保留变量名、替换
全部值。增加 `OPENAI_API_KEY`、`ANSTEEL_TL_API_KEY`、其他 Provider 前缀、大小写、引号值和标点边界
回归；message、嵌套 data 与 artifact 应使用同一组测试向量。

### Minor

无。当前应先关闭以上阻断项，不用次要风格问题稀释风险。

## Strengths

- 状态重放从结构化公共事件重新派生检查点、过程问题和动作确认，再与持久状态深比较；
  `ansteel-team.ts:3058-3107` 对状态投影漂移采取失败关闭。
- 风险在执行前按真实工具与当前目标重新计算，角色声明只能升级，不能把已有文件覆盖或敏感目标降级；
  `ansteel-team.ts:1168-1229`、`:1354-1496` 的顺序清晰。
- reviewer 身份由角色 session 注入，核心同时拒绝 actor 自批、重复 reviewer 和
  checkpoint/kind/target/version 错绑；当前未发现仅靠工具参数伪造 reviewer 的路径。
- 真实角色 session 的 `beforeToolCall` 已覆盖 `edit` 与 `write`，并保留任务 owner、冻结 revision 和公共
  `action-assessed` 事实，风险门禁不是事后日志。
- 活跃旧宿主仍持有运行锁时，新宿主无法取得 writer lease，也不会伪造成功恢复审计；这一失败关闭边界有
  扩展回归。
- 历史索引对非规范日志段、段集合、哈希和有效前缀截断的校验较完整；本轮问题是消费者错误解释运行终态，
  不是索引静默漏段。

## Verification

本轮没有调用外部 Provider，也没有运行耗时的四文件全回归。审查使用当前 Windows 环境、公开 TypeScript
API、真实 logger、真实 junction 和真实 `edit` 工具完成三个独立临时目录复现；三个脚本均退出码 `0`，
临时目录均已清理。首次 `tsx -e` 因 PowerShell 原生参数剥离源码引号而在解析前失败，不计入产品证据；
改用标准输入执行同一脚本后得到上述结果。

## Assessment

**Ready to merge? No.**

当前有三个未关闭的 Important 问题，分别破坏可信运行终态、项目写入边界和凭据不落盘保证。Task 6 的
独立代码质量复审不能批准，计划 Step 6.3 和后续提交/推送门禁应保持未完成，直到修复并增加对应确定性
回归。现有规范复审的 `APPROVED` 结论也需要在这些问题关闭后重新核对。

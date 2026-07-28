# Ansteel Team 高难度真实编码探针设计

## 目标

使用真实认证的 `/ansteel-team` 运行一次高难度但边界明确的编码任务，验证系统能否完成：

1. 三角色独立调查和公开交叉质疑；
2. Staff Engineer 声明精确文件并实际使用 `edit` 或 `write`；
3. 通过 `ansteel_submit_change` 执行真实测试并冻结非空 Git diff；
4. Tech Lead 与 QA Engineer 基于同一证据独立评审；
5. 越权写入、测试失败、超时或会签缺失时失败关闭；
6. 运行记录能够区分模型答复、工具事实、治理批准和隐藏验收结果。

本探针不修改主产品源码，也不以模型文字质量代替交付结果。

## 隔离方式

在系统临时目录创建独立 Git 仓库 `ansteel-team-hard-probe-<timestamp>`。初始提交只包含题目、测试、实现桩和探针配置；Ansteel 运行状态写入该仓库的 `.pi/ansteel-team/`。

主仓库不保存 API Key、真实端点、原始模型负载、运行状态或临时实现。测试结束后保留临时仓库路径和脱敏摘要，便于人工复核；未经用户确认不删除运行现场。

## 困难题目

仅使用 Node.js 标准库，实现一个崩溃可恢复的租约任务队列 `DurableLeaseQueue`。

队列支持：

- 任务入队和前向依赖；新依赖边不得形成环；
- 按任务 ID 字典序认领当前可运行任务；
- 带所有者、租约截止时间和不可复用令牌的认领；
- 续租、完成和失败操作；
- 相同请求幂等，冲突请求和陈旧令牌失败关闭；
- 租约过期后重新认领，旧持有者不能再修改任务；
- JSON Lines 追加事件日志、单调序号和 SHA-256 前向哈希链；
- 每次状态变更先持久化并同步日志，再更新内存状态；
- 重启后确定性重放；允许忽略崩溃产生的最后一条不完整记录，但拒绝中间损坏、序号断裂或哈希不匹配；
- 同一进程内的并发修改串行化，不能出现双重有效认领或重复完成。

公开 API 固定为：

```javascript
export class DurableLeaseQueue {
  constructor({ logPath, clock });
  async recover();
  async enqueue({ id, payload, dependsOn });
  async claim({ workerId, leaseMs });
  async renew({ id, workerId, token, leaseMs });
  async complete({ id, workerId, token, result });
  async fail({ id, workerId, token, reason });
  getState(id);
}
```

具体错误类型和内部数据结构由实现者决定，但所有拒绝都必须是可观察的异常，不能静默成功。

## 测试夹具

临时仓库包含：

- `README.md`：完整题目、API 和验收规则；
- `package.json`：只使用 `node --test`，不安装第三方依赖；
- `src/lease-queue.mjs`：待实现桩，唯一允许 Staff 修改的产品文件；
- `test/lease-queue.test.mjs`：公开契约、恢复、并发和破坏性日志测试；
- `.pi/ansteel.json`：三个不同 `provider/model` 标识、显式 `teamTools` 和 `teamTaskOwners`，不含凭据；
- `.gitignore`：排除 `.pi/ansteel-team/` 等运行状态。

协调器在临时仓库之外保留隐藏验收测试。隐藏测试通过环境变量定位实现文件，覆盖随机操作序列、重复恢复、陈旧令牌、并发认领和日志尾部截断。隐藏测试不参与角色提示和交付 diff，防止针对固定断言硬编码。

## 角色权限

- Tech Lead：`read`、`grep`、`find`、`ls`、`bash`，负责架构和证据评审，不写文件；
- Staff Engineer：`read`、`grep`、`find`、`ls`、`bash`、`edit`、`write`，是唯一任务所有者；
- QA Engineer：`read`、`grep`、`find`、`ls`、`bash`，负责边界、恢复和并发评审，不写文件；
- `teamTaskOwners` 固定为 `["staff-engineer"]`；
- 所有角色必须通过 Ansteel 任务工具完成认领、提交和评审，宿主不代替角色制造批准。

## 运行流程

1. 创建并提交临时仓库基线，先运行公开测试，确认实现桩按预期失败。
2. 从当前 `main` 源码启动 Pi RPC，运行 `/ansteel-team start`。
3. 让团队完成调查、交叉质疑和一个精确的实现任务。
4. Staff 认领 `src/lease-queue.mjs`，实现后通过 `ansteel_submit_change` 运行公开测试。
5. 系统冻结测试输出和该文件的非空 diff，TL 与 QA 独立评审。
6. 团队停止后，协调器只读检查 `team.json`、`events.jsonl`、角色工具事件和 Git diff。
7. 协调器在团队之外运行隐藏测试，并记录真实退出码。
8. 运行达到 60 分钟、提供商明确不可用或状态进入不可恢复失败时停止，不用人工文字补成批准。

## 结果判定

### 通过

- 三个配置角色均产生真实提供商响应和可定位的公开事件；
- Staff 实际使用写入工具，且只修改已认领文件；
- `ansteel_submit_change` 的公开测试退出码为零；
- 冻结证据包含非空、限定文件的 Git diff；
- TL 与 QA 都通过 `ansteel_review_task` 批准同一 revision；
- 任务最终状态为 `approved`；
- 隐藏测试退出码为零。

### 部分通过

代码和公开测试成功，但双评审、隐藏测试、工具证据或最终状态有任一缺失。必须明确列出缺口，不能称为完整交付。

### 正确失败关闭

模型不可用、超时、越权写入、测试失败、diff 为空、评审拒绝或恢复异常时，系统拒绝批准并保留可定位原因。该结果证明门禁生效，但不证明编码能力成功。

### 系统缺陷

出现未认领写入、测试失败仍批准、角色缺失仍交付、证据与 revision 不一致、隐藏失败被报告为成功，或状态记录无法解释实际工具行为。

## 输出摘要

最终向用户报告：

- 题目和临时仓库位置；
- 三角色实际 provider/model 标识及是否成功响应；
- 每个阶段耗时、工具调用和终态；
- Staff 修改文件、公开测试、冻结 diff 和双评审证据；
- 隐藏测试结果；
- 通过、部分通过、正确失败关闭或系统缺陷的最终判定；
- 发现的产品问题及下一步修复建议。

不得输出 API Key、认证存储内容、原始端点凭据或隐藏推理。

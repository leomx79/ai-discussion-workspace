# Ansteel 长任务 Epoch 监督器设计

## 背景与目标

Ansteel 已具备受限阶段预算、项目硬截止时间、不可变检查点和 `--ansteel-resume <run-id>`。达到 `epochTimeoutMs` 边界后，当前审查会以 `PAUSED` 成功退出，下一次调用会建立新的短生命周期角色会话并从检查点继续。

当前缺口是续跑必须由人手工重复输入命令。因此数小时审查虽然可恢复，但不能自主完成。新增的监督器必须把长审查拆成多个既有 CLI epoch，不能让模型连接、角色会话、工具额度或未持久化状态跨 epoch 存活。

本次只新增 Ansteel 自动续跑入口，不改动三角色治理规则、模型选择、阶段预算、项目截止时间、检查点格式或报告语义。

## 命令与边界

在现有 `pi` CLI 中新增两个非交互入口：

```text
pi --ansteel-supervise "审查议题" [--ansteel-supervise-max-epochs N] [其他现有 Pi 选项]
pi --ansteel-supervise-resume <run-id> [--ansteel-supervise-max-epochs N] [其他现有 Pi 选项]
```

- 新建模式只接受议题；恢复模式只接受通过现有安全格式校验的 Ansteel run ID。
- 两种监督器模式均不能与 `--ansteel`、`--ansteel-resume`、Pi 的普通 `--resume/-r` 或彼此混用。
- `--ansteel-supervise-max-epochs` 是正整数，默认 `64`，上限 `128`。达到上限时停止并保留 `ready-to-resume` 检查点，不伪造批准、拒绝或完成结果。
- 现有扩展、模型和认证选项原样转交给每个子进程；监督器自身不创建 `AgentSession`、不解析角色输出、也不访问 API Key。

## 架构与数据流

监督器在创建第一个子进程前，原子创建项目目录下的 `.pi/ansteel-supervisor.lock`。新锁格式为版本 2，保存父进程 PID、启动时间、当前 run ID（若已知）和显式 `epochState`。每次 `spawn` 前必须先原子写入 `epochState: starting`；子进程已创建且 PID 可用后才原子升级为 `epochState: running` 并记录该 PID；子进程关闭后恢复 `idle`。第二个监督器发现仍存活或不可验证的父 PID 时立即失败；父 PID 已退出但仍为 `starting` 时也必须失败关闭，因为无法证明子进程尚未创建；只有父 PID 已退出、锁为 `idle` 或已确认运行中子进程也退出时才能清理并接管。版本 1 没有 child 状态，父 PID 已退出的版本 1 锁必须保留并由人工核实，不得自动接管。无法解析、权限不足或无法安全确认的锁一律失败关闭。

首次子进程运行与用户等价的 `pi --ansteel <topic>`；后续子进程运行 `pi --ansteel-resume <run-id>`。子进程继承当前工作目录、环境和标准输入输出，父进程只等待退出，不转发或缓存任何模型协议数据。每轮结束后：

1. 子进程非零退出：监督器停止并返回该退出码。子进程自己的拒绝报告或失败报告保持权威。
2. 子进程零退出且检查点为 `ready-to-resume`：更新锁的 run ID，启动下一个短 epoch。
3. 子进程零退出且检查点为 `completed`、`failed` 或 `expired`：停止并返回成功或子进程给出的最终退出码；不再次调用 Provider。
4. 子进程零退出但没有唯一且可验证的预期检查点：停止并失败关闭。首次运行通过“启动前后检查点集合差集”识别唯一新 run；恢复运行只读取用户提供的 run ID。

监督器使用已有 `loadAnsteelRunCheckpoint()` 读取状态，绝不从 Markdown、终端文本或模型回答推导续跑决定。`ready-to-resume` 以外的任何非终态或异常状态都停止，并给出检查点路径和原因。

正常退出和可等待的异常路径中，父进程在子进程已退出后通过 `finally` 尝试删除自己的锁。SIGINT、SIGTERM、SIGKILL 等进程终止不保证异步清理会运行；下一次启动必须按持久化的版本 2 锁状态恢复，不使用基于时间的猜测性抢锁。`starting` 与已退出父 PID 的版本 1 锁均保留给人工核实，`idle` 或父、子 PID 都确认退出的 `running` 锁才可自动接管。

## 错误、并发与成本语义

- 一个项目同时最多允许一个监督器。手动 `--ansteel-resume` 不读取监督器锁，因此文档明确要求手动恢复前先停止监督器；监督器在每个子进程间重新读取检查点，避免依据内存状态继续。
- 监督器不把 `PAUSED` 当成成功完成，也不把到达 epoch 上限当作治理结论。它仅报告 `SUPERVISOR_STOPPED`，并留下可恢复 run ID。
- 角色阶段超时、Provider 失败、配置漂移、证据漂移、检查点损坏和项目硬截止全部继续由现有核心逻辑决定；监督器不重试失败 epoch。
- 监督器最多跨越配置允许的有限治理阶段。`max-epochs` 是第二道进程级保险，不改变项目级预算或 SLA。

## 测试与验收

实现将把循环决策抽为可注入的监督器核心，并保留一个薄 CLI 子进程适配层。确定性测试必须覆盖：

1. 新建审查从首次暂停自动恢复，直到终态，且每个 epoch 只调用一次子进程执行器。
2. 恢复审查只使用指定 run ID，不能扫描并误选另一个项目的检查点。
3. 子进程非零、零退出但检查点缺失、多个新检查点、非法状态和达到 epoch 上限都停止且不再启动下一轮。
4. 存活锁拒绝并发启动；版本 2 的 `idle` 与父、子 PID 均死亡的 `running` 锁可恢复；`starting` 和死亡父 PID 的版本 1 锁失败关闭；正常可等待退出后锁被删除。
5. 参数解析拒绝冲突、路径式 run ID 和非法 epoch 上限。
6. 真实 CLI 集成测试使用现有确定性 Provider 扩展，让第一个 epoch 暂停、第二个 epoch 完成，验证报告、检查点和子进程参数。

完成前至少执行目标单元测试、Ansteel CLI 集成测试、`packages/coding-agent` 构建、GitHub 同款治理门禁和 `git diff --check`。所有项目改动以详细中文提交直接推送 `main`，并保留 `git revert <SHA>` 回退路径。

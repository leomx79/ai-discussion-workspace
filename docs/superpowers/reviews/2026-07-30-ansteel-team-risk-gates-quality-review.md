# Ansteel Team 机械风险门禁独立代码质量复审

> 最终状态：`APPROVED`
> Ready to merge：`Yes`
> 复审日期：`2026-07-30`
> 复审基线：`980f0e9756909b07017246867e235921717db6ce` 加当前未提交工作树
> 独立性：质量复审者未读取或依赖规格复审结论，未修改文件、暂存、提交或推送

## 一、最终结论

质量复审对默认角色真实工具工厂、文件系统竞态、公共事件与输出脱敏、运行历史筛选、通用 Pi 兼容性、资源关闭和提交范围进行了独立检查。复审过程中发现的阻断均已修复并重新核验，未发现新的 Critical 或 Important 合并阻断。

`VERDICT: APPROVED`

`Ready to merge: Yes`

## 二、已关闭问题

### 1. 根运行终态与工作板历史

- 根终态严格绑定唯一无父根 span，伪造父关系的子终态不能制造成功运行。
- 工作板只接纳根终态成功且完整诊断健康的同团队历史运行。
- 孤儿、失败、进行中、废弃或伪成功运行全部失败关闭。

判定：`CLOSED`。

### 2. junction/symlink 最终 I/O 竞态

早期实现存在“路径校验、open、路径 stat 分离”的竞态，可通过交替切换 Windows junction 让项目外句柄通过。最终实现：

- 检查点版本绑定同一批准句柄的非零 `dev/ino + SHA-256`；
- 默认 Ansteel 角色只在动作评估和双同伴批准后发放一次性授权；
- 打开句柄必须匹配批准身份；
- 每次 mutation 前校验当前路径、句柄身份、大小和批准哈希；
- `edit` 直接使用 `revalidateAndRead()` 返回的同一已验证 buffer；
- 覆盖与截断复用句柄，且所有成功打开的句柄在 `finally` 中关闭。

交替 junction、后置链接替换、同 inode 内容漂移和缺失新文件反例均失败关闭，项目外文件保持不变。

判定：`CLOSED`。

### 3. artifact 与公共输出凭据泄漏

最终脱敏覆盖：

- `NAME=value` 与 `name: value`；
- JSON 引号键和值；
- 带 Provider 前缀的 `API_KEY`、`ACCESS_TOKEN` 等名称；
- Basic/Bearer；
- `sk-`；
- message、嵌套 data、artifact、公共事件账本和 UI 时间线。

最外层命令重新抛出的是新建脱敏异常，不再把原始 provider `error.message` 交给 AgentSession 的 extension error 通道，因此 RPC、print 和 TUI 不会重新公开原始消息。

判定：`CLOSED`。

### 4. 通用工具兼容性

- 只有默认 Ansteel 角色工具注入 guarded mutation；
- 普通 Pi `edit/write` 未配置该执行器时仍走原实现；
- 普通 `write` 仍可新建文件；
- 治理模式对缺失文件明确失败关闭，不伪装成支持原子创建。

判定：`CLOSED`。

### 5. 提交范围与流程指令

- 新守卫文件与 CLI/RPC 版本夹具测试均已纳入声明文件、Biome 和显式 `git add`；
- 计划已删除残留的外部流程技能调用要求；
- 本地无关文件和运行产物不在提交范围。

判定：`CLOSED`。

## 三、代码质量核对

- 新增与修改代码包含边界、一次性授权、SHA 绑定、失败关闭和 ABA 防护注释；
- 文件读取使用显式 position，不依赖共享句柄 offset；
- 打开文件失败、身份不符、内容漂移和 mutation 异常都不会泄漏句柄；
- 一次性授权在异步校验前消费，且角色工具强制顺序执行；
- legacy 纯内容版本不能静默获得写权限，必须发布新检查点；
- 公共事件脱敏发生在哈希前，重放状态与落盘内容一致；
- 稳定原因码在脱敏异常中保留。

## 四、最终验证

- 七文件串行回归：`7/7` 文件通过，`241 passed / 1 skipped`；
- 三个治理核心文件：`145/145`；
- CLI/RPC：`12/12`；
- `npm run build`：退出码 `0`；
- `npx tsgo --noEmit`：退出码 `0`；
- 受影响文件 Biome：退出码 `0`；
- 四项依赖与锁检查：退出码 `0`；
- `git diff --check`：退出码 `0`，仅有 Markdown 行尾策略提示。

## 五、保留边界

本复审没有调用真实外部 provider，不把确定性 provider 测试写成真实三提供商证明；不批准迁移第 7 至 10 步，也不证明最终交付正确性。

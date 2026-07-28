# Ansteel 自适应预算与恢复 Implementation Plan

> 执行状态（2026-07-28）：项目工具硬上限、五个强制门禁 reserve、epoch 恢复边界、checkpoint 耐久工具账本与基础状态机均已实现并通过定向回归。根构建仍在 `models.dev:443` 的目录下载连接超时处失败，未将该外部故障标记为构建通过。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Ansteel 的自适应预算和跨 epoch 恢复具备可执行硬边界与确定性回归。

**Architecture:** 共享预算统一计算有效上限并按阶段保护验证 reserve。checkpoint 把 epoch、身份和下一动作作为协调器状态持久化，恢复只接受完整匹配的边界。

**Tech Stack:** TypeScript, Vitest, Pi coding-agent CLI, GitHub Actions。

## Global Constraints

- 仅在 `main` 主线工作，不创建功能分支。
- 固定预算路径保持兼容，所有新行为先写失败测试。
- 不把真实 provider 的超时或配置多样性误报为端到端成功。

---

### Task 1: 强制项目工具预算

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-discussion.ts`
- Test: `pi-agent/packages/coding-agent/test/ansteel-discussion.test.ts`

- [ ] 写出固定工具上限大于自适应上限时仍只能执行较小上限的失败测试。
- [ ] 写出普通阶段不能消费验证预留、验证阶段可以消费的失败测试。
- [ ] 运行单测，确认当前实现失败。
- [ ] 实现有效上限和阶段感知 reserve。
- [ ] 重跑单测，确认通过。

### Task 2: 可恢复 epoch 状态

**Files:**
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-discussion.ts`
- Modify: `pi-agent/packages/coding-agent/src/core/ansteel-run.ts`
- Test: `pi-agent/packages/coding-agent/test/ansteel-discussion.test.ts`

- [ ] 写出恢复后新 epoch 使用新计时窗口、项目 deadline 保持不变的失败测试。
- [ ] 写出 checkpoint 终态不能倒退为可恢复状态的失败测试。
- [ ] 实现 epoch 起点、合法状态转换和完整恢复身份持久化。
- [ ] 重跑对应测试，确认通过。

### Task 3: 门禁和目录构建

**Files:**
- Modify: `.github/workflows/ansteel-governance.yml`
- Modify: `.github/workflows/ansteel-delivery.yml`
- Modify: `pi-agent/packages/ai/src/providers/data/`

- [ ] 将自适应预算测试加入两个工作流。
- [ ] 用仓库生成器同步模型数据，或在离线条件下拒绝无来源的目录更新。
- [ ] 运行 `npm run build:offline`，确认目录检查通过。

### Task 4: 验证与交付

**Files:**
- Test: `pi-agent/packages/coding-agent/test/ansteel-*.test.ts`

- [ ] 运行完整 Ansteel 定向测试和 TypeScript 检查。
- [ ] 运行离线构建和 diff 检查。
- [ ] 请求独立代码审查并修正有效问题。
- [ ] 使用详细中文提交信息提交所有受控文件，并直接推送 `main`。

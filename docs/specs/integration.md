# 集成台设计

使用见[集成台](../features/integration.md)。

## 状态与快照

- 状态为 developing、submitted、merge_pending、merged、closed；非法跳转拒绝，相同状态不重复触发。
- 普通任务提测生成 initial_review 与 test_cases，待合入生成 final_review。
- 转译交接确认使用专用幂等入口，不重复触发模型审查。
- Task、Run、Artifact、Event 分别保存业务状态、执行快照、报告和状态审计。
- 报告绑定 baseSha、headSha、targetTipSha 与 diffHash；状态更新使用并发校验。

## 执行隔离

- Git 使用结构化参数，冻结提交并创建受管 detached worktree，不操作开发者工作区。
- 集成 OpenCode 与聊天服务分离，只加载审查和测试用例 Skill。
- 受控工作区身份、私有 manifest 与租约校验先于文件或网络操作。
- 每个报告独立会话，只允许写受控 Markdown 报告，禁止业务代码写入和任意命令。
- 必须读取报告文件，缺失或非法明确失败，不能用聊天总结替代产物。

## 恢复与清理

运行和产物保存会话、终态和清理检查点。过期租约先核对旧实例，
未知副作用保留恢复状态，不并发重放。报告、事件与快照保留，临时工作树在确认安全后清理。
自动报告不代表测试已执行或代码已合入；业务状态由人工推进，交付核验另查实际 Git 事实。

## 验证

覆盖状态触发、并发/重复提交、真实临时 Git、快照变化、权限与路径隔离、
报告缺失、模型超时、租约恢复和幂等清理。

运行 `npm run test:integration-all` 与 `npm run typecheck`；真实模型和仓库验收单独记录。

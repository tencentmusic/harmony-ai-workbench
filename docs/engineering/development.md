# 开发规范

## 代码组织

- 使用 Next.js App Router、React、TypeScript、Prisma / SQLite；按业务模块组织目录。
- API Route 只做鉴权、参数解析、业务调用和响应转换。长任务由 Worker 执行。
- 跨服务端模块仅访问 `public.ts` 的具名导出；前端不导入服务端，服务端不反向依赖页面。
- `src/contracts` 不依赖 Node、环境变量或业务实现；领域规则通过适配器使用 Git、网络和文件系统。
- 公共抽象至少有两个真实调用方；新增业务不放入 `src/lib`。
- TypeScript 保持 strict；外部输入先校验，避免隐式 any、无说明的规则关闭和敏感日志。

## Git 协作与部署

`release` 是合入与部署分支，只接受 MR。开发从最新 `origin/release` 创建 `feature/*` 或 `fix/*`：

```text
git fetch origin
git checkout -b feature/<topic> origin/release
开发并验证 → push 特性分支 → 创建 release MR → 审核合入 → Webhook 部署 → 验收
```

提交格式为 `type(scope): 中文描述`，例如 `fix(cloud-agent): 修正任务恢复判断`。
一个提交只包含一个可独立验证和回退的改动，不混入无关文件或密钥。

测试服只拉取已合入代码、构建、重启和验收。SSH 用于只读排查或执行已批准的部署脚本，不在测试服开发、手改业务代码或绕过部署流程安装依赖。

## 配置与验证

- 资源配置在 `config/workspace-apps.json`；本地凭据在 `.env`，生产凭据在 `.env.production`，仅提交示例。
- 数据库结构以 `prisma/schema.prisma` 为准。出现 drop / data loss 提示时先核对，不直接确认。
- 行为改动按 SPEC → PLAN → 测试 → 实现推进；纯文档或保持行为的机械调整可简化。
- 代码改动运行 `npm run typecheck` 和受影响测试；涉及运行栈时启动 `npm run dev:stack` 验收。
- 文档改动检查事实、相对链接、命令与图片；不把历史测试结果当作本次验证。
- 用户可感知改动按 `.cursor/rules/changelog.mdc` 更新版本，只记录重要模块变化。

## 文档维护

| 目录 | 保留内容 |
| --- | --- |
| `features/` | 当前功能、使用步骤、权限与限制 |
| `engineering/` | 架构、开发规范与接入配置 |
| `operations/` | 部署、运行、诊断与恢复命令 |
| `specs/` | 每模块一篇设计约束与验证清单 |

同一模块持续更新原文，不新增按日期拆分的过程文档。计划与规格合并维护，不保留重复的 `plans/` 副本。
删除已失效方案、任务流水账、历史测试数字和试点收据；必要的决策保留结论与边界。执行日志留在任务产物或 Git 历史中。
新增或移动文档同步更新 [docs/README.md](../README.md)。

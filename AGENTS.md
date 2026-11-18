# kugou-harmony-ai-workbench 协作入口

本文件只维护全仓硬约束、目录作用域和协作入口。模块职责与局部验证写在对应目录的
`AGENTS.md`，更深目录可以收紧规则，但不能放宽全仓约束。

## 开工前

1. 改代码、部署、SSH 或处理分支前先读[开发规范的 Git 协作与部署章节](docs/engineering/development.md#git-协作与部署)。
2. 阅读目标目录最近的 `AGENTS.md`；工程规范见 [`docs/engineering/development.md`](docs/engineering/development.md)。
3. 现行用法、配置与运维写入 [`docs/README.md`](docs/README.md) 索引中的文档；`specs/` 每模块一篇设计约束。计划与规格合并维护，不新增 `plans/` 日期过程文件，不追加历史测试流水账。
4. 当前合入目标为 `release`，开发必须位于从最新 `origin/release` 创建的 `feature/*` 或 `fix/*` 分支。

## 目录作用域

| 路径 | 职责 | 局部规则 |
| --- | --- | --- |
| `src/app/` | Next.js 页面与 API 入口，只做装配 | [`src/app/AGENTS.md`](src/app/AGENTS.md) |
| `src/features/` | 浏览器端业务模块 | [`src/features/AGENTS.md`](src/features/AGENTS.md) |
| `src/contracts/` | 前后端共享契约 | [`src/contracts/AGENTS.md`](src/contracts/AGENTS.md) |
| `src/server/` | 服务端业务模块与平台适配 | [`src/server/AGENTS.md`](src/server/AGENTS.md) |
| `src/shared/` | 至少两个前端模块共用的 UI 与浏览器能力 | [`src/shared/AGENTS.md`](src/shared/AGENTS.md) |
| `workers/` | 独立后台进程入口与专属实现 | [`workers/AGENTS.md`](workers/AGENTS.md) |
| `runtime/` | OpenCode 等外部运行时配置 | [`runtime/AGENTS.md`](runtime/AGENTS.md) |
| `deploy/` | Nginx、进程与环境部署资产 | [`deploy/AGENTS.md`](deploy/AGENTS.md) |
| `packages/` | 可独立运行或发布的同仓包 | [`packages/AGENTS.md`](packages/AGENTS.md) |

`src/lib/` 是待逐步收敛的历史兼容区。修复现有能力可以就地修改；新业务模块、Worker 或平台适配不得
继续放入该目录。

## 全仓边界

- 新能力按业务域落在 `src/features/<feature>` 与 `src/server/modules/<feature>`，入口层不承载业务规则。
- API Route 只负责身份校验、输入解析、调用应用服务和响应转换；不得新增直接 Prisma、Git、文件系统或
  OpenCode 编排。
- 跨服务端模块只使用目标模块的 `public.ts`；公开符号逐项导出，不使用 `export *`。
- 前端不得导入 `src/server`；服务端不得反向导入 `src/features` 或 `src/app`。
- `src/contracts` 不读取环境变量，不依赖 Node API、页面、前端模块或服务端实现。
- 进程入口只负责配置、依赖装配、启动与关闭；任务逻辑留在服务端模块。
- 机械可检查的规则必须进入 `npm run test:architecture`，不得只依赖评审记忆。

## 开发与验证

- 行为改动按 **SPEC → PLAN → RED → GREEN → REFACTOR** 推进；纯文档和保持行为的机械迁移可简化，
  但必须写清范围并运行受影响测试。
- 外部输入先按 `unknown` 处理并校验；禁止新增隐式 `any`、`@ts-ignore` 或无说明的规则关闭。
- 测试优先与模块同目录；历史 `scripts/test-*.mjs` 可继续使用，迁移模块时同步更新真实入口。
- 最低门禁为 `npm run typecheck` 和受影响模块测试；涉及运行栈时还要执行 `npm run dev:stack` 启动验收。
- 用户可感知改动遵守 `.cursor/rules/changelog.mdc` 更新版本与日志；纯重构和内部规范不更新版本。

## 提交

提交使用 Conventional Commits：`type(scope): 中文描述`。一个提交只包含一个可独立说明、验证和回退的
逻辑改动；不得直接提交或推送 `release`，不得在测试服工作区开发。

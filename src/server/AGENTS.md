# 服务端规则

- 业务能力位于 `modules/<feature>`；技术适配位于 `platform/<capability>`。
- API 与 Worker 只调用模块 `public.ts`；模块之间也只通过公开入口或事件协作。
- 领域规则不依赖 Prisma、环境变量、网络和文件系统；外部副作用放在基础设施实现。
- 服务端不得导入 `src/app` 或 `src/features`，不得声明 `use client`。
- 修改后至少运行 `npm run test:architecture`、`npm run typecheck` 和对应模块测试。

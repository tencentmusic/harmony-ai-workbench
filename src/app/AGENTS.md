# Next.js 入口规则

- 页面只装配 `src/features`；API Route 只通过服务端模块 `public.ts` 调用业务能力。
- API Route 不新增 Prisma、Git、文件系统、OpenCode 或长任务编排。
- 身份、输入版本和错误映射必须在入口明确处理；前端隐藏按钮不能代替服务端权限。
- 框架要求的 `page.tsx`、`layout.tsx` 和 `route.ts` 可以使用默认导出或固定导出，其余遵守全仓规范。

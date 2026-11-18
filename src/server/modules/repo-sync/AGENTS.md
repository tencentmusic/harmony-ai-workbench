# 仓库同步模块

负责 Webhook/手动入队、仓库更新、后续索引与部署调度。Web 调用方使用 `public.ts`，Worker 使用
`worker-public.ts`，入口位于 `workers/repo-sync`。定向验证运行 `npm run test:repo-sync` 和
`npm run test:repo-sync-follow-up`。

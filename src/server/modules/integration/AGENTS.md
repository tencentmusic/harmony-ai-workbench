# 集成模块

负责集成任务、审查运行、Git 冲突检查与执行恢复。生产调用方只能使用 `public.ts`；内部测试可以直接
导入被测文件。定向验证运行 `npm run test:integration-all`。

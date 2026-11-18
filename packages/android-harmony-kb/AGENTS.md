# Android ↔ Harmony 知识库包

本目录是 Workbench 单仓内的结构化知识库包，包含 Git 事实、Schema、生产脚本、MCP 服务和遥测 SDK。

## 边界

- L1 业务事实和双端代码地图只维护在 `workspace-apps.json` 登记的外部技术知识库；本包不生产或保存 relation/mapping。
- CodeGraph 索引位于源码仓，是可重建产物，不得反向成为业务事实源。
- 脚本必须以本目录为 KB 根目录解析相对路径，不依赖 Workbench 当前工作目录。
- Android、HarmonyOS 和迁移文档源码仍是外部可插拔仓库，统一通过根目录
  `config/workspace-apps.json` 的项目包和 `WORKSPACE_PROFILE` 引用。
- 不在本目录维护独立分支、提交或部署规范；统一遵守仓库根 `AGENTS.md` 与开发规范。

## 验证

优先从 Workbench 根目录执行：

```text
npm run kb:validate
npm run kb:test
npm run kb:test:codegraph-config
```

修改 MCP Gateway 或 CodeGraph 服务时，再执行对应 smoke test。源码与迁移文档路径不得在本包重复配置。

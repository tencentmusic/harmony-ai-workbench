# android-harmony-kb

`android-harmony-kb` 是 Workbench 内的知识运行包，负责把可插拔知识源、CodeGraph 和 MCP 组合成统一查询能力。本包不保存业务知识、双端映射或迁移案例事实。

## 当前边界

| 能力 | 事实来源 | 本包职责 |
| --- | --- | --- |
| 技术知识 | `workspace-apps.json` 登记的技术知识库 | 读取 manifest，提供渐进搜索和精确章节读取 |
| 迁移案例 | `workspace-apps.json` 登记的迁移案例库 | 动态建立内存索引，提供搜索与分段读取 |
| 代码图谱 | 各 Android / Harmony 源码仓的 `.codegraph/` | 按项目和平台查询符号、调用链与影响面 |
| Agent 接入 | Workbench、Cursor、Codex、Claude Code | 提供 stdio MCP、鉴权 Gateway 和遥测 |

旧 `knowledge/`、`mappings/`、`registry/`、relation DB 与 KTV producer 已删除，不提供兼容回退。

## 目录

```text
packages/android-harmony-kb/
├── config/                  CodeGraph 模块与 MCP 配置模板
├── packages/
│   ├── kb-mcp-gateway/      鉴权知识与 Android 源码查询
│   ├── kb-mcp-codegraph/    双端 CodeGraph 查询
│   └── kb-telemetry/        查询遥测
└── scripts/
    ├── cli/                 安装、状态与 CodeGraph 初始化
    ├── lib/                 可插拔知识源和 CodeGraph 运行时
    ├── mcp/                 stdio MCP 入口
    ├── kb-sync/             L2 健康检查与增量同步
    └── test/                运行时测试
```

## 配置

路径、项目、源码、知识库、分支和同步规则只在 Workbench 根目录
[`config/workspace-apps.json`](../../config/workspace-apps.json) 配置。不同环境通过 `WORKSPACE_PROFILE` 选择路径，不在本包重复配置。

新增知识库时至少配置：

```json
{
  "id": "team-knowledge",
  "workspace_alias": "team-knowledge",
  "enabled": true,
  "connections": {
    "local-windows": { "type": "filesystem", "path": "../team-knowledge" }
  },
  "portal": {
    "enabled": true,
    "group": "technical",
    "access": "authenticated",
    "tree_root": "wiki/features"
  }
}
```

技术知识若支持 `feature-manifest-v1`，还需配置 `query.content_root` 与 `query.project_targets`。迁移案例使用 `portal.group=migration`，运行时直接扫描其 Markdown，不生成本包内索引文件。

## 查询顺序

1. `kb_knowledge_search/read` 或 `get_feature_context`：读取 L1 业务知识和精确代码地图。
2. `kb_wiki_search/read`：按需读取迁移案例，案例只作为历史证据。
3. `kb_codegraph_*`：查询实时符号、调用方、被调方和影响面。
4. L1/L2 不足时，再在已授权源码范围内读取原始源码。

禁止先扫描整个知识库或源码仓。已拿到 `doc_ref`、`feature_id` 或类 FQN 时，应直接走对应索引和精确读取。

## 常用命令

从 Workbench 根目录执行：

```bash
npm run kb:validate
npm run kb:test
npm run kb:codegraph-init
npm run kb:codegraph-sync
npm run kb:setup
```

远程服务：

- `kb-mcp-for-zc`：鉴权访问业务知识、迁移案例、Android CodeGraph 与受控源码。
- `kb-mcp-for-codegraph`：只提供 Android/Harmony CodeGraph，不读取业务知识或源码。

## 协作

本目录随 Workbench 单仓开发和发布，遵守仓库根 [`AGENTS.md`](../../AGENTS.md) 与
[开发规范](../../docs/engineering/development.md)。迁入来源记录见 [`SOURCE.md`](SOURCE.md)。

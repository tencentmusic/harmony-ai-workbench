# 项目配置设计

字段与示例见[接入指南](../engineering/integrations/android-external-app-repos.md)。

## 模型

```text
workspace-apps.json
├── runtime                         Profile 选择
├── shared_knowledge_bases[]         共享连接、查询、门户与同步
└── projects[]
    ├── sources.android/harmony     路径、分支、基线、别名与内嵌仓
    ├── apps[].scope                App 模块范围
    ├── apps[].cloud_agent          转译执行与交付
    └── knowledge[]                 共享引用或专属知识
```

## 约束

- `@kugou/workspace-config` 是统一解析入口；各业务使用解析结果，不重复维护源码路径环境变量。
- 独立项目和多 App 大仓共用同一模型。大仓共享 sources，各 App 固定 modules。
- Profile 同时选择源码 locations 与知识 connections；路径相对工作台根目录解析。
- ID 和 alias 保持稳定，别名冲突拒绝；配置漂移不能静默改变已有任务的证据来源。
- KB 模块清单只放领域、模块与图谱元数据，源码路径、分支和基线从项目配置补齐。
- knowledge 引用、query targets、门户展示和 Token 源码授权分别处理，不能互相推导授权。
- 新提供方需要适配器，不能仅登记路径就声称具备检索能力。
- Repo Sync 从资源 sync 派生清单；工作台自身更新单独配置，不混为业务项目。

## 验证

- 独立仓与多 App scope、缺端、别名冲突、内嵌仓及 Profile 切换。
- 项目、Agent 工作区、类索引、CodeGraph 与同步清单解析一致。
- 新知识源的查询能力、target 隔离、门户和源码权限分别验证。

命令：`npm run validate:workspace-apps`、`npm run test:workspace-apps`、
`npm run test:integration-projects`、`npm run test:repo-sync`、`npm run kb:test:codegraph-config`。

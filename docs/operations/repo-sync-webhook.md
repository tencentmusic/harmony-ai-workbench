# Webhook 自动同步与部署

GitLab Push / MR 合入事件经鉴权后，触发匹配仓库与分支的同步。记录可在管理后台「自动更新记录」查看。

## 配置

| 内容 | 位置 |
| --- | --- |
| 源码与外部知识源 | `workspace-apps.json` 中各资源的 `sync` |
| 大仓内嵌仓 | `nested_repositories[].sync` |
| 工作台自身 | `config/repo-sync.json` 的 `workbench_repository` |
| 环境目录 | `WORKSPACE_PROFILE` |
| 回调密钥 | `REPO_SYNC_WEBHOOK_SECRET` |

GitLab 回调地址为 `<工作台地址>/api/webhooks/repo-sync`，填写与环境一致的 Secret，
开启 Push events 和 Merge request events。每个监听仓库或 Group 配置回调。

## 执行过程

```text
鉴权与匹配 → 持久队列 → 按仓库互斥同步 → 更新索引或执行部署 → 保存审计记录
```

| 资源 | HEAD 变化后的动作 |
| --- | --- |
| Android / HarmonyOS 源码 | 拉取对应分支，重建受影响类索引，增量同步 CodeGraph |
| 内嵌仓 | 更新子仓和所属项目索引 |
| 外部业务知识库 | 拉取内容，运行时读取最新 manifest；不自动生产知识 |
| 迁移案例库 | 拉取内容，门户直接读取文档与资源 |
| 内置 KB | 随工作台更新，不独立 clone / pull |
| 工作台 | 按配置以分离进程执行自动部署 |

只有配置了 `deploy_on_change` 且 HEAD 变化时才运行部署命令。CodeGraph 使用 onlyStale 增量更新，不执行 produce。

## 运行与故障处理

Worker 为 `harmony-workbench-repo-sync-worker`，由开发栈或生产部署启动。

```bash
pm2 logs harmony-workbench-repo-sync-worker
npm run test:repo-sync
```

- 队列在 `data/repo-sync/queue`，重启可继续消费；同路径、分支短时去重，同目录不并行更新。
- 同步先检查已跟踪改动；存在非保留项时返回 `working_tree_dirty`，拒绝覆盖。
- `preserve_local_files` 中的文件先备份再恢复；未跟踪文件仍可能导致 Git 路径冲突。
- 工作台自部署排在队列末尾，避免重载 Worker 打断当前同步。
- 后台支持手动入队和补跑索引；鉴权失败查 Secret，未匹配查仓库与分支，执行失败查记录与 Worker 日志。
- 转译 MR 建单和源码同步使用独立收件与去重规则，不能用同步完成代替建单成功。

部署要求见[开发规范](../engineering/development.md)，资源配置见[源码项目与知识库项目接入](../engineering/integrations/android-external-app-repos.md)。

# 转译台运行与恢复

开发使用 `npm run dev:stack`，生产由 `npm run deploy` 管理 `harmony-cloud-agent-worker`。
Worker 单实例，与 Web 使用同一个 SQLite；不跨机器共享库文件。

## 环境

| 变量 | 作用 / 默认 |
| --- | --- |
| `SUB2API_API_KEY` | 模型凭据 |
| `CLOUD_AGENT_CONCURRENCY` | 默认 2，可降到 1 |
| `CLOUD_AGENT_HARNESS_ROOT` | 含 `START_HERE.md` 的 Harness 工程 |
| `CLOUD_AGENT_HARNESS_PYTHON` | Windows 默认 python，其他平台 python3 |
| `CLOUD_AGENT_RUNTIME_ROOT` | 缓存、锁和档案，默认 `.runtime/cloud-agent` |
| `CLOUD_AGENT_WORKTREE_ROOT` | 源码工作树；Windows 建议短路径 |
| `CLOUD_AGENT_MATERIAL_ROOT` | 原材料目录，Web 与 Worker 共用 |
| `CLOUD_AGENT_FFMPEG_BIN` / `CLOUD_AGENT_FFPROBE_BIN` | 媒体工具，默认从 PATH 查找 |
| `DEVECO_HOME` / `DEVECO_SDK_HOME` | DevEco 与 SDK 根 |
| `CLOUD_AGENT_MIN_FREE_GIB` | 新建工作区与构建前磁盘下限，默认 5 |

模型、通知与 Webhook 密钥放环境文件。执行机配置源码读取、交付分支和知识分支写入权限。
部署前核验 OpenCode、Harness Python/视觉依赖、FFmpeg、构建工具与 HDC；依赖失败不靠重试任务修复。

`npm run deploy` 在重启前按 Harness 的 `requirements.txt` 准备 `.runtime/harness-venv`，执行 `pip check`、Harness `doctor` 和视觉预检，并持久化解释器路径。显式指定的外部 Python 只校验、不自动修改；同时核验当前 Profile 的 DevEco、Hvigor、HDC 与 SDK 路径。预检失败保留当前服务，结果见 `.runtime/deploy-preflight.json`。

部署同时核验 FFmpeg / FFprobe；macOS 缺失时通过 Homebrew 安装，将绝对路径传入 PM2。重启后检查 Worker 的实际 Python 和媒体工具路径；模拟器在线状态由任务验收核验。

## 日常检查

```bash
npm run cloud-agent:ops -- status
pm2 logs harmony-cloud-agent-worker
npm run cloud-agent:smoke:runtime
```

`status` 查看异常收件、运行和通知。`smoke:runtime` 使用本地模型响应，不证明真实网关或设备验收通过；
`smoke:live` 会调用真实模型并消耗额度。

## 恢复命令

所有命令使用 `npm run cloud-agent:ops -- <命令>`：

| 命令 | 用途 |
| --- | --- |
| `retry-inbox <收件ID>` | 重试失败收件 |
| `retry-notification <通知ID>` | 配置修复后重试通知 |
| `recover-run <运行ID>` | 核验停止后恢复运行状态，不自动执行任务 |
| `confirm-child-stopped <运行ID> <收据相对路径> <SHA256> <依据>` | 登记真实子进程停止依据 |
| `resume-ui-review <运行ID>` | 人工决定已保存、原生登记明确失败且材料未变时重试登记 |
| `reconcile-ui-review <运行ID>` | 原生已批准但 journal / outcome 未写完时对账 |
| `reconcile-acceptance-idle <任务ID> <attemptId>` | 依据真实停止收据核减验收停机时段 |
| `relocate-worktree <任务ID> <绝对短路径>` | 迁移同一任务工作树 |

`recovery_required` 时先核对主进程、独立实例、原生子进程和未决操作，再恢复。
未知副作用不得重放；不要直接改数据库、删除锁或修改历史收据。恢复后通过页面继续原任务，不重新分析已批准需求。
命令不可用时先核对已部署 release，不能用手工改状态代替。

网页进程退出只恢复网页；主动停止完整开发栈会停止其子进程。
工作树迁移前停止任务执行与相关 Hvigor 进程，保留分支、未提交源码和审批；迁移中断使用相同参数恢复。
Hvigor 绝对路径缓存需重建，OHPM 在新构建目录重新安装。

## 产物与材料

- 自动归档仅处理空闲任务里超过保留期、构建已结算且无路径引用的 `execution/build-*/previous-*.hsp`。
- 当前包、截图、录屏、审批、日志和会话不在白名单；运行中或待恢复任务不能归档。
- `CLOUD_AGENT_ARTIFACT_RETENTION_DAYS` 默认 7，范围 0–3650；`CLOUD_AGENT_ARTIFACT_AUTO_ARCHIVE=0` 关闭自动维护。
- `artifact-archive` 与 `artifacts` 一起备份；归档不自动永久删除，恢复遇到不同内容拒绝覆盖。

```text
npm run cloud-agent:ops -- artifacts-preview <任务ID> [保留天数]
npm run cloud-agent:ops -- artifacts-archive <任务ID> <preview摘要> [同一保留天数]
npm run cloud-agent:ops -- artifacts-list <任务ID>
npm run cloud-agent:ops -- artifacts-restore <任务ID> <归档ID>
```

内容变化必须重新 preview。材料原件默认在 `data/cloud-agent/materials`；未绑定暂存 24 小时回收，上传残留 10 分钟回收。
单用户暂存最多 30 个或 500 MiB，全局最多 4 个同时上传。代理请求体上限至少 100 MiB、上传等待不少于 190 秒。
媒体仅处理本地文件，不读取远程 URL。

[交付与设备配置](cloud-agent-delivery.md) · [设计约束与回归入口](../specs/cloud-agent.md)

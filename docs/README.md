# 文档目录

## 一、功能

每篇功能文档均包含 SVG 架构或流程图、使用步骤及关键边界；先看图了解关系，再查配置细节。

| 文档 | 用途 |
| --- | --- |
| [项目总览](../README.md) | 全景架构、模块职责、研发流程、灵活配置、运行架构与启动部署 |
| [AI 员工](features/ai-employee.md) | 源码问答、知识上下文、会话与权限 |
| [知识库](features/knowledge.md) | 业务知识、CodeGraph、迁移案例与门户 |
| [转译台](features/cloud-agent.md) | 查证、审核、转译、验收、确认提测和知识回流 |
| [集成台](features/integration.md) | 分支提测、审查报告、测试与合入协作 |
| [平台管理](features/platform-management.md) | 权限、数据看板、请求审计、自动更新与部署记录 |
| [包体对比](features/package-comparison.md) | 两份 APP 或 HAP 的体积差异、审核和导出 |
| [图片压缩](features/image-compression.md) | 图片无损压缩、体积对比和结果下载 |
| [迁移案例](features/migration-case-authoring.md) | 新增迁移案例的目录、Skill 和验收 |

## 二、工程

| 文档 | 用途 |
| --- | --- |
| [工程架构](engineering/architecture.md) | 运行进程、代码分层、四条主链路、存储与恢复；附运行、分层和转译执行图 |
| [开发规范](engineering/development.md) | 编码约束、提交、部署和验证 |
| [源码项目与知识库项目接入](engineering/integrations/android-external-app-repos.md) | Android / HarmonyOS 仓库、App 范围、知识库引用与门户发布；附接入图和配置节选 |

## 三、运行

| 文档 | 用途 |
| --- | --- |
| [源码 Webhook](operations/repo-sync-webhook.md) | 源码和知识库更新后的同步与重建 |
| [转译台运行](operations/cloud-agent.md) | 进程、环境变量、恢复和产物归档 |
| [转译台交付](operations/cloud-agent-delivery.md) | 提测交接、通知、构建路径和设备配置 |

## 四、模块设计

计划与规格按模块合并，每个模块仅维护一篇。使用步骤查上方功能与运行文档，设计文档只保留约束和验证范围。

| 文档 | 范围 |
| --- | --- |
| [转译台](specs/cloud-agent.md) | Harness、任务与审批、审查、设备结论、交付与归档 |
| [项目配置](specs/workspace-project-bundles.md) | 项目、App、知识源、Profile 与同步配置 |
| [知识库](specs/knowledge.md) | 运行包、内容来源、检索协议与门户权限 |
| [AI 员工](specs/ai-employee.md) | BFF、OpenCode、上下文、流式输出与会话 |
| [集成台](specs/integration.md) | 状态、Git 快照、报告执行、恢复与清理 |

文档维护当前生效行为；实现过程与历史版本通过 Git 查询，不重复保存日期计划和测试记录。

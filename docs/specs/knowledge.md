# 知识库设计

使用见[知识库](../features/knowledge.md)，内容生产见[迁移案例编写](../features/migration-case-authoring.md)。

## 内容与运行边界

- `packages/android-harmony-kb` 提供 MCP、上下文组装、CodeGraph 与遥测，由根 npm workspace 管理。
- 业务规则与 code_map 来自项目绑定的 manifest 知识源；案例由外部内容仓维护，不复制进工作台。
- 当前实现事实以源码核验，业务规则与迁移经验分别保留来源，不用案例覆盖当前配置。
- 内置包随工作台更新；外部知识仓按 sync 拉取。运行时不执行知识仓的生产脚本。
- feature context 与 counterpart 使用当前 manifest/code_map；无覆盖时明确缺项，不回退旧关系库猜测。

## 检索协议

`project/target → catalog 或 symbols → Feature route shard → 文件#章节`。

显式文档路径和 FQN/member 优先于模糊业务词。仅返回命中章节和有限路由信息，
不足时再查 CodeGraph 与 scope 内源码；不得扫描或注入全库作为默认兜底。
新适配器必须提供“定位”和“按引用读取”两阶段能力。

## 门户与权限

- 技术知识和迁移案例按提供方分组，登录后可浏览完整发布目录。
- `content_root` 限定资源读取根，`tree_root` 决定目录展示起点；正文链接可读取内容根内其他资源。
- `path_targets` 只为问 AI 选择 App；源码权限仍由 Token scope 校验。
- 查询 `project_targets` 不裁剪门户目录，门户可见也不代表获得对应源码权限。
- 图片和附件通过鉴权接口读取，保持原文件名与相对引用，拒绝越界路径。
- 搜索结果带上下文并联动目录；文档和选区问 AI 保留来源信息。

## 验证

覆盖知识未命中、缺端、精确章节路由、target 隔离、门户登录、资源路径、
搜索定位、App 路由及外部知识更新。

命令：`npm run test:knowledge-portal`、`npm run test:knowledge-access-security`、
`npm run kb:test:knowledge-sources`、`npm run test:migration-case-links`。

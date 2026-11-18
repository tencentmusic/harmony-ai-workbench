# Knowledge 模块规则

- 文档目录、正文、搜索和资源都必须先解析已启用的门户知识源，再访问文件系统。
- `portal.access=authenticated` 的共享知识库只校验登录身份，不使用 `appScopeId` 裁剪内容。
- `portal.path_targets` 仅用于给 AI 推导源码 App 范围，不能作为知识文档的授权边界。
- `canonical` 是当前业务知识，`evidence` 只能作为迁移案例参考。
- 只允许访问知识源根目录内的已登记 Markdown 和其相对资源，禁止路径穿越。
- API Route 仅调用 `public.ts`，文件扫描和索引逻辑留在本模块。

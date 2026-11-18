# AI 员工设计

使用见[AI 员工](../features/ai-employee.md)，模型与服务配置见 [OpenCode](../../runtime/opencode/README.md)。

## 请求链路

`浏览器 → BFF 鉴权与上下文 → OpenCode 会话 / 工具循环 → 模型网关 → SSE`。

- 工作台负责 Token、App scope、同源校验、请求审计与浏览器状态。
- OpenCode 负责会话、多轮上下文、压缩和工具调用；工作区 alias 由项目配置生成。
- 服务端实例只读，拒绝业务写入、任意 Shell 和敏感环境文件；代码建议以草稿返回。
- 模型、会话与工作区身份必须匹配，失配时按规则重建会话，不混用旧模型状态。

## 上下文与流式输出

- 优先使用已定位的业务正文与 code_map；内容不足时按范围查 CodeGraph 或源码。
- 文档问 AI 携带来源与选区，不能因文档路由扩大源码权限。
- 文本增量即时转发，快照只补新增部分；断流不重复正文。
- 实时和历史界面只显示正文与执行说明，reasoning 元数据不单独渲染或混入正文。
- 超时中止会话，部分回答标记未完成；取消、断流和会话切换分别处理。
- 埋点以实际调用与命中为准，不用裸源码扫描冒充知识命中。

## 验证

覆盖鉴权与 scope、类定位、精确知识注入、附件与资源、模型切换、
SSE 增量/去重、超时、取消和历史恢复。

命令：`npm run test:opencode-stream`、`npm run test:opencode-knowledge`、
`npm run test:opencode-session-continue`、`npm run test:chat-attachments`。

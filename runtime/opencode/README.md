# OpenCode Runtime

本目录提供普通聊天和集成任务的 OpenCode 配置模板。部署方必须通过环境变量提供模型网关、密钥、工作目录和服务密码；仓库不包含任何真实主机、账号或凭据。

## 本地使用

1. 复制根目录 `.env.example` 为 `.env.local` 并填写本地配置。
2. 将 `OPENCODE_BASE_URL` 和 `OPENCODE_INTEGRATION_BASE_URL` 指向本机受保护的 OpenCode 服务。
3. 将 `CLOUD_AGENT_MODEL_BASE_URL` 或 OpenCode 配置中的模型网关地址改为部署方地址。
4. 使用 `npm run dev:stack` 启动工作台和本地 OpenCode 实例。

OpenCode 服务默认只监听回环地址。需要远程调试时，请使用受控的 SSH 端口转发或反向代理，并保持原始 OpenCode API 不直接暴露。

## 配置文件

- `opencode.global.json`：普通聊天模板。
- `opencode.integration.json`：集成任务模板。
- `start.template.sh`、`deploy.sh`：进程启动与部署入口。

模板中的模型网关使用 `model-gateway.example` 占位域名，发布环境必须显式替换；密钥只允许来自环境变量。

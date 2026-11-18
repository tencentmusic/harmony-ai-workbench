# 转译台交付配置

## 交接规则

代码审查与构建通过后，设备执行形成“通过”或“未完成”结论，发布特性分支并通知开发本地复核。
开发确认提测后才幂等创建集成单，不自动创建或合并代码 MR。

| 设备结论 | 分支材料与后续 |
| --- | --- |
| 严格通过 | 保留 Harness 四文档；代码合入核实后生成知识 MR |
| 未完成 | 归档真实结论、缺项与报告摘要；开发接手复核，不生成宣称通过的四文档或知识 MR |

结论绑定材料版本、源码 HEAD、当前构建及原始报告摘要；报告或源码变化必须重新核验。
视觉差异批准只覆盖对应包和状态，不能改写自动失败分数或代表功能通过。

代码合入核验允许原交付提交的后继提交，但须匹配仓库、源/目标分支、鉴权事件与 Git 历史。
知识回流使用实际合入版本；知识 MR 按严格快照核验，不自动合入。新范围另建任务。

## 执行配置

App 的 `cloud_agent.execution` 提供默认参数，`execution_profiles.<profile>` 按 build、device、delivery 整块覆盖。

```json
{
  "execution": {
    "delivery": {
      "enabled": true,
      "transport": "ssh-webhook",
      "knowledge_mode": "feature-wiki",
      "knowledge_id": "business-wiki",
      "knowledge_branch": "master",
      "knowledge_path": "android_wiki",
      "knowledge_targets": ["example.android", "example.harmony"]
    }
  },
  "execution_profiles": {
    "local-windows": {
      "build": {
        "cwd": "apps/example",
        "artifact": "apps/example/entry/build/default/outputs/default/entry-default-signed.hap",
        "command": ["C:/Program Files/Huawei/DevEco Studio/tools/node/node.exe", "C:/Program Files/Huawei/DevEco Studio/tools/hvigor/bin/hvigorw.js", "assembleHap", "--mode", "module", "-p", "module=entry@default", "-p", "product=default", "-p", "buildMode=debug"],
        "timeout_seconds": 1800
      },
      "device": {
        "hdc": "C:/Program Files/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe",
        "target": "EMULATOR-ID",
        "executor": "native"
      }
    }
  }
}
```

示例路径、App、设备 ID 与知识目标需替换为实际值；命令使用 argv 数组。
`cwd`、`artifact` 相对任务鸿蒙根目录。非默认安装设置 `DEVECO_HOME`，
`DEVECO_SDK_HOME` 指向含 `default/` 的 SDK 根；空闲时重启 Worker 加载配置。

## 构建与设备

- 多包工程在 `build.dependencies` 列出 HSP，相应产物必须来自本次构建。
- Node 依赖用 `build.node_packages`；有 lock 使用 npm ci，无 lock 须显式 `allow_unlocked`，禁安装脚本。
- Windows 可设置 `build.cache_root` 短目录；产物默认从 worktree 读取，确实输出到缓存时才设 `output_root: cache`。
- 编译退出 0 不代表新包有效；缺签名包且日志确认增量签名跳过时只追加一次非增量构建，保留两次记录。
- `device.executor: native` 使用内置执行器；外部执行器使用 `descriptor` 与 `descriptor_sha256`，两种方式互斥。
- 不填 target 时只在恰好一个设备连接时选用。设备操作互斥，收据绑定当前安装与构建。
- **鸿蒙模拟器不支持通过 HDC 调用系统录屏服务**；使用截图、日志与连续画面证据，不重复失败后端录屏。
- 静态截图不证明连续播放；`frame_motion` 需要连续真实帧与独立复核，不证明音频或失败回退。
- 普通提示弹窗按当前控件证据关闭；业务所需交互按已批准范围执行，不能仅按按钮文案拒绝。
- 不确定动作先核对原操作与收据，不换 ID 重放。缺 fixture、功能失败、视觉待决定如实进入未完成结论。

Android 对照可选，配置 `execution.android_reference` 的 adb、package 和 target；默认验收使用配置的鸿蒙模拟器。
分支资料默认写到 `docs/migrations/<App>/<任务>/`，可通过 `cloud_agent.documents_path` 设置 docs 下的目录。
严格通过后的 `feature-wiki` 回流写入业务知识仓，不把四文档整包搬到迁移案例仓。

部署环境的 Node、Hvigor、HDC、SDK 和设备由使用者通过私有 profile 配置；开源包不包含具体机器路径、设备名称或测试服信息。

## 通知与凭据

| 变量 | 用途 |
| --- | --- |
| `CLOUD_AGENT_WECOM_WEBHOOK` | 企微机器人地址 |
| `CLOUD_AGENT_WECOM_USERS` | 工号到 userId 或 mobile 的 JSON 映射 |
| `CLOUD_AGENT_WECOM_DEFAULT_USER` / `CLOUD_AGENT_WECOM_DEFAULT_MOBILE` | 无创建人或映射时的联系人 |
| `CLOUD_AGENT_PUBLIC_URL` | 任务处理链接 |
| `REPO_SYNC_WEBHOOK_SECRET` | 鉴权仓库事件 |

通知只带任务、待办和登录链接；不带源码、日志或密钥，不支持 @all。
Outbox 去重，失败最多 6 次，缺配置不消耗次数；修复后通过[运维入口](cloud-agent.md#恢复命令)重试。
环境加载器读取第一个可用文件，避免不完整的 `.env.local` 遮蔽 `.env`。

`ssh-webhook` 使用执行机 SSH 和鉴权 MR 事件；模型不持有这些凭据。未收到合入事件时从 GitLab 重发，
不能仅凭远程分支存在判断 MR 已合入。

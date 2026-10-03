# @deepseek-ai/dsh-speech-settings

[English](README.md) | 中文

语音输入的根属设置命名空间：`$DSH_HOME/settings.yaml`（热重载）中的 `speech` 小节持久化识别器选择、语言提示、按住说话键、本地模型精度与云端 API key —— 且每次提交都推入 `ctx.speech`，消费方与提供方读取同一个实时偏好来源。

## 字段

| 字段 | 模式 | 默认值 |
| --- | --- | --- |
| `recognizer` | `'off' \| 'sensevoice' \| 'openai-compatible'` | `'off'` |
| `language` | 字符串（2–35） | 未设（自动检测） |
| `pushToTalkKey` | 字符串（1–32），界面侧转小写 | 未设（手势停用） |
| `modelVariant` | `'int8' \| 'fp32'` | `'int8'` |
| `apiKey` | 字符串，`role('secret')` —— 所有线上视图均只写 | 未设 |

命名空间以 `applies: 'live'` 注册并带组合 `base` 层（插件自身的 cordis.yml 配置），覆盖层可固定部署默认值而用户编辑优先。插件 `inject` `['settings', 'speech']`；桥接 effect（`scope.watch → ctx.speech.configure`）随插件 fiber 存续，命名空间注销即停止推送。

Web 客户端经 `settings.describe` / `settings.mutate` 访问该命名空间（网关的 `WEB_SETTINGS_NAMESPACES` 白名单已列 `'speech'`），因此「设置 → 语音输入」分区与插件页编辑同一份文档。

## Model Experience

### 识别器偏好持久化

#### What the model sees

命名空间存储哪个 `recognizer` 响应 `speech.transcribe`；模型从不读取该设置。

#### Token effect

无；识别器不贡献任何 token——只有其返回文本可能进入草稿。

#### KV Cache effect

无；本包不组装也不发送提供方请求。

## Known Limitations and Deferred Work

- **识别器 id 是闭合的 schema 联合** — 新提供方需在其包旁同步修改本 schema；开放 id 联合会把拼写错误当成静默失效的选择。
- **单一全局密钥** — 按会话或按提供方的凭据与云提供方的多网关工作一同推迟。

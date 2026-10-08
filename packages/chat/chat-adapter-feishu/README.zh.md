# `@deepseek-ai/dsh-chat-adapter-feishu`

[English](README.md) | 中文

统一聊天适配器注册表（[契约](../chat-adapter/README.md)）的飞书/Lark 提供方。它是函数插件（`name`、`inject`、`Config`、`apply`，无默认导出），注入 `chatAdapters` 和 `credentials`，注册飞书平台描述符，并为每个已配置的应用注册一个适配器。事件经平台的出站长连接到达，因此不需要公网入口。Open API 使用纯 `fetch`，长连接使用 `ws`；官方 SDK 不是依赖。长连接协议遵循 `@larksuiteoapi/node-sdk` 1.73.0，事件接线遵循 dsh-im，二者均为 MIT（[声明](../../../THIRD_PARTY_NOTICES.md)）。

## 配置

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apps[].appId` | string | — | 应用 id，`cli_` 加字母数字。它成为适配器的 `botId`。必填。 |
| `apps[].secretRef` | string | — | 保存应用 secret 的凭据引用。必填。 |
| `apps[].domain` | string | `https://open.feishu.cn` | Lark 使用 `https://open.larksuite.com`。 |

`apps: []` 是合法配置，只注册平台描述符。挂载时会拒绝格式错误的应用 id 或未设置的 secret。每次获取 tenant token 时都会重新解析 secret，因此轮换后的 secret 在下一次 token 刷新（token 有效期两小时）时生效，无需重启。

## 平台描述符

行挂载时，`feishuDescriptor`（`platform: feishu`，label 为 `飞书`）经 `ctx.chatAdapters.registerPlatform` 注册，因此宿主无需 `apps` 条目即可列出、校验和挂载飞书应用。它声明三个字段：

| 字段 | Secret | 说明 |
|---|---|---|
| `appId` | 否 | 必填。`cli_` 加字母数字；它成为 `botId`。 |
| `appSecret` | 是 | 必填。 |
| `domain` | 否 | 可选，在 `https://open.feishu.cn`（飞书（中国），留空时的默认值）与 `https://open.larksuite.com`（Lark（国际））之间选择。 |

`probe` 先在发出任何请求之前，以 `auth-failed` 拒绝格式错误的应用 id 或空白 secret，再用已输入的 secret 获取 tenant token，并读取 `GET /open-apis/bot/v3/info`（适配器连接时发出的同一调用），因此该调用的拒绝会在探测时暴露，而不是等到首次连接。`botId` 解析为应用 id，`displayName` 解析为机器人的 `app_name`，否则为应用 id。失败的分类与连接一致：凭据被拒为 `auth-failed`，429 为 `rate-limited`，其余（包括中止、平台的其他拒绝（保留平台的消息），以及不在两个选项内的 `domain`）为 `network`。secret 从不出现在错误消息中。

`mount` 是 `apps` 列表中单个应用的挂载过程。secret 从 `secretRefs.appSecret` 指名的凭据解析，失败情形同上，另加缺少 `secretRefs.appSecret`。

## 行为

- **连接。** 一次 `run` 通过 `POST /callback/ws/endpoint` 发现 WebSocket 端点、建立连接，按平台间隔发送 ping（每个 pong 会更新该间隔），并按 `message_id` 重组分片事件。事件在桥接受之后，或 2.5 秒后（以先到者为准），以原帧加结果码确认。静默的连接在三个 ping 间隔后被丢弃。会话意外结束时 `run` 以 `network` 拒绝，桥按自身退避重连。
- **入站。** `im.message.receive_v1` 变成 `message`：文本、富文本（已拉平）、图片和文件（附件 id 形如 `<messageId>:<resourceKey>:<image|file>`）。私聊消息总是指向机器人；群消息在提及本机器人时才指向机器人。机器人自己的提及会从 `controlText` 中移除。`card.action.trigger` 变成携带按钮 action id 的 `interaction`。其他事件类型被丢弃。
- **出站。** 每条文本都是 `lark_md` markdown 卡片，因为飞书限制纯文本消息的编辑次数，却允许反复更新卡片。编辑是对卡片的 `PATCH` 更新；已完成的提示会变成不带按钮的卡片。向用户 id（`ou_…`）发送时使用 `receive_id_type=open_id`，向聊天 id 发送时使用 `chat_id`，因此桥无需事先存在的聊天即可联系 owner。文件经 `im/v1/files` 上传并作为文件消息发出，上限 30 MiB。
- **不支持。** 飞书没有输入中指示，本适配器也不使用话题线程。

## 错误

| 情形 | Code |
|---|---|
| 凭据被拒（一次 token 刷新之后仍为 token 码 99991661、99991663、99991668；secret 码 10003、10012、10014；端点码 403 和 514；HTTP 401） | `auth-failed` |
| 端点码 1000040350（连接数上限） | `poll-conflict` |
| HTTP 429 | `rate-limited`，带 `x-ogw-ratelimit-reset` 提示 |
| HTTP 413，或消息表明文件过大或超出限制 | `file-too-large` |
| 连接或下载时的其他失败 | `network` |
| 发送或撤回时的其他失败 | `send-failed` |
| 更新卡片时的其他失败 | `edit-failed` |

`probe` 的分类与连接一致。格式错误的应用 id 和空白 secret 为 `auth-failed`。

## 测试状态

该适配器与描述符仅通过伪 Open API、伪套接字、回环 `ws` 服务端、录制形状的事件夹具和真实 Loader 组合验证（组合中由一个替身宿主探测并挂载受管应用）。帧编解码器与官方 protobuf 布局做了逐字节对比。从未使用真实的飞书应用。要启用它：创建带机器人的飞书应用，为消息接收和卡片回调启用长连接事件订阅，把应用 secret 存入凭据提供方，在桥的 profile patch 中设置 `apps: [{ appId, secretRef }]`，启动 `dsh chat`，并在与机器人的私聊中配对 owner。

## Model Experience

None, as this provider only moves text between Feishu and the bridge and registers no model context.

#### KV Cache effect

None; the adapter performs no model request.

## Known Limitations and Deferred Work

- 不消费表情回应、语音、视频、贴纸和聊天历史读取，也不解析发送者的显示名，因此群 prompt 的前缀使用 open id。
- 卡片 markdown 遵循飞书的 `lark_md` 方言；它不渲染的模型 Markdown 会按字面显示。
- 卡片回调不带聊天类型，因此按钮点击被报告为私聊交互。
- 只有应用拥有接收提及它的群消息的权限时，群聊提及才会到达机器人。
- 未实现 webhook 事件投递。

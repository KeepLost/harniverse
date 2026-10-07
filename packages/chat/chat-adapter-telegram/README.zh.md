# `@deepseek-ai/dsh-chat-adapter-telegram`

[English](README.md) | 中文

统一聊天适配器注册表（[契约](../chat-adapter/README.md)）的 Telegram 提供方。它是函数插件（`name`、`inject`、`Config`、`apply`，无默认导出），注入 `chatAdapters` 和 `credentials`，并为每个已配置的机器人注册一个适配器。它通过纯 `fetch` 调用 Bot API，不依赖第三方 SDK，以 `getUpdates` 向外轮询，不需要公网入口。请求构造、错误元数据和提及处理按 MIT 许可从 dsh-im 移植（[声明](../../../THIRD_PARTY_NOTICES.md)）。

## 配置

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `bots[].tokenRef` | string | — | 保存机器人 token `<bot id>:<secret>` 的凭据引用。必填。 |
| `bots[].pollTimeoutSeconds` | number | `25` | 服务端长轮询等待时间，1 到 50。 |
| `bots[].baseUrl` | string | `https://api.telegram.org/` | Bot API origin。 |

挂载时会解析每个 token 一次：凭据缺失或值不是机器人 token 会使挂载失败，数字前缀成为适配器的 `botId`。此后每次请求都会重新解析凭据，因此轮换后的 token 无需重启即可用于下一个请求。

## 行为

- **入站。** 消费私聊、群和超级群；丢弃频道消息和成员变更。消息 id 是 `<chatId>:<messageId>`，因为 Telegram 的消息 id 仅在单个聊天内唯一。`controlText` 去掉 `/cmd@bot` 后缀和 `@bot` 提及，使命令能干净地解析。照片（最大尺寸）和文档成为附件引用。
- **指向判定。** 私聊消息总是指向机器人。群消息在提及机器人、回复机器人，或以未指名机器人或指名本机器人的命令开头时视为指向机器人。
- **按钮。** 内联键盘的点击成为该消息所在聊天和线程上的 `interaction` 事件，每次点击都会被确认，使客户端停止转圈。超过 64 字节的 action id 在发送前被拒绝。
- **出站。** 文本以纯文本发出（`textFormat: plain`）并关闭链接预览；编辑是原位的，未变化的编辑视为成功；已完成的提示会被改写为最终状态并移除键盘；文件以文档形式上传，上限 50 MiB。下载在 20 MiB 的 Bot API 上限或调用方上限处停止，依据声明大小、`Content-Length` 以及流式过程三者判定。
- **偏移。** 下一次 `getUpdates` 偏移在桥接受该更新之后推进。桥处理某个更新时的失败会被记录并跳过，避免卡死循环；重启后的重放由桥的消息 id 去重吸收。

## 错误

| 情形 | Code |
|---|---|
| HTTP 401 | `auth-failed` |
| `getUpdates` 409（第二个轮询者） | `poll-conflict` |
| HTTP 429 | `rate-limited`，带平台的 `retry_after` |
| 413 或 “too big” | `file-too-large` |
| 轮询或下载时的传输错误或其他失败 | `network` |
| 发送时的其他失败 | `send-failed` |
| 编辑时的其他失败 | `edit-failed` |

## 测试状态

该适配器仅通过由录制形状夹具驱动的伪 Bot API 和真实 Loader 组合验证；从未使用真实的机器人 token。要启用它：把 token 存入凭据提供方（`dsh chat init` 会写出模板），在桥的 profile patch 中设置 `bots: [{ tokenRef: <name> }]`，启动 `dsh chat`，并在与机器人的私聊中配对 owner。机器人不能联系尚未启动它的用户。

## Model Experience

None, as this provider only moves text between Telegram and the bridge and registers no model context.

#### KV Cache effect

None; the adapter performs no model request.

## Known Limitations and Deferred Work

- 文本不带解析模式发送，因此模型输出的 Markdown 会按字面显示。
- 不消费语音、视频、贴纸、位置、表情回应和投票。
- 一次只向桥交付一个更新；处理缓慢会延迟其他聊天的后续更新。
- 未实现 webhook 投递；轮询要求没有其他进程轮询同一个机器人。
- 群聊提及只能在机器人隐私模式允许的范围内到达机器人；请关闭隐私模式，或在群里使用命令和回复。

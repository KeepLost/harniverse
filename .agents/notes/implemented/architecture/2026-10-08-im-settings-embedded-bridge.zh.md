# Agent Note: IM settings page and the embedded chat bridge

Status: implemented

[English](2026-10-08-im-settings-embedded-bridge.md) | 中文

## Problem

把 Telegram 或飞书机器人接入 Harniverse，需要运行 `dsh chat init`、手工编辑 `$DSH_HOME/profiles/chat/patch.yml`、把平台密钥保存为凭据，并另外保持一个长期运行的进程（见[聊天桥 Agent Note](2026-10-06-im-chat-bridge.md)）。这些操作在 web GUI 中都不可见：用户无法在产品里添加机器人、查看它是否已连接，也无法配对账号。

设置页需要一个 Host 侧的所有者，来管理独立 profile 分散在文件和命令中的状态：机器人列表、机器人密钥、桥的运行状态、owner 配对记录和桥的 Grant。页面与 Host 还必须不出现平台名称，这样第三个平台仍然只需要一个适配器包。

## Decision

web 组合承载聊天桥。Host 插件 `chat-manager` 拥有受管机器人的注册表，并在 web Host 进程内运行桥（“内嵌”）；浏览器插件 `ui-settings-im` 通过管理器提供的 `chatBots` Typert Remote 渲染设置分区“IM 机器人”。`dsh chat` 仍是以无界面方式运行同一个桥的途径。

本 Agent Note 取代[聊天桥 Agent Note](2026-10-06-im-chat-bridge.md) 的两处表述：其 Decision 中“桥不向 web 组合增加插件”，以及对“作为 web 组合中的插件”的否决。该 Agent Note 的其余部分依然成立。内嵌桥仍是 `/api` 的客户端，由一个 operator Grant 认证，准入仍默认拒绝，命令表仍是封闭的，聊天仍可通过 `dsh chat` 脱离 web UI 运行。

### 桥为什么运行在 Host 内

页面展示的是运行中的桥所掌握的信息：每个适配器是正在运行、重连、被拒绝还是冲突；桥状态中的配对码和已配对的 owner；以及创建 owner 会话时读取的每个机器人的默认值。桥把它们以 `ctx.chatBridge`（`adapterState`、`issueOwnerCode`、`owners`、`unpairOwner`、`useBotSettings`）的形式提供给同一进程内的插件。

web 组合中没有 `chat-harniverse-client` 或 `chat-bridge` 的行。当机器人或 owner 调用需要它们时，管理器把二者作为子插件作用域挂载，并为每个已启用的机器人再挂载一个子作用域，因此桥只在有工作时存在。

### 平台描述符

平台提供方通过 `ctx.chatAdapters.registerPlatform` 注册一个 `ChatPlatformDescriptor`：平台 id、中文的渠道名称、用户需要填写的 `fields`（每个字段是否为密钥、是否必填，并可带有封闭的选项列表）、`probe` 和 `mount`。`probe` 用一次平台调用校验用户输入的值，并返回机器人身份（Telegram 为 `getMe`；飞书为 tenant token 加机器人信息）。`mount` 在调用它的作用域内为一个受管机器人注册一个适配器，并通过凭据名称解析密钥。注册表会发出 `chat-platform/registered` 和 `chat-platform/unregistered`。

管理器和页面只读取描述符，因此渠道列表、接入表单以及添加和检查流程都不含平台名称，Host 上新增的平台无需修改客户端就会出现在页面中。Telegram 和飞书导出各自的描述符。web 组合中它们的提供方行保持 `bots` 和 `apps` 列表为空，所以机器人只来自注册表。

### 包拓扑

| 包 | 职责 |
| --- | --- |
| `packages/chat/chat-adapter` | 定义 `ChatPlatformDescriptor`、`ChatPlatformField`、`ChatBotIdentity` 和 `ChatManagedBot`；`ctx.chatAdapters` 注册并读取描述符，并发出 `chat-platform/*` 事件 |
| `packages/chat/chat-adapter-telegram`、`packages/chat/chat-adapter-feishu` | 导出带有 `probe` 和 `mount` 的描述符并注册它 |
| `packages/chat/chat-bridge` | 配置项 `embedded`、`ctx.chatBridge` 服务，以及 owner 会话的每机器人默认值 |
| `packages/chat/chat-harniverse-client` | 封闭的 endpoint 表包含 `session.selectModelTarget` |
| `packages/chat/chat-manager` | Host 插件 `ctx.chatManager`：注册表、只写密钥、桥 Grant、内嵌生命周期和 `chatBots` Remote |
| `packages/client/ui-settings-im` | 设置分区 `im`（order 21）：渠道列表、机器人卡片、已配对 owner、配对码 |
| `packages/host/apiproxy` | 注册线路错误码 `chat-bot-failed` |
| `packages/bundle/web-app` | 行 `chat-adapters`、`chat-telegram`、`chat-feishu`、`chat-manager`，以及浏览器行 `ui-settings-im` |

页面、Remote 和注册表见 [chat-manager README](../../../../packages/chat/chat-manager/README.md) 与 [ui-settings-im README](../../../../packages/client/ui-settings-im/README.md)；类型、方法表和错误映射见[聊天桥子系统页面](../../../../docs/subsystems/chat-bridge.md#chat-manager)。

### 生命周期

- 注册表 `$DSH_HOME/chat-bots.json`（权限 `0600`，经 schema 校验，最多 32 个机器人）在插件启动时加载，此时 web 服务器已开始监听。
- Host 启动时存在已启用的机器人、添加或启用机器人，以及 `issueOwnerCode` 或 `unpairOwner` 需要桥时，桥就会启动，因为 owner 在第一个机器人可用之前就需要配对码。
- 最后一个已启用的机器人被停用或移除时，桥按先机器人、再桥、最后其客户端的顺序停止。只为 owner 调用而启动的桥会一直运行，直到某个机器人被启用过、且最后一个已启用的机器人随后消失，或 Host 停止。
- 挂载时抛出错误的机器人处于 `error` 状态，不影响其他机器人。桥启动失败时，每个已启用的机器人和桥都显示为 `error`；下一次变更、owner 调用或 `retryBot` 会再次尝试。
- 另一个进程轮询同一个机器人时，该机器人变为 `error`。内嵌桥从不要求 Host 进程退出。
- 机器人的状态在每次 `snapshot` 时推导，因此页面每 3 秒轮询一次，无需事件。变更和 owner 调用一次执行一个；`snapshot` 不等待它们。

### 安全姿态

- **administer 能力。** `snapshot` 需要 `harniverse.observe`。其余所有 `chatBots` 调用都需要 `harniverse.administer`，它与已经保护 `credentials.set` 和远程主机注册表的是同一项能力，因为添加机器人会保存凭据，并打开一条通向 Host 的入站控制通道。
- **只写密钥。** 密钥字段保存为凭据 `DSH_CHAT_BOT_<BOT ID>_<FIELD>`，注册表只保存字段键。机器人视图携带 `{ configured, tail }`，其中 `tail` 是长度至少 16 个字符的密钥的最后四个字符，其他情况为空。任何响应、日志行、错误消息或注册表文件都不携带密钥值，也从不回显平台自己的错误文本。
- **封闭的失败原因。** 每个失败都是 RPC 错误码 `chat-bot-failed`，带有不含密钥的中文消息，`details.reason` 为 `invalid-input`、`invalid-credentials`、`unreachable`、`duplicate-bot`、`not-found` 或 `bridge-unavailable` 之一。
- **最小权限 Grant。** 首次启动时，管理器以幂等方式创建一把 P-256 签名密钥和一个名为 `chat-bridge` 的 API 客户端 Grant（已有 `dsh chat init` 写入的产物则复用），该 Grant 只持有 `harniverse.observe` 和 `harniverse.operate`。这个 Grant 与用户的其他 Grant 一起列出，用户可以在那里撤销它。
- **回环 origin。** 客户端 origin 由正在监听的 web 服务器推导：`http://127.0.0.1:<port>`，HTTPS 时为 `https://localhost:<port>`。它不可配置，所以签名后的挑战只会发往运行桥的那个 Host。
- **不支持旁路。** 以认证旁路运行的实例无法承载桥：管理器报告桥错误，且不创建 Grant。
- **仅 owner，默认拒绝。** 内嵌桥只配置 `embedded: true`。它没有配置的成员、workspace 别名或访问策略，所以只有通过一次性配对码完成配对的 owner 可以使用它，其他所有发送者都被忽略。
- **有界输入。** 管理器拒绝未知字段、超过 4096 个字符或含控制字符的值、不在封闭选项列表内的值，以及键以 `Url` 结尾的非密钥字段，除非它是不带用户名和密码的 `http:` 或 `https:` 地址。一次 probe 的时限为 15 秒。

### owner 会话的机器人默认值

机器人带有可选的默认值：workspace 目录（绝对路径）、模型及其推理强度，以及 Agent Preset。管理器每次桥启动时通过 `ctx.chatBridge.useBotSettings` 注册一个默认值提供方。它在每次调用时读取注册表，因此变更会应用到下一个创建的 owner 会话，无需重启机器人。桥只把默认值应用于 owner 会话；成员保留自己的授权、目录和 Profile。

模型在 `session.create` 之后立即用 `session.selectModelTarget` 选定，只对该会话生效。`session.selectModel` 还会把选择保存为 Host 的默认模型，新的 Web 会话由此起步；`session.selectModelTarget` 不改变该默认值。

### Testing

管理器的单元测试对照脚本化平台、内存凭据以及桥及其客户端的替身，运行真实的管理器。真实 Loader 组合测试启动真实的 web 服务器、认证提供方、凭据、存储域、适配器注册表、Telegram 提供方、管理器、内嵌桥和 HTTP 客户端；它对照脚本化的 Bot API 添加机器人、配对 owner，并把 owner 的第一条 prompt 转发给脚本化的 `/api`，由后者用真实挑战校验已配置的 Grant。

桥的测试固定服务方法、机器人默认值只对 owner 生效，以及会话级的模型选择。每个提供方的描述符都对照脚本化的平台服务器测试。`apps/web/tests/settings-im.e2e.ts` 在带 Grant 认证和回放模型的随附 web 组合上驱动浏览器设置页：先被拒绝、后被接受的接入、别名与 workspace 编辑、配对、送达平台的一轮对话、取消配对，以及移除。

## Alternatives considered

**由管理平面监管 `dsh chat`。** Host 会写入 chat profile 的 patch，并启动、停止和监视一个 `dsh chat` 进程。patch 会替换行的整个 config，所以每次机器人变更都要重写文件，并重启服务所有机器人的那个进程。页面仍需要第二条通向该进程的通道，来获取适配器状态、配对码、owner 和默认值。内嵌桥通过 `ctx.chatBridge` 读取同样的信息，不需要进程控制。

**用进程内客户端代替回环 Grant。** 内嵌桥可以直接调用 Host 的 API 对象，跳过 HTTP、Grant 签名和 origin。这样它会以 Host 自身的权限而不是 observe 和 operate 运行，从用户可撤销的 Grant 列表中消失，并把桥唯一的 `/api` 客户端（封闭的 endpoint 表、主体绑定、幂等键）分叉成 `dsh chat` 永远不会走到的第二条路径。回环 Grant 让两种部署共用一个客户端、一个最小权限身份和一条经过测试的路径。它的代价见 Consequences。

**每个平台一个客户端插件。** 为 Telegram 和飞书各做一个设置插件和 Remote，会重复注册表、密钥和生命周期代码，每增加一个平台就要新增一个 Host 包、一个 Remote 和一个 UI 包。描述符把一个平台化简为它的字段、`probe` 和 `mount`，满足原 Agent Note 的目标：再增加一个平台只需要一个适配器。

**用 `session.selectModel` 选择机器人的模型。** 机器人每次启动 owner 会话时，它都会覆盖 Host 的默认模型。`session.selectModelTarget` 只为一个会话选择。`/model` 命令仍使用 `session.selectModel`。

## Consequences

用户可以在设置中接入、检查、重试、停用和移除 Telegram 与飞书机器人，调整每个机器人的默认值，并配对 owner 账号；新平台的提供方注册描述符后，就会出现在页面中。

web Host 进程持有机器人凭据和长期的出站平台连接，而[聊天桥 Agent Note](2026-10-06-im-chat-bridge.md) 曾把它们挡在这个进程之外。只写密钥、每个变更都要求 administer 能力、最小权限 Grant 以及按机器人隔离的失败，限制了暴露面，但没有消除它：任何能够管理 Host 的人都可以添加机器人，从而为他们配对的账号打开一条通向 Harniverse 会话的聊天通路。

- 桥需要 Grant 认证和已完成的 owner 设备登录。使用旁路的实例无法使用 IM 机器人，撤销 `chat-bridge` Grant 会使运行中的桥无法登录，直到下一次桥启动注册新的 Grant。
- 当 HTTPS 监听器的证书不包含 `localhost` 时，内嵌客户端无法校验它，经桥转发的 prompt 会失败；不支持自定义 CA。
- 内嵌桥仅限 owner。成员、群聊、workspace 别名和访问策略仍是 `dsh chat` 的配置，页面没有群聊或成员管理。
- 配对记录与 `dsh chat` 相互独立：内嵌桥把它们保存在 web Host 的存储中，所以在一处完成配对的 owner 需要在另一处重新配对。`dsh chat run` 与内嵌桥不得轮询同一个机器人；桥会把冲突报告为机器人状态 `error`。
- 凭据不能原地轮换。用户需要移除机器人再重新添加；owner 配对记录得以保留，因为桥状态以平台和用户作为其键。
- 不包含飞书扫码创建机器人的接入流程（dsh-im 有此功能）；飞书机器人通过手工填写 App ID 和 App Secret 添加。
- 只有桥运行时才会列出 owner，所以所有机器人都停用时，已配对的 owner 不会列出，直到某个机器人被启用或某次 owner 调用启动了桥。
- Telegram 和飞书只对照脚本化的服务器验证过；尚无运行使用过真实的 bot token 或飞书应用。

chat-manager README 列出其余包级限制。

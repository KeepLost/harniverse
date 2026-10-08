# `@deepseek-ai/dsh-chat-manager`

[English](README.md) | 中文

设置页“IM 机器人”背后的 Host 插件。它持有受管 IM 机器人的登记表、只写的密钥，以及运行在 Web Host 进程内的[聊天桥](../chat-bridge/README.md)的生命周期，并提供设置页调用的 `chatBots` Typert Remote。服务是 `ctx.chatManager`，线上的命名空间是 `chatBots`。独立的 `dsh chat` 进程（[`chat-app`](../../bundle/chat-app/README.md)）是运行同一座桥的另一种方式，两者不能轮询同一个机器人。

## 组合

Web 组合挂载 `chat-adapters`、平台提供方行 `chat-telegram` 与 `chat-feishu`，以及 `chat-manager`。提供方行的 `bots` 或 `apps` 保持为空列表，因此只注册它们的[平台描述符](../chat-adapter/README.md#platform-descriptors)；机器人保存在下文的登记表中。组合中没有 `chat-harniverse-client` 或 `chat-bridge` 的行：需要时由管理器把两者作为子插件 fiber 挂载。服务注入 `chatAdapters`、`credentials`、`webServer`、`authentication` 与 `storageDomain`，因此在 Web 服务器开始监听之后才启动。

| 键 | 默认值 | 说明 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 存放 `chat-bots.json` 的 Harness 主目录。它必须与认证提供方使用的主目录相同，因为管理器把 Grant 登记到该提供方的 Grant 登记表中。 |

## 登记表

`$DSH_HOME/chat-bots.json` 是经过模式校验的文档（`version: 1`，最多 32 个机器人），经独占临时文件、`fsync` 与原子重命名写入，权限为 `0600`。写入逐个执行，一次写入失败不会破坏之前的文档，也不影响之后的写入。文件缺失视为空登记表；符号链接、超大文件或校验失败的文档会使插件在启动时失败，错误信息指出文件路径，不包含其内容。

每个条目保存机器人 id（`bot_` 加八位十六进制数字）、平台、别名、平台报告的身份（`botId`、`displayName`）、非密钥字段的值、密钥字段的键、`enabled`、新建所有者会话的默认值（见下文“机器人默认值”）、`createdAt` 与 `checkedAt`。密钥的值从不写入登记表。

## 密钥

机器人的密钥字段以 `DSH_CHAT_BOT_<机器人 ID>_<字段>`（大写）为名存入凭据库，例如 `DSH_CHAT_BOT_BOT_AB12CD34_TOKEN`。密钥只写：任何响应、日志行、错误信息或登记表文件都不含密钥。密钥字段的视图是 `{ configured, tail }`，其中 `tail` 是长度不少于 16 个字符的密钥的最后四个字符，更短的密钥则为空。Remote 没有轮换凭据的调用；要更换凭据，先删除机器人再重新添加。

## Remote API

除 `snapshot` 外，所有调用都要求 `harniverse.administer`，与 `credentials.set` 和远程主机登记表所用的能力相同：这些调用会存储凭据，并向 Host 打开一条入站控制通道。`snapshot` 要求 `harniverse.observe`。类型从 `@deepseek-ai/dsh-chat-manager/types` 导出。

| 调用 | 行为 |
|---|---|
| `snapshot()` | 可连接的平台及其字段、每个机器人及其实时状态、已配对的所有者，以及桥的状态。读取时不等待正在运行的变更。只有桥在运行时才列出所有者。 |
| `addBot({ platform, alias?, values })` | 按平台描述符校验各值，用一次 `descriptor.probe` 调用验证（15 秒上限），拒绝平台与 `botId` 已登记的机器人，存储密钥，写入登记条目并启动机器人。别名默认取平台报告的显示名。登记表写入失败会再次删除已存的密钥。 |
| `updateBot({ id, alias?, enabled?, settings? })` | 重命名机器人、启用或停用它，或修改它的默认值。`settings` 中给出的值表示替换，`null` 表示清除，缺省的键表示保持不变。启用或停用只会挂载或卸载该机器人自己的适配器。 |
| `checkBot({ id })` | 用已存凭据探测平台，刷新显示名与 `checkedAt`，返回 `{ ok, message?, checkedAt }`。平台失败表现为 `ok: false` 加固定的中文消息，不会抛出错误。探测返回了另一个 `botId` 也算失败。 |
| `retryBot({ id })` | 重新卸载并挂载一个已启用的机器人，并再次尝试启动失败的桥。 |
| `removeBot({ id })` | 卸载机器人，删除它的凭据，并移除它的条目。先删凭据，因此删除失败时条目仍在，可以重试。 |
| `issueOwnerCode()` | 由桥签发的一次性所有者配对码及其过期时间。 |
| `unpairOwner({ key })` | 移除一个已配对的所有者；键不存在或属于静态配置中的所有者时返回 `false`。 |

输入校验会拒绝未知或缺失的字段、超过 4096 个字符或含控制字符的值、不在封闭选项列表内的值、长度不在 1 到 64 个字符之间的别名，以及键以 `Url` 结尾、却不是不含用户名和密码的 `http:` 或 `https:` 地址的非密钥字段。

## 错误

每个失败都是线上代码为已注册的 `chat-bot-failed` 的 `RemoteError`；稳定的原因在 `details.reason` 中，中文 `message` 不含密钥。载体的错误词汇是封闭的，管理器自定的代码会使客户端的响应解析失败。

| 原因 | 触发条件 |
|---|---|
| `invalid-input` | 平台未知，字段、别名或设置值无效，工作区路径是相对路径，机器人数量达到上限，或重试已停用的机器人。 |
| `invalid-credentials` | 探测以 `auth-failed` 失败。 |
| `unreachable` | 其他任何探测失败，包括超时。平台自己的文本从不回显。 |
| `duplicate-bot` | 同一平台与 `botId` 已登记。 |
| `not-found` | 没有该 id 的机器人。 |
| `bridge-unavailable` | 所有者相关调用需要桥而桥无法启动；消息说明原因。 |

被取消的请求会重新抛出其中止信号，而不是映射为错误码。存储失败按普通错误传播。

## 桥的生命周期

桥的基础设施依次是 `chat-harniverse-client` 插件和带 `embedded: true` 的 `chat-bridge` 插件，后者从不请求 Host 进程退出。它在 Host 启动时已有已启用机器人、添加或启用机器人、以及 `issueOwnerCode` 或 `unpairOwner` 需要它时启动，因为所有者在第一个机器人可用之前就需要一个配对码。每个已启用的机器人是另一个子插件 fiber，它用非密钥值和各密钥的凭据名调用 `descriptor.mount`，因此释放该 fiber 只会注销这个机器人的适配器。

最后一个已启用的机器人被停用或删除时，桥按先机器人、再桥、最后客户端的顺序停止。只为所有者调用而启动的桥会保持运行，直到某个机器人被启用过、且最后一个已启用的机器人随后消失，或 Host 停止，因为配对码仍然保存在桥的状态中，但配对需要一个在线的机器人。挂载抛出错误的机器人处于 `error` 状态并带固定消息，不影响其他机器人。桥启动失败时，所有已启用的机器人和桥本身都显示为 `error`；下一次变更、所有者调用或 `retryBot` 会再次尝试启动。所有资源随插件作用域一起释放。

客户端的 origin：HTTP 的 Web 服务器为 `http://127.0.0.1:<端口>`，端口取自监听器实际获得的端口；HTTPS 为 `https://localhost:<端口>`。桥无法登录以 `--dangerously-skip-authentication` 运行的实例；管理器会把这种情况报告为桥错误，且不创建 Grant。

### 桥的 Grant

首次启动时，管理器执行与 `dsh chat init` 相同的步骤：生成 P-256 签名密钥并存入凭据 `DSH_CHAT_BRIDGE_SIGNING`，登记一个名为 `chat-bridge`、只含 `harniverse.observe` 与 `harniverse.operate` 的 API 客户端 Grant，并把它的 id 存入 `DSH_CHAT_BRIDGE_GRANT_ID`。该 Grant 以此名称出现在用户的 Grant 列表中。登记过程幂等，并复用已有的凭据：已有密钥会保留；若某个 Grant 是该密钥的、仍有效且同时具备两项能力的 API 客户端 Grant，就复用它（按已存的 id 或按密钥查找，后者也能修复丢失的 id 凭据）；已撤销或不可用的 Grant 会被替换。持有别的密钥的同名 Grant 保持原样，新的 Grant 命名为 `chat-bridge-<时间戳>`；`dsh chat init` 写入的凭据位于 `dsh chat` 配置自己的凭据文件中，因此从未持有密钥的 Web Host 会生成自己的密钥。登记需要已存在所有者 Grant，因此尚未完成设备登录的实例会报告要求登录的桥错误。删除所有机器人后，密钥与 Grant 仍保留。

Grant 登记表是认证提供方监视的文件，因此第一次 `events.mux` 连接可能被拒绝一次，并在客户端的重连延迟之后重试。

### 机器人状态

| 状态 | 条件 |
|---|---|
| `disabled` | 机器人未启用。 |
| `starting` | 桥或机器人的挂载尚未完成，或桥还没有该适配器的状态。 |
| `online` | 桥报告 `running`。 |
| `reconnecting` | 桥报告 `reconnecting`：与平台的连接中断，正在重连。 |
| `error` | 桥报告 `credential-rejected`（凭据被平台拒绝，请更新后重试）、`conflict`（另一个程序正在使用这个机器人）或 `stopped`；挂载抛出了错误；平台提供方未挂载；或桥启动失败。 |

状态在每次 `snapshot` 时现算，因此客户端轮询即可，无需事件。

### 机器人默认值

每次桥启动时，管理器向 `ctx.chatBridge.useBotSettings` 注册一个提供者。它每次调用都读取登记表，并按平台与 `identity.botId` 匹配，所以 `updateBot` 的修改无需重启机器人就适用于下一个新建的所有者会话。桥只把 `workspace`、`agentProfile` 与 `model` 应用于所有者的新会话。工作区必须是绝对路径，但不要求存在。

## 测试状态

单元测试在脚本化的平台、内存凭据以及桥和其客户端的替身之上运行真实的管理器。Loader 组合测试运行真实的 Web 服务器、认证提供方、凭据、存储域、适配器注册表、Telegram 提供方、管理器、嵌入式桥与 HTTP 客户端；它对照脚本化的 Bot API 添加机器人，使其上线，配对所有者，并把所有者的第一条提示转发到脚本化的 `/api`，由后者用真实的质询验证所登记的 Grant。经真实网关的模型往返属于 Web 端到端测试。

## Model Experience

None, as this package manages bot registration and the bridge lifecycle and registers no prompt, tool, or model-visible content; the bridge and the Agent Preset it selects own everything the model sees.

#### KV Cache effect

None; the manager performs no model request.

## Known Limitations and Deferred Work

- 凭据无法就地轮换：Remote 没有更新密钥的调用，需要删除机器人后重新添加。所有者的配对会保留，因为桥的状态按平台和用户记录它们。
- 嵌入式桥把配对保存在 Web Host 的存储域中，与 `dsh chat` 配置自己的存储相互独立，因此在其中一处配对的所有者需要在另一处重新配对。
- 两个进程轮询同一个机器人会冲突。桥会把该机器人报告为带冲突消息的 `error`，且不会停止 Host；要在 `dsh chat` 和 Web Host 中使用同一个机器人，必须停用其中之一。
- 撤销 `chat-bridge` Grant 会使正在运行的桥无法登录。下一次桥启动时会登记新的 Grant，停用后再启用最后一个已启用的机器人，或重启 Host，都会触发这一点。
- 桥要求 Web 实例以 Grant 认证运行并已完成所有者的设备登录；旁路模式的实例无法使用 IM 机器人。
- 只有桥在运行时才列出所有者，因此所有机器人都被停用时，已配对的所有者无法被看到或取消配对，直到启用某个机器人或某次所有者调用启动了桥。
- `ChatPlatformField` 在 `src/types.ts` 中重新声明，使面向客户端的类型不必引入适配器包的运行时依赖图；适配器的字段类型有变更时，这里需要同样的变更。
- 当 TLS 监听器的证书不包含 `localhost` 时，嵌入式客户端无法验证它，经桥转发的提示会失败；使用运行时的信任库，不支持自定义 CA。
- `Url` 字段按键的后缀识别，因为描述符的字段类型不带格式信息。

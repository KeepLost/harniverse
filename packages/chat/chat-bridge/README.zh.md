# `@deepseek-ai/dsh-chat-bridge`

[English](README.md) | 中文

聊天桥核心。它消费 `ctx.chatAdapters`（[适配器契约](../chat-adapter/README.md)）和 `ctx.harniverseClient`（[`/api` 客户端](../chat-harniverse-client/README.md)），把状态保存在一个 storage domain 中，并让白名单内的 IM 成员驱动 Harniverse 会话。`/api` 仍是单用户的本机 API：桥只是一个 operator 客户端，成员之间的所有区分都只存在于本包内部。它是函数插件（`name`、`inject`、`Config`、`apply`），不监听任何端口。`dsh chat` profile 把它作为一行挂载；宿主插件也可以用 `embedded` 把它挂载进自己的进程（web Host 的 `chat-manager` 就是这样做的），并通过 `ctx.chatBridge` 管理它，详见“嵌入与管理服务”。

安全依赖五条固定规则。准入默认拒绝。命令表是闭合的。审批交给 owner。`danger-full-access` 不可达，因为没有任何命令能修改权限。成员之间的隔离取决于其配置的 Agent Profile 或远端运行时所提供的能力。

## 配置

部署选项是经过校验的 `Config`；命令词表和上述规则固定在代码中。`validateConfig` 在插件挂载时运行，遇到相对的别名路径、未知别名、重复的成员 id 或身份，或不是小写 v4 UUID 的 `dshRemoteHost` 时失败。

| 键 | 默认值 | 说明 |
|---|---|---|
| `owners[]` | `[]` | `platform`、`userId`，可选 `agentProfile`、`workspaces`（别名）。owner 拥有所有可授予命令，可在此设置，也可兑换 owner 码成为 owner。 |
| `members[]` | `[]` | `id`、`platform`，可选 `userId`、`commands`、`workspaces`、`agentProfile`、`dshRemoteHost`、`answerOwnApprovals`（默认 `false`）。没有 `userId` 的成员通过配对码加入。 |
| `workspaceAliases` | `{}` | 别名到绝对根路径。聊天中只会出现别名。 |
| `imRoot` | `~/HarniverseIM` | 不使用别名的会话的工作目录：owner 用 `owner/`，成员用 `members/<id>/`。 |
| `pairing` | 成员 24 小时，owner 15 分钟 | 配对码有效期。 |
| `approvalTimeoutMs`、`questionTimeoutMs` | 10 分钟、30 分钟 | 超时后请求被拒绝或取消。 |
| `inbound` | 5 个文件，每个 20 MiB，4 MiB 以内图片内联 | 更大的图片和其他文件经 `attachment/upload` 上传。 |
| `outbound.maxFileBytes` | 20 MiB | 同时受平台 `maxFileBytes` 限制。 |
| `streamIntervalMs`、`seenLimit` | 800、2000 | 编辑合并间隔；保留的入站消息 id 数。 |
| `embedded` | `false` | 桥运行在宿主进程内时由宿主插件设置。此时轮询冲突只会更新适配器状态；桥不会读取 `appExit`，也不会请求进程退出。 |

## 准入与配对

- 发送者只有匹配 owner、带静态 `userId` 的成员或已持久化的配对时才能行动。未配对的私聊消息被忽略；发送者最多每小时收到一次发送 `/pair <code>` 的提示。未配对的群消息、机器人消息和未指向机器人的群消息被静默丢弃。
- 配对码是取自系统 CSPRNG 的十位 Crockford base32 字符。只存其 SHA-256，兑换即删除，并带有自身过期时间。`dsh chat init` 打印 owner 码，`ctx.chatBridge.issueOwnerCode()` 以同样的方式签发 owner 码；兑换时发送者的显示名会存入 owner 绑定。owner 的 `/invite <member>` 为一个没有静态身份的已配置成员签发绑定该成员的码；兑换后该平台身份与成员绑定。`/revoke` 解除绑定。
- 群聊只有在 owner 于群内发送 `/pair-group` 之后才可用；此后任何已配对的发送者都可以指向机器人。群会话是共享的，因此 Profile 或远端主机与该会话不同的发送者会被拒绝。
- 每个入站消息 id 都会被记住；重复投递被忽略。同一会话（`botId:kind:chatId[:threadId]`）的消息严格逐条执行。

## 命令

只存在这些命令。任何其他以 `/` 开头的文本，包括形似路径的文本，都会得到未知命令提示，且永远不会到达模型。没有通用的 `/api` 透传，也没有修改权限、上下文或导出的命令。

| 适用者 | 命令 |
|---|---|
| 任何已配对者 | `/help`、`/whoami`、`/status`；`/approve`、`/reject`、`/answer` 适用于发送者可回答的请求 |
| 按成员授予 | `/new`、`/ask`、`/stop`、`/steer`、`/queue`、`/unqueue`、`/sessions`、`/session`、`/ws`、`/model`、`/title`、`/compact`、`/plan`；普通消息等同隐式 `/ask` |
| owner | `/invite`、`/members`、`/revoke`、`/pair-group`、`/unpair-group` |
| 未配对者 | `/pair <code>` |

`/stop` 取消会话正在运行的回合，仅允许发起该回合的人或 owner 使用。`/steer` 和 `/stop` 作用于该会话所绑定的会话。`/compact` 和 `/plan` 以由固定名称组成的行作为 Harniverse 命令执行。

## 会话、工作区与隔离

会话中的第一条 prompt 会创建会话。桥先写入会话记录，再以预分配的 `chat-<uuid>` id 调用 `session.create`，因此中途崩溃后可用同一 id 重放。工作目录是成员所选的别名（`/ws`），否则是第一个别名，否则是 `imRoot`。Agent Profile 是成员的 `agentProfile`。owner 的会话可以改用按机器人设置的默认值，取代 `imRoot` 目录和默认 Profile，见“嵌入与管理服务”中的机器人默认值。

桥自身不增加任何隔离。把成员的 `agentProfile` 指向 SSH 执行 Profile，会让会话的文件、进程和沙箱落在受信的 SSH 主机上。设置 `dshRemoteHost` 会把该成员的所有 HTTP 和事件流流量转发到远端运行时；桥为每个主机各保留一条事件流和一组游标。

## 审批与提问

- 审批卡片会发到每位 owner 的私聊。只有 `answerOwnApprovals` 为 `true` 时，成员才会额外收到卡片，否则成员只会看到请求已转交。按钮回答 `allowed-once` 或 `rejected`；没有按钮的平台使用 `/approve <id>` 和 `/reject <id>`。这些 id 仅在当前进程内唯一，所以旧卡片无法回答新请求。“yes”之类的词永远不会被当作批准。
- 没有可联系的 owner 时请求立即被拒绝。`approvalTimeoutMs` 之后请求被拒绝，卡片标记为过期。在 web UI 中作出的回答会使卡片置为已完成。Host 重启会使所有待处理项过期。
- 提问会发到发起回合的聊天：单个单选题用按钮，否则用文本并通过 `/answer <id> <answer 1> ; <answer 2>` 回答。只有提问对象或 owner 能回答；`questionTimeoutMs` 之后提问被取消。

## 渲染与文件

从聊天发起的回合先渲染为占位消息，按平台节奏原位编辑，最后以完整文本收尾，并按平台上限拆分。不能编辑的平台只收到最终文本。推理不显示，工具活动只显示工具名。限流会按平台提示暂停编辑；编辑失败时回退为发送新消息。

模型呈现的文件仅当真实路径位于会话工作目录内、是普通文件而非符号链接且符合大小上限时才会发送。远端主机上的会话不投递文件。内联上限以内的入站图片随 prompt 发送；其他附件先上传。

## 状态

一个 storage domain（`chat_bridge`）保存配对、配对码哈希、已绑定的群、会话绑定、会话、保留的消息 id 和每条流的续传游标。只有运行中的桥写入它；`dsh chat status` 读取它。等待回合的 prompt 和进行中的回复不会持久化，因此重启会丢失进行中的回复。

## 嵌入与管理服务

桥所在的行挂载期间会提供 `ctx.chatBridge`（`ChatBridgeService`），该行被销毁时撤回。

| 方法 | 行为 |
|---|---|
| `adapterState(platform, botId)` | 已挂载适配器的 `{ state, message? }`；没有挂载时为 `undefined`。`state` 为 `running`、`reconnecting`、`credential-rejected`、`conflict` 或 `stopped`（适配器的 `run` 未被中止就结束）。`message` 是 `/status` 对 `reconnecting`、`credential-rejected`、`conflict` 显示的那句话。 |
| `issueOwnerCode()` | 一次性 owner 配对码及其绝对过期时间，有效期为 `pairing.ownerCodeTtlMs`；发送者用 `/pair` 兑换。 |
| `owners()` | 先列配置的 owner，再列已配对的 owner，每个身份一项：`key`、`platform`、`userId`、`displayName`（发送过显示名的已配对 owner）、`pairedAt`（只存在于配置中的 owner 为 `0`）。 |
| `unpairOwner(key)` | 删除已配对的 owner 绑定。键不存在、是成员绑定或属于配置中的 owner 时返回 `false`。 |
| `useBotSettings(provider)` | 注册按机器人的默认值，返回这次注册的销毁函数。 |

### 机器人默认值

`provider(platform, botId)` 为收到消息的机器人返回 `ChatBotSettings`（`workspace`、`agentProfile`、`model`），没有则返回 `undefined`；最先注册且给出答案的提供方生效。默认值只在为 **owner** 创建新会话时应用。成员保持自己的授权、目录和 Profile，永远不读取它们。

- `workspace` 必须是绝对路径，相对路径会被忽略并记录警告。它取代 `imRoot/owner` 目录；owner 已配置的工作区别名仍然优先。
- owner 没有配置 `agentProfile` 时才使用 `agentProfile`，用于 `session.create` 和会话记录。`/whoami` 会显示它，`/new <profile>` 也接受它。
- `model` 在 `session.create` 成功之后立即通过 `session.selectModelTarget` 选定，只作用于这个新会话；Host 的共享默认模型不会改变。失败只记录日志，不会使会话失败。`/model` 命令仍使用 `session.selectModel`。
- 默认值只影响之后创建的会话。没有配置 `agentProfile` 的 owner 在默认值变化时继续使用已绑定的会话，`/new` 才会按当前默认值创建新会话。配置了 `agentProfile` 的 owner 在会话 Profile 与之不同时仍会换成新会话。

## 导出

`apply`、`name`、`inject`、`Config`、`validateConfig`、配对辅助函数（`generateCode`、`hashCode`、`issueCode`、`redeemCode`）、`bridgeDomainSpec`、`parseInput`、`COMMAND_TABLE` 与 `splitMessageText`。服务类型为 `ChatBridgeService`、`ChatBotSettings`、`BotSettingsProvider`、`OwnerView`、`AdapterRunState` 与 `AdapterStatus`。`chat-app` 使用配对辅助函数和状态规格来打印 owner 码。

## Model Experience

### Group chat sender prefix

#### What the model sees

In a bound group chat, each prompt's text is prefixed with `[<platform>·<name>] `, where the name is the sender's display name (or user id) with brackets and line breaks replaced by spaces and cut to 40 characters, or `unknown` when nothing remains. The prefix is part of the logged user message. Direct-chat prompts carry no prefix and no sender identity, and the bridge keeps the message-to-member mapping in its own log.

#### Token effect

A group prompt grows by the prefix, typically under 20 tokens. Direct prompts are unchanged.

#### KV Cache effect

Append-only: the prefix belongs to the newly appended user message and does not alter earlier request tokens.

### Bot defaults

#### What the model sees

Nothing the bridge writes. A bot's default Agent Preset and model apply to a new owner session before its first prompt, and to that session only; the Preset and the model own everything the model sees.

#### Token effect

None from the bridge. The chosen Preset's prompt sections and tools determine the request size.

#### KV Cache effect

Neutral: the selection happens before the first request, so no earlier tokens exist to invalidate. A later change of the defaults affects only sessions created afterwards.

## Known Limitations and Deferred Work

- 等待回合的 prompt 和进行中的回复保存在内存里；桥重启会丢弃它们，游标重放也不会重新投递其 prompt 已丢失的回复。
- 整个应用关闭时 storage domain 与桥会并发销毁，因此最后一秒的游标进度可能未写入；它会被无害地重放。
- 表情回应、语音、位置、消息编辑和删除都被忽略。被编辑的消息不会重新运行已发送的 prompt。
- 工作区别名和 `imRoot` 由实际运行会话的主机解释；桥无法检查远端路径是否存在。
- 一个群共享一个会话；Profile 与创建者不同的成员必须使用私聊。
- 没有配置 `agentProfile` 的 owner 会接受任何 Profile 的已绑定会话，包括 owner 配置去掉某个 Profile 之前创建的会话；`/new` 会按当前 Profile 创建会话。

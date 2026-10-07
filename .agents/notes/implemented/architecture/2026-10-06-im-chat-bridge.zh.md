# Agent Note: IM chat bridge

Status: implemented

[English](2026-10-06-im-chat-bridge.md) | 中文

## Problem

用户希望在手机上通过即时通讯应用访问本机的 Harniverse。现有的 `/api` 刻意只面向本机和单用户：它只认证一个 operator，没有其他人的概念。让 Harniverse 认识成员、按成员授权，或者开放公网入口，会改变所有部署的信任边界，并让 web 组合背负它原本没有的聊天职责。

首批平台是 Telegram 和飞书，两者都只需要出站连接，因此无需公网端口。第三、第四个平台应当只增加一个适配器，而不是重新设计。

## Decision

聊天桥是一个独立进程 `dsh chat`，它是 `/api` 的客户端。它不增加 endpoint，也不向 web 组合增加插件。多用户行为只存在于桥内部：谁可以和它对话、每个人可以运行哪些命令、审批发往何处。认证桥的[公钥 Grant](2026-08-17-public-key-grant-authentication.md)是普通的 operator Grant，只有 `harniverse.observe` 和 `harniverse.operate`。

### 包拓扑

| 包 | 职责 |
| --- | --- |
| `packages/chat/chat-adapter` | Service Definition：唯一的 `ChatAdapter` 约定、封闭的错误码，以及 `ctx.chatAdapters` 注册表和它的 `chat-adapter/registered`、`chat-adapter/unregistered` 事件 |
| `packages/chat/chat-harniverse-client` | `ctx.harniverseClient`：唯一调用 `/api` 的代码，endpoint 表封闭 |
| `packages/chat/chat-bridge` | Consumer：准入、配对、封闭命令表、审批路由、流式回复、持久状态 |
| `packages/chat/chat-adapter-telegram`、`packages/chat/chat-adapter-feishu` | 平台 provider |
| `packages/test-support/chat-adapter-fake` | 供桥测试和无密钥 e2e 使用的脚本化平台 |
| `packages/bundle/chat-app` | `chat` profile：随附的 patch、`dsh chat` 命令、`init`、`status` 和 `rotate-key` |

类型、语义和生成的 Cordis API 见[聊天桥子系统页面](../../../../docs/subsystems/chat-bridge.md)。

### 一个适配器约定

每个平台实现同一个 `ChatAdapter`。差异声明为 `capabilities`，由桥去适应：不能编辑消息就只发终稿，没有按钮就用文字回复，有长度限制就拆分，有编辑间隔就节流。适配器以八个封闭的 `ChatAdapterError` 错误码之一失败，桥把每个错误码映射为固定的用户可见行为。平台若不能主动给某用户发消息，`directRoute` 返回 `undefined`；没有可触达 owner 的审批会被拒绝，并通知请求者。

### 安全姿态

- **默认拒绝。** 既不是配置的 owner、配置的成员，也没有有效配对码的发送者会被忽略，每小时最多收到一次配对提示。配对码是十位 Crockford base32 字符，只以 SHA-256 哈希存储，只能用一次，并在兑换时绑定兑换者的身份。`dsh chat init` 打印 owner 配对码；owner 用 `/invite` 签发成员配对码。
- **封闭命令表。** 以 `/` 开头却不在表中的文本会被拒绝，从不到达模型。没有 permission、context、export 或通用 `/api` 命令，因此聊天无法触达 `danger-full-access` 预设。
- **按成员授权。** 成员只能运行配置列出的命令，只能使用配置列出的 workspace 别名，聊天文本只显示别名，不显示路径。
- **审批发往 owner。** 工具审批卡片发送到 owner 的私聊，内容包含工具名、参数和请求的成员。只有设置了 `answerOwnApprovals` 时，成员才会收到卡片并能回答；超过 `approvalTimeoutMs` 未回答的审批会被拒绝。通过聊天只有 `allowed-once` 和 `rejected` 两种结果。
- **模型可见记录标明说话者。** 群聊 prompt 会加上平台和发送者名称前缀，因此会话日志记录了谁说了话。
- **文件只从 workspace 发出。** 展示的文件只有真实路径位于会话 workspace 之内才会回传。
- **幂等接收。** 每个变更调用都带有由平台消息 id 派生的 `Idempotency-Key`，桥还保留已处理的消息 id，因此重复投递的消息只启动一个 turn。

### 隔离由 owner 选择

桥不增加隔离层。成员的配置若指定了运行在 SSH 执行 Profile 上的 `agentProfile`，或把请求转发到远端运行时的 `dshRemoteHost`，该成员就在那台受信机器上工作。两者都没有的成员，在 owner 的 `imRoot` 下由桥拥有的目录中工作。

### 平台传输

Telegram 使用 `fetch` 调用 Bot API，采用长轮询，不用 SDK。飞书长连接使用 `ws` 包，其 `pbbp2.Frame` protobuf 使用手写编解码器；该编解码器在录制的帧上与官方 SDK 的编码逐字节一致，且 SDK 不是依赖。从 dsh-im 移植的源码保留其 MIT 文件头，并登记在 [`THIRD_PARTY_NOTICES.md`](../../../../THIRD_PARTY_NOTICES.md) 的“Ported source”一节，该文件的生成方式见[生成的第三方声明](../process/2026-07-30-generated-third-party-notices.md)。

### `chat` profile

`dsh chat` 是类似 `dsh auth` 的别名：`PROFILE_TEMPLATES.chat` 为 `['@deepseek-ai/dsh-chat-app']`，组合包声明 `homeOwnership: "shared"`，因此 Web 持有 home 租约时，桥及其维护命令仍可运行（[profile home 所有权](2026-09-27-profile-home-ownership.md)）。

`dsh chat init` 创建 P-256 密钥，注册 `chat-bridge` Grant，把两者作为凭据保存在 `$DSH_HOME/chat-bridge/` 下，把配置模板写入 `$DSH_HOME/profiles/chat/patch.yml`，并打印有效期 15 分钟的 owner 配对码。`rotate-key` 替换密钥和 Grant 并撤销旧 Grant。`status` 报告密钥、Grant、Harniverse 可达性和存储计数。

桥的各行只在 `dsh chat` 和 `dsh chat run` 时挂载。Loader 在创建行时只对 `disabled` 求值一次，此时兄弟插件还来不及发布服务；patch 又会替换行的整个 `config`，所以服务值和 config 标志都无法用来控制这些行。随附的 patch 因此在 `disabled` 表达式中读取启动器的 `cmdlineArgs` 快照，`src/startup.ts` 保存与之对应的默认运行规则。

### Testing

桥核心对照 `chat-adapter-fake` 和脚本化客户端运行，每个源文件都有覆盖。每个 provider 都对照脚本化的平台服务器测试，飞书 socket 通过真实的 `ws` 回环来演练。真实 Loader 组合测试为组合包、桥、客户端和各 provider 挂载随附的 patch。`apps/web/tests` 中的无密钥 e2e 启动带 Grant 认证和回放模型的真实 web 组合，通过 Loader 以假平台运行 `dsh chat init` 与 `dsh chat`，并驱动：一次性配对且忽略未知发送者、拒绝未知命令、把流式回复记录为 golden 转录、重复投递、Grant 撤销、`/stop`、回传展示的文件、只有 owner 能回答的审批、审批超时，以及在聊天中回答提问。

## Alternatives considered

**在 Harniverse 内部建立多用户网关。** 按成员约束 Grant 的 endpoint 和增加 `chat/inbound` endpoint，会让 Harniverse 变成多租户服务器。owner 模型让 `/api` 保持单用户，并把全部策略放在可以单独替换而不触碰服务器的客户端里。

**作为 web 组合中的插件。** 它会共享进程并绕过 Grant，代价是把平台凭据、长期出站连接和聊天策略放进服务浏览器的进程，并使聊天无法脱离 web UI 运行。

**让 dsh-im 与 Harniverse 并行运行。** dsh-im 有自己的会话模型和发布节奏。把其成熟的平台代码移植进本仓库的插件架构，可以共用一套凭据存储、一个 Grant、一个状态域和一套测试。

**固定的 guest、member、trusted、owner 档位、密钥遮蔽、审计日志和速率配额。** 隔离已经来自按成员选择 Profile 或远端主机，而遮蔽无法让共享文件系统变安全。档位表承诺的会比它能强制的更多。

**Webhook 和中继。** 公网端点会带来新的攻击面。两个平台都通过桥自己发起的连接投递。

**飞书 SDK 和 `protobufjs`。** 它们会为一种帧类型增加运行时依赖。一个小型编解码器，在录制的帧上与 SDK 逐字节核对，比携带任何一个依赖成本更低。

**用服务值或 config 标志控制桥的各行。** 两者都挡不住 Loader 一次性的 `disabled` 求值和整个 `config` 被 patch 替换，所以这些行改为读取参数快照。

## Consequences

桥的交付不改动 `/api` 和 web 组合，新平台只需一个实现 `ChatAdapter` 的包。chat profile 与 Web 共存，Grant 丢失或轮换后用两条命令即可恢复。

Telegram 和飞书只对照脚本化的服务器验证过。尚无运行使用过真实的 bot token 或飞书应用，所以首次在真实平台上使用时，群隐私设置、编辑窗口或事件载荷的差异可能暴露出 fixture 没有覆盖的问题。

飞书编解码器跟随的是厂商可能变更的协议，其逐字节核对只覆盖录制的帧。启用各行的规则写了两遍，一处在 YAML，一处在命令语法，e2e 中的 `dsh chat` 运行同时固定了两者。

桥把状态存放在一个没有跨进程锁的 JSON 存储域中，这在 profile 只允许运行一个桥时是安全的；`status` 只读取它，没有任何机制保护该读取不与运行中的桥并发。整个应用关闭时，存储域可能先于桥的最后一次游标写入关闭，这只会加宽下一次重放的范围。

不同平台上的身份彼此独立；同一个人同时使用 Telegram 和飞书需要两次配对。

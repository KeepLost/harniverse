# `@deepseek-ai/dsh-chat-harniverse-client`

[English](README.md) | 中文

聊天桥访问 Harniverse `/api` 的唯一客户端。默认导出 `HarniverseClient` 提供 `ctx.harniverseClient`。它用公钥 Grant 认证，拒绝闭合表之外的所有端点，转发 `Idempotency-Key`，把变更绑定到载体的主体身份，并维护可续传的事件流。`/api` 本身保持不变：本包只是普通的 operator 客户端。

## 配置

该服务注入 `credentials`。密钥从不出现在配置中；Grant id 与签名密钥是由 `dsh chat init` 写入的凭据引用。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `origin` | string | `http://127.0.0.1:3080` | 回环 HTTP 或 HTTPS；`GrantAccess` 拒绝其他 origin。 |
| `grantId` | string | — | Grant id；省略时从 `grantIdRef` 所指凭据读取。 |
| `grantIdRef` | string | `DSH_CHAT_BRIDGE_GRANT_ID` | 保存 Grant id 的凭据。 |
| `signingKeyRef` | string | `DSH_CHAT_BRIDGE_SIGNING` | 保存 PKCS#8 DER（base64url）P-256 签名密钥的凭据。 |
| `requestTimeoutMs` | number | `30000` | 单次请求超时。 |
| `muxRenewAfterMs` | number | `540000` | 更换 mux 套接字的时长；至多 840000，低于 15 分钟的 Access Token 上限。 |
| `reconnectMinMs`、`reconnectMaxMs` | number | `1000`、`30000` | 指数重连退避的上下界；下界不得超过上界。 |

## 端点表

只有下列端点可以到达 `/api`。任何其他方法或 Typert 端点都会在使用网络之前抛出 `endpoint-denied` 并记录日志；`chat-harniverse/request` 事件会宣告每个被允许的请求，使包不变量能断言其属于该表。

| 类别 | 条目 |
|---|---|
| Unary 读 | `api.describe`、`host.describe`、`session.list`、`session.history`、`session.workStatus`、`session.models` |
| Unary 变更 | `session.create`、`session.selectModel`、`session.selectModelTarget`、`session.rename`、`session.prompt`、`session.updateQueue`、`session.cancel` |
| Typert | `commands/execute` |
| 载体 | `POST /api/respond`、`POST /api/attachment/upload`、`GET /api/events.mux`（WebSocket） |

每一行都会校验桥所读取的响应值字段；线路形状漂移会以 `protocol-violation` 失败。

## 认证与身份

`GrantAccess` 用 `signingKeyRef` 解析出的密钥对挑战签名，并在到期前 30 秒续换短期 Bearer token；客户端从不为 HTTP 安排 token 计时器。首次变更会用一次 `host.describe` 读取学到载体的主体身份（`{ kind: 'grant', grantId, grantRevision }`），之后的响应和流的首帧使其保持最新。变更把它作为 `expectedPrincipal` 发送。遇到 `authentication-principal-mismatch` 时，客户端采用载体报告的身份并只重试一次；`respond` 遵循同样规则。报告无认证的实例会被以 `authentication-failed` 拒绝。

变更类 unary 调用与 Typert 调用会把调用方的 `idempotencyKey` 作为 `Idempotency-Key` 头转发。载体按主体和方法划分键的作用域，并以 `idempotency-key-reused` 拒绝载荷不同的重用键。

## 远端主机

`remoteHost` 会给任意请求类别（含 mux）追加 `?dshRemoteHost=<uuid>`。它必须是小写的 version-4 UUID，否则在本地被拒绝。本地载体把请求转发到远端运行时，并把 `expectedPrincipal` 重写为远端身份，因此远端响应不会改变客户端的本地身份，远端路径上的主体不匹配也不会重试。

## 事件 mux

`client.openMux(options)` 返回绑定到调用方 effect 作用域的 `HarniverseMux`。它携带 Bearer 头和 `since=<cursors>` 连接 `events.mux`，按顺序交付 `session/event`、`approval/requested`、`approval/resolved`、`question/requested` 和 `question/resolved` 帧及其 server-request `rpcId`，并丢弃其他所有帧类型。

- 游标随 `session/event` 序号推进；序号不大于游标的重放会被丢弃，`onCursor` 让所有者持久化位置。
- 重连后重放的待处理审批或提问沿用其 `rpcId`，只交付一次。
- 服务端以 4001 关闭（Access Token 过期或被吊销）时立即重连；其他关闭则按指数退避重连。
- 在 Access Token 过期之前（即 `muxRenewAfterMs` 之后），mux 用当前游标打开替换套接字，并在新套接字打开之后才关闭旧的。
- 每次打开后它读取 `host.describe`；`bootId` 变化时调用 `onHostRestart`。

## 错误

每个方法都抛出带闭合 `code` 的 `HarniverseError`：`endpoint-denied`、`remote-host-invalid`、`credential-missing`、`authentication-failed`、`transport-failed`（载体已应答时带 HTTP `status`）、`rpc-rejected`（带业务 `rpcCode`）或 `protocol-violation`。

## 测试接缝

`internals.fetch` 与 `internals.createSocket` 是仅有的外部效应；测试会替换它们。包测试运行一个会校验每次挑战 P-256 签名的伪载体。

## Model Experience

None, as this client carries requests the chat bridge composes and registers no model context.

#### KV Cache effect

None; the client performs no model request.

## Known Limitations and Deferred Work

- 工作区文件读取（`workspace.files.*`）不在端点表内；桥与 Harniverse 运行时同机，直接从磁盘读取要交付的文件。
- 只解析桥消费的 mux 帧；`session/queue`、`session/jobs`、投影、压缩和 `stream/error` 帧会被丢弃。
- mux 会重连，但不会回填宿主宕机期间超出游标重放范围所错过的事件；`bootId` 变化会被报告，由所有者自行对账。
- 不支持带自定义 CA 的 HTTPS origin；沿用运行时的信任库。

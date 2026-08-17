# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

协议消费层：客户端插件的 apply 会挂载 `ctx.connection`（共享 API 客户端 + 当前页面的 loopback 状态 + 可观察且按 generation 生效的 `hostDescription` + 单消费方流循环启动器）；导出表层携带协议约定类型、`AbstractApiClient` 抽象，以及循环的 sink／配置类型。每次就绪握手成功后，都会在 `onConnected` 之前发布完整的 `host.describe` 值；generation 失效或显式 stop 会清空它。浏览器载体以 HTTP POST 发送 unary／respond，并为 `events.mux` 与 `events.host` 各开一条只下行的 WebSocket；进程内载体满足同一双流抽象。Host half 持有唯一 `/api` route 及其 Fetch bridge；已注册的 Typert interceptor 会先认领自己的 Remote endpoint，未认领请求再回退 API Proxy。Loopback hostname 判定逻辑留在包内部。node 半侧认证每个网络请求，并把原生对话框、配置、凭据、模型发现及 agent preset 创作方法钉在回环，因为当前具名令牌只建立接入身份，不携带逐操作授权；认证 bypass 同样仅限回环。平台载体与 ConnectionController 循环属于包内部；apply 负责选择并驱动它们。下行边界见 [WebSocket 下行载体 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md)。

`hostDescription.bootId` 标识一个 API Proxy 进程生命周期。它在同一 Host 服务的多个连接 generation 间保持稳定，并在重启后改变，使消费方能够隔离缓存的进程本地状态，而不会把重连误判为重启。

## /api 浏览器信任栅栏

node 半侧在桥接或 upgrade 前守卫 `/api` 下的每个入口（`src/api-request-trust.ts`）。每个请求，无论是否带浏览器标记，`Host` 都必须是回环地址或匹配规范化的 `trustedHosts` authority；附带的 Origin 与 Fetch Metadata 也必须描述同源请求。这仍是 DNS 重绑定与混淆代理人防御，而不是认证。独立认证提供方随后验证 Bearer token 或浏览器 session，遭拒的 HTTP 或 WebSocket 接入不会进入 RPC 分发。非回环 listener 要求直接配置 TLS 证书与密钥，回环可以继续使用明文 HTTP；HTTPS 浏览器 session 使用 Secure `__Host-` cookie，认证响应不可缓存。非回环组合仍通过推导的 LAN 字面量或 `--trusted-host` 声明服务名称。决策记录：[api 浏览器信任边界](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md)与[入站认证](../../../.agents/notes/implemented/feature/2026-08-16-inbound-network-authentication.md) Agent Note。

## `/api` WebSocket 下行

`/api/events.mux` 与 `/api/events.host` 各接受一条 WebSocket upgrade，并只向浏览器发送对应的 `ServerRequest` 文本消息；客户端不会在这些 socket 上发送业务数据。每个 generation 开始前，`ConnectionController` 会采样 runtime 当前按 Session 划分的连续游标，浏览器把非空游标表编码到 mux URL 的 `since` 查询中，Host 则在 upgrade 前校验。任一 socket 结束都会使当前 connection generation 失败，并用新的游标采样重建两条流；连接就绪仍要求两条 socket 均已打开且 `host.describe` HTTP 调用成功。Host teardown 会终止两条 socket、中止各自的 source，并等待 source 清理完成后再返回。普通网络 GET 这些路径会返回 426，不保留 SSE（Server-Sent Events）回退；`toFetchHandler` 的 SSE 编解码只服务进程内同构载体。

## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **浏览器 WebSocket inbox 没有独立的字节上限**：Host 流队列有帧数限制，并从持久游标重连，但单个超大帧或永久落后的浏览器回调仍可能保留大量客户端内存。
- **`/api` 桥把每个请求体整体缓冲在内存里**：`maxRequestBodyBytes`（默认 160 MiB，按默认 100 MiB 图片总量上限经 base64 膨胀加信封余量得出）因此同时是单请求的驻留内存上界；要降低它而不缩小图片限额，需要流式请求体路径。

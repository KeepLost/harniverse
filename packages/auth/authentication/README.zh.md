# dsh-authentication

[English](README.md) | 中文

与提供方无关的入站认证和授权（`ctx.authentication`）。已接受的 HTTP 或 WebSocket 请求携带 principal，其中包含精确的 Grant revision、过期时间以及一个或多个 capability：`harniverse.observe`、`harniverse.operate`、`harniverse.administer` 和 `harniverse.authorize`。网络端点必须声明一个所需 capability；缺少元数据或权限不足的请求会在分发前被拒绝。

该 seam 提供带稳定过载决策的公钥 enrollment、一次性签名 challenge、短期 Access Token 与浏览器会话交换、owner 批准、Grant 列表和定向撤销。`authentication/revoked` 标识精确的 Grant revision，因此无关 Grant 对应的浏览器会话、Access Token 和 WebSocket 保持有效。

## 凭据生命周期

Enrollment 只创建待处理请求。Owner 批准后才创建持久公钥 Grant。客户端签署绑定实例、Grant revision、用途、nonce 和过期时间的 challenge，以证明持有私钥。提供方返回短期进程内凭据，其 capability 不会超过 Grant。Access Token 不能自行续期；续期必须再次签署 challenge。

## 模型体验

无，因为认证和端点授权发生在 session 或模型操作之前。

#### KV Cache 影响

无；principal、proof 和凭据不会进入模型输入。

## 已知限制与延后工作

- Capability 当前只表示影响类别，尚未定义端点、preset 或 workspace 级限制。
- 认证 seam 不拥有 TLS；随附 WebServer 要求非回环监听配置 TLS。

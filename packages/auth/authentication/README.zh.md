# dsh-authentication

[English](README.md) | 中文

与提供方无关的入站网络认证（`ctx.authentication`）。消费方提交规范化的 HTTP 或 WebSocket 请求头，并取得一个已接受的令牌 revision，或稳定的拒绝原因。所有已接受令牌都属于同一个 Harness 逻辑用户；令牌名称只用于管理和审计记录，不代表授权、scope、租户或 session 隔离。

`authentication/revoked` 标识已被一次提交后的 registry 变更作废的令牌 revision。长连接消费方只关闭由这些 revision 接入的连接；无关令牌保持有效。

## 浏览器会话

该 seam 验证令牌并创建不透明的内存浏览器会话，后续请求通过 cookie 接入。提供方拥有会话过期与撤销；传输消费方拥有 cookie 属性以及登录、状态和退出 HTTP 响应格式。

## 模型体验

无，因为认证在外部客户端调用任何 session 或模型操作之前决定是否接入。

#### KV Cache 影响

无；认证材料不会进入模型输入。

## 已知限制与延后工作

- 该 seam 认证一个逻辑用户，刻意不定义授权或令牌 scope。
- 认证 seam 不拥有 TLS；随附 WebServer 要求非回环监听配置 TLS。

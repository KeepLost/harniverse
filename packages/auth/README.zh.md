# 认证包

[English](README.md) | 中文

入站网络认证是一项进程级能力。Service Definition 认证 HTTP 与 WebSocket 接入；本地提供方拥有具名令牌、浏览器会话、每个 Harness 主目录的网络实例 lease，以及访问记录。

| 包 | 角色 | `ctx` key |
|---|---|---|
| [`authentication`](authentication/README.md) | Service Definition 与撤销事件 | `authentication` |
| [`authentication-local`](authentication-local/README.md) | 具名令牌提供方、浏览器会话、lease 与访问日志 | `authentication` |

# 认证包

[English](README.md) | 中文

入站认证是一项进程级能力。Service Definition 携带 principal 与端点 capability；本地提供方拥有公钥 Grant、签名 challenge、短期进程内凭据、每个 Harness 主目录的网络实例 lease，以及访问记录。

| 包 | 角色 | `ctx` key |
|---|---|---|
| [`authentication`](authentication/README.md) | Service Definition 与撤销事件 | `authentication` |
| [`authentication-local`](authentication-local/README.md) | 公钥 Grant、challenge、短期凭据、lease 与访问日志提供方 | `authentication` |

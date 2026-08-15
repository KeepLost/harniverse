# notification/：外发事件投递

[English](README.md) | 中文

此功能族把选定的 Harness 生命周期事实投影为稳定的外部协议，并将投递委派给显式配置的后端。它仅运行于宿主、默认不启用，并且独立于模型请求组装。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`notification/`](notification/README.md) | 定义带版本的信封、事件词汇、JSON 快照和后端交接 | `ctx.notification` |
| [`notification-http/`](notification-http/README.md) | 持久化、过滤事件并投递到配置的 HTTP 或 HTTPS 端点 | `ctx.notification` 提供方；消费 `ctx.storageDomain` |

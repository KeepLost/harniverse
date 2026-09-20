# MCP — 模型上下文协议

[English](README.md) | 中文

将 harness 与 MCP 生态系统桥接的包。

| 包 | 职责 |
|---|---|
| [`mcp-client/`](mcp-client/README.md) | MCP 客户端桥接，将外部服务器工具注册到 `ctx.tools` |
| [`mcp-resources/`](mcp-resources/README.md) | 作用域化资源接缝，提供共享资源工具与可达服务器提示词小节 |
| [`mcp-user-config/`](mcp-user-config/README.md) | 用户拥有的 MCP 设置桥接，为每个启用的服务器挂载一个 `mcp-client` 子插件 |

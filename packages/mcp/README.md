# MCP — Model Context Protocol

English | [中文](README.zh.md)

Packages bridging the harness to the MCP ecosystem.

| Package | Role |
|---|---|
| [`mcp-client/`](mcp-client/README.md) | MCP client bridge that registers external server tools on `ctx.tools`; also the host-shared connection core (one owner per server, scoped registrars) |
| [`mcp-resources/`](mcp-resources/README.md) | Scoped resource seam exposing shared resource tools and a reachable-server prompt section |
| [`mcp-user-config/`](mcp-user-config/README.md) | User-owned MCP settings bridge: provider mounts the shared connection fleet, consumers mount scoped registrars, plus the `mcpManagement` Remote |

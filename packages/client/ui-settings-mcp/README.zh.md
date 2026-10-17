# @deepseek-ai/dsh-client-ui-settings-mcp

[English](README.md) | 中文

浏览器设置分区（`mcp`，排在 Governor 之后、Agent 预设之前），管理本机的用户配置 MCP 服务器。页面列出每条已配置的服务器及其实时连接状态；增删改与启停经由 `mcp` 设置 scope（`ctx.settingsScope`）落盘，实时状态与就地重启经由 `mcpManagement` Remote，每张卡片还展示哪些预设通过能力组合暴露该服务器。配置、连接与重启都发生在页面所连接的那台机器上。

## 页面功能

- **服务器卡片**：公开 namespace、传输方式、实时状态色带（已连接 / 连接中 / 带尝试计数的重连中 / 重试耗尽 / 未连接 / 已停用）、在线起始时间与最近错误类型、服务器当前的工具清单（可展开），以及其组合选中该服务器的预设引用。
- **添加 / 编辑**：一个覆盖两种传输（`stdio` 的 command/args/env/cwd 与 `streamable-http` 的 url/headers）以及 `toolCallTimeoutMs`、`maxInstructionBytes`、`failOnStartupError` 的模态表单。标识（`id`）与 namespace（`serverName`）在任何写入前都按设置 schema 自身的规则校验。
- **私密值只写**：`env` 与 `headers` 的值以 secret 字段行走设置通道，绝不回显到表单。删除某行的键即移除该键；留空的值保留已存储的值。
- **粘贴导入**：接受 OpenCode `mcp` 配置（含标准 `mcpServers` 形状与单个服务器对象），预览识别出的服务器，跳过已存在的 id，其余作为启用行导入。
- **重启**：经 Remote 重建一条已启用服务器的共享连接（需要 `harniverse.administer` 能力）；被拒绝的重启将其消息就地展示。

## 数据面

| 面 | 方向 |
|---|---|
| 绑定到 `mcp` namespace 的 `ctx.settingsScope` | 持久行；每个添加/编辑/启停/删除都通过 `set('servers', …)` 写入 |
| `ctx.remote.mcpManagement`（`status()`、`restart()`） | 实时机群状态与就地重启；每次刷新合并，分区打开期间每 5 秒轮询 |
| `ctx.connection.api.agentPresets.list` + `ctx.remote.capabilityManagement.catalog` | 只读预设引用：哪些预设的组合选中了每个服务器 |

## 模型体验

无——本页面从不进入模型请求；`mcp-user-config` 设置命名空间与其塑造的共享连接拥有全部面向模型的效果。

#### KV 缓存效果

无直接失效。编辑服务器通过所属包改变后续 Profile 组合；之后创建的会话从自己的组合建立自己的前缀。

## 已知限制与暂缓事项

- 实时状态为轮询（分区打开期间每 5 秒）；管理 Remote 不推送机群事件。
- 导入解析器只接受 OpenCode `mcp` / 标准 `mcpServers` JSON 形状；其他导出格式不在范围内。
- 页面管理它所连接的机器。按远程主机的 MCP 名册暂缓，直到远程主机暴露自己的管理 Remote。
- 预设引用只读；更改预设的 MCP 选择发生在预设自己的能力面。

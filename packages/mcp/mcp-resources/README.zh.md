# @deepseek-ai/dsh-mcp-resources

[English](README.md) | 中文

作用域化的 MCP 资源接缝：一个 `ctx.mcpResources` 注册表，供每个 MCP 服务器连接注册资源提供者；同时提供三个模型可见工具（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`）和一个列出当前 agent 作用域内可达服务器的系统提示词小节。

提供者按作用域注册。一个 agent 只能看到其作用域链中可见的 `mcp-client` 实例所对应的服务器；挂载在兄弟作用域中的服务器不可达，其名称也不会进入提示词。这三个工具比单个提供者存活得更久 —— 销毁某个服务器只是撤回它的提供者，工具仍为其余服务器保持注册。

## 用法

Host 挂载一次 `mcp-resources`，作用域内的 `mcp-client` 实例随后注册各自的提供者。自定义提供者实现该接口并在作用域化上下文上注册：

```ts ignore-check
ctx.mcpResources.register('my-server', {
  async request(request, exec) {
    // request: { method: 'resources/list', cursor? }
    //        | { method: 'resources/templates/list', cursor? }
    //        | { method: 'resources/read', uri }
    return { resources: [{ uri: 'docs://guide', name: 'Guide', mimeType: 'text/plain' }] }
  },
})
```

请求使用 Agent 自身的作用域 key 路由。注册时可选的 `visible(scopeKey)` 谓词同时过滤服务器名称提示词，并在调用提供者前检查执行权限。未知或被排除的服务器抛出 `MCP resource server "<name>" is unavailable in this agent's scope`。

## 模型可见表面

- 提示词小节 `mcp-resource-servers`（逐字保留 —— 服务器文本中的花括号永远不会被插值）列出排序后的可达服务器名，并指示模型将其用作 `server` 参数。
- `list_mcp_resources(server, cursor?)` —— 列出某个服务器上可用的资源。
- `list_mcp_resource_templates(server, cursor?)` —— 列出参数化资源 URI 模板。
- `read_mcp_resource(server, uri)` —— 按 URI 读取一个资源。

结果渲染为归属于该服务器的 JSON 文本块：`MCP server: <name>\n<json>`。二进制载荷（`blob` 字符串字段）变为 `[binary resource: N base64 characters; available to programmatic callers]`，模型文本省略 `_meta` 字段。完整规范结果超过 1 MiB 时拒绝；渲染文本最多 32 KiB UTF-8，包含归属与截断提示且不截断字符。通过大小检查的规范结果为程序调用者保留原始字节。

## 配置

无 —— 该插件不接受任何配置。

## 服务

| 服务 | 用途 |
|---|---|
| `ctx.tools` | 在插件生命周期内注册三个资源工具 |
| `ctx.systemPrompt` | 注册 `mcp-resource-servers` 小节（逐字） |

提供：`ctx.mcpResources` —— `register(serverName, provider, { visible? }?): () => void`，按插件 fiber 作用域化。

## Model Experience

### 资源工具与服务器列表

#### 模型看到什么

三个固定的工具 schema（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`），外加一个列出可达服务器的提示词小节。列表与读取返回紧凑 JSON；文本资源原样到达，二进制资源以掩码占位符形式到达。

#### Token 影响

调用者作用域链中存在提供者时，三个 schema 是固定成本。没有提供者时（包括内置 Minimal Profile），不贡献工具或服务器小节。小节仅列出可达服务器，结果以有界渲染文本一次性进入历史。

#### KV Cache 影响

只要可达服务器集合不变即前缀稳定。服务器进入或离开作用域会重写该小节，并可能从首个变化 token 起失效复用；读取结果是追加式的。

## 已知限制与暂缓事项

- **提供者负责成员授权**：`mcp-client` 过滤资源与模板成员，并在网络请求前检查读取权限。自定义提供者须实现自身的成员权限；注册表负责服务器可见性。
- **无资源内容订阅**：客户端观察列表变更通知，但不订阅单个资源。
- **读取受所属服务器超时约束** —— 请求走该连接的 `toolCallTimeoutMs`。
- **作用域解析仅跟随 agent 作用域** —— 注册在非作用域上下文上的提供者处处可见；收窄需要通过作用域化插件组合。共享同一公开名称的两台服务器必须从不同作用域发布 —— 提供者注册表按公开名称路由，同作用域重复是配置错误。

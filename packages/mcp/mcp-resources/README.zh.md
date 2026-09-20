# @deepseek-ai/dsh-mcp-resources

[English](README.md) | 中文

作用域化的 MCP 资源接缝：一个 `ctx.mcpResources` 注册表，供每个 MCP 服务器连接注册资源提供者；同时提供三个模型可见工具（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`）和一个列出当前 agent 作用域内可达服务器的系统提示词小节。

提供者按作用域注册。一个 agent 只能看到其作用域链中可见的 `mcp-client` 实例所对应的服务器；挂载在兄弟作用域中的服务器不可达，其名称也不会进入提示词。这三个工具比单个提供者存活得更久 —— 销毁某个服务器只是撤回它的提供者，工具仍为其余服务器保持注册。

## 用法

由 `mcp-client` 组合：每个服务器连接自动注册其提供者。自定义提供者实现该接口并在作用域化上下文上注册：

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

请求被路由到调用者作用域处生效的提供者；未知的服务器名抛出 `MCP resource server "<name>" is unavailable in this agent's scope`。

## 模型可见表面

- 提示词小节 `mcp-resource-servers`（逐字保留 —— 服务器文本中的花括号永远不会被插值）列出排序后的可达服务器名，并指示模型将其用作 `server` 参数。
- `list_mcp_resources(server, cursor?)` —— 列出某个服务器上可用的资源。
- `list_mcp_resource_templates(server, cursor?)` —— 列出参数化资源 URI 模板。
- `read_mcp_resource(server, uri)` —— 按 URI 读取一个资源。

读取结果渲染为一个归属于该服务器的 JSON 文本块：`MCP server: <name>\n<json>`。二进制载荷（`blob` 字符串字段）被掩码为 `[binary resource: N base64 characters; available to programmatic callers]`，base64 内容绝不进入模型上下文。

## 配置

无 —— 该插件不接受任何配置。

## 服务

| 服务 | 用途 |
|---|---|
| `ctx.tools` | 在插件生命周期内注册三个资源工具 |
| `ctx.systemPrompt` | 注册 `mcp-resource-servers` 小节（逐字） |

提供：`ctx.mcpResources` —— `register(serverName, provider): () => void`，按插件 fiber 作用域化。

## Model Experience

### 资源工具与服务器列表

#### 模型看到什么

三个固定的工具 schema（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`），外加一个列出可达服务器的提示词小节。列表与读取返回紧凑 JSON；文本资源原样到达，二进制资源以掩码占位符形式到达。

#### Token 影响

三个 schema 是插件被组合期间的固定成本。小节仅在至少一个服务器可达时输出，并随服务器数量增长。读取结果以渲染文本形式一次性进入历史。

#### KV Cache 影响

只要可达服务器集合不变即前缀稳定。服务器进入或离开作用域会重写该小节，并可能从首个变化 token 起失效复用；读取结果是追加式的。

## 已知限制与暂缓事项

- **资源模板不做成员过滤** —— `list_mcp_resource_templates` 返回服务器通告的全部模板；只有 `resources/list` 与 `resources/read` 受 Profile 成员可见性收窄（由所属 `mcp-client` 连接强制执行）。
- **无资源订阅** —— 未桥接 `resources/listChanged` 通知；小节与缓存的 URI 仅在连接、重同步或重连时刷新。
- **读取受所属服务器超时约束** —— 请求走该连接的 `toolCallTimeoutMs`。
- **作用域解析仅跟随 agent 作用域** —— 注册在非作用域上下文上的提供者处处可见；收窄需要通过作用域化插件组合。共享同一公开名称的两台服务器必须从不同作用域发布 —— 提供者注册表按公开名称路由，同作用域重复是配置错误。

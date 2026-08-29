# @deepseek-ai/dsh-web-search-brave

[English](README.md) | 中文

由 [Brave Search](https://brave.com/search/api/) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.md)（`ctx.web`）（注册 id 为 `brave`）。它使用原生 `fetch` 调用 Brave web search 端点。

这是一个带有 `inject: ['web']` 的函数／命名空间插件。它向 `ctx.web` 提供一个 provider，不拥有 aggregate service，也不新增面向模型的工具。已挂载的凭据服务具有权威性；只有没有该 seam 时才使用启动环境。每次搜索都会解析凭据引用。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 未设置 | Brave subscription token 字面值。优先使用 `apiKeyEnv`；非空字面值会直接使用。 |
| `apiKeyEnv` | `BRAVE_API_KEY` | 每次搜索解析的凭据引用；没有 credentials seam 时回退到启动环境。 |
| `baseURL` | `https://api.search.brave.com/res/v1/web` | Brave web 端点基址；追加 `/search`。 |
| `maxResults` | 未设置 | 操作未提供 `maxResults` 时使用的 Brave `count`；操作值优先。 |

```yaml
- id: web-search-brave
  name: '@deepseek-ai/dsh-web-search-brave'
  config:
    apiKeyEnv: BRAVE_API_KEY
```

`apiKey` 是 `role('secret')` 设置。每个携带 subscription token 的请求都使用 `redirect: 'error'`；不会访问重定向目标。

## 映射

请求为 `GET /search?q=...`，可选发送 `count`、`X-Subscription-Token` 和 `Accept: application/json`。Brave 的 `web.results[]` 将 `url` 映射为 `url`、`title` 映射为 `title`，并将 `description` 与非空的 `extra_snippets` 合并为一个 `snippet`。当前 seam 没有 score 或 answer 字段，因此不会虚构它们。

凭据缺失以 `WEB_PROVIDER_CREDENTIAL_MISSING` 返回；HTTP、网络和不可处理响应体失败以 `WEB_PROVIDER_ERROR` 返回；取消以 `WEB_ABORTED` 返回。请求发出前取消不会发送请求。

## 模型体验

### 搜索结果 sources

#### 模型看到什么

模型通过 [`dsh-tool-web`](../tool-web/README.md) 接收可移植的 source URL、标题和合并后的 snippet，消费方会应用 `maxResults` 限制。Brave token 与 provider 私有请求字段不会暴露。

#### Token 影响

此 provider 不会发起额外的模型推理请求；token 使用仅来自选定的对话模型消费规范化的搜索结果上下文。

#### KV Cache effect

不会直接导致失效；请求前缀变化由上述消费方负责。

## 已知限制与暂缓事项

- Brave 的过滤器、新鲜度控制和其他可移植字段之外的结果元数据会保持 provider 私有，等待 web seam 增加中立字段。
- 主要描述与额外描述会合并进 `snippet`；不会新增厂商专属 source 内容字段。
- `available()` 可以确认存在凭据解析器，但不能同步证明异步凭据存储当前包含 token。

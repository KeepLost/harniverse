# @deepseek-ai/dsh-web-search-tavily

[English](README.md) | 中文

由 [Tavily](https://tavily.com) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.md)（`ctx.web`）。它使用原生 `fetch` 调用 `POST https://api.tavily.com/search`，并把 Tavily 的扁平 `results[]` 映射为 `WebSearchResult`。

这是一个实现包：它是带有 `inject: ['web']` 的函数／命名空间插件，将 `tavily` provider 注册到 `ctx.web`，不拥有 web service，也不新增面向模型的工具。已挂载的凭据服务具有权威性；没有该可选 seam 时，才从启动环境读取配置的凭据引用。每次搜索都会重新解析引用，因此密钥轮换无需重启即可生效。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 未设置 | Tavily 字面密钥。优先使用 `apiKeyEnv`；非空字面值会直接使用。 |
| `apiKeyEnv` | `TAVILY_API_KEY` | 每次搜索解析的凭据引用；没有 credentials seam 时回退到启动环境。 |
| `baseURL` | `https://api.tavily.com` | API 基址；追加 `/search`。 |
| `includeRawContent` | `false` | 启用时向 Tavily 发送 `include_raw_content: true`。 |
| `maxResults` | 未设置 | 操作未提供 `maxResults` 时使用的 Tavily `max_results`；操作值优先。 |

```yaml
- id: web-search-tavily
  name: '@deepseek-ai/dsh-web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

`apiKey` 带有 `role('secret')`；脱敏的设置描述只报告它是否已设置。每个带凭据请求都使用 `redirect: 'error'`，因此 HTTP 重定向会在访问 `Location` 目标之前被拒绝。

## 映射

请求包含 `query` 和 `include_answer: false`。只有操作或配置提供了结果数时才发送 `max_results`；只有启用时才发送 `include_raw_content`。每个 source 将 `url` 映射为 `url`、`title` 映射为 `title`、`content`（缺少普通内容时使用 `raw_content`）映射为 `snippet`、`published_date` 映射为 `publishedAt`。Tavily 的 score 是 provider 私有字段，不会暴露到 web seam，也不会返回生成式答案。

凭据缺失以 `WEB_PROVIDER_CREDENTIAL_MISSING` 返回，provider／网络／HTTP／响应体失败以 `WEB_PROVIDER_ERROR` 返回，调用方取消以 `WEB_ABORTED` 返回。在凭据解析或请求发出前取消不会发送 HTTP 请求。

## 模型体验

### 搜索结果 sources

#### 模型看到什么

模型通过 [`dsh-tool-web`](../tool-web/README.md) 接收 source URL、标题、snippet 和发布日期，消费方会应用 `maxResults` 限制。Tavily 密钥、score 和传输字段不会暴露。

#### Token 影响

此 provider 不会发起额外的模型推理请求；只有选定的对话模型会消费规范化的搜索结果上下文。

#### KV Cache effect

不会直接导致失效；请求前缀变化由上述消费方负责。

## 已知限制与暂缓事项

- Tavily 的 score 和其他厂商专属搜索控制项没有公开，因为当前 web seam 没有对应的 provider-neutral 字段。
- 可选原始内容会映射到现有 `snippet` 字段；不会为厂商新增 `WebSearchSource` 内容字段。
- 动态凭据的可用性在操作内部检查，因为 `available()` 无法同步查询异步凭据存储。

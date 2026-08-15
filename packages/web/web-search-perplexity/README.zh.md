# @deepseek-ai/dsh-web-search-perplexity

[English](README.md) | 中文

由 [Perplexity](https://perplexity.ai) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.md)（`ctx.web`）。它调用 Perplexity 的 OpenAI 兼容 `POST /chat/completions` 端点，把生成答案与引用映射为 seam 规范化的 `WebSearchResult`。

这是一个**实现**包：它向 `ctx.web` 注册提供方，通过可选的 `ctx.credentials` seam 为每次搜索解析凭据，且不注册面向模型的工具。与 `@deepseek-ai/dsh-llm-deepseek` 一样，它是函数／命名空间插件（`inject: ['web']`）。OpenAI 兼容协议格式（wire format）是提供方私有细节，并**不**使该提供方依赖 `ctx.llm`。

已挂载的凭据服务具有权威性；没有该服务时，提供方会回退到启动进程的环境变量。每次搜索都会解析该引用，因此在 Web 的 Models 页中存储或轮换的密钥无需重启，即可用于下一次调用。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 未设置 | Perplexity API 密钥字面值。优先使用 `apiKeyEnv`，避免密钥进入配置；非空字面值优先。 |
| `apiKeyEnv` | `PERPLEXITY_API_KEY` | 每次搜索都会通过 `ctx.credentials` 解析该凭据引用；没有该 seam 时则从启动环境解析。值缺失时，调用以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。 |
| `baseURL` | `https://api.perplexity.ai` | 端点基址；追加 `/chat/completions`。无法解析时提供方不可用。 |
| `model` | `sonar` | 搜索模型名称。 |
| `maxTokens` | `1024` | 生成答案 token 上限（`max_tokens`）。必须是正整数。 |
| `searchRecency` | （未设置） | 以 `search_recency_filter` 发送的新近程度窗口：`day`、`week`、`month` 或 `year`。未设置时不发送过滤条件。 |

```yaml
- id: web-search-perplexity
  name: '@deepseek-ai/dsh-web-search-perplexity'
  config:
    apiKeyEnv: PERPLEXITY_API_KEY
    baseURL: https://gateway.internal
```

上面的条目是 `web-search-perplexity` Settings 段的 base 层。叠加其上的用户层会作用于下一次搜索，因为提供方会在操作开始时对完整配置段进行一次投影，而不是在注册时固化它。`apiKey` 带有 `role('secret')`，所以 Settings 描述只会公开是否已设置值，绝不会公开密钥字面值。

## 映射

`content` ← `choices[0].message.content`（生成答案）。`sources[]` 优先使用结构化 `search_results[]`（`url`、`title`、`snippet`、`publishedAt` ← `date`），否则回退到只含 URL 的 `citations[]` 数组；仅当不存在 `search_results` 时才采取这条回退路径。这些源只携带 `url`，因此 seam 上的 `title`／`snippet`／`publishedAt` 是可选字段。提供方失败以 `WebError` `WEB_PROVIDER_ERROR` 呈现；凭据缺失以 `WEB_PROVIDER_CREDENTIAL_MISSING` 呈现，调用方取消则以 `WEB_ABORTED` 呈现。在凭据解析之前或期间取消，不会发出 HTTP 请求。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。Perplexity 没有结果数量控制，因此 seam 会强制执行 `maxResults`（截断 `sources[]` 并设置 `truncated`）。

## 模型体验

### 辅助 Perplexity 请求

#### 模型看到的内容

独立的 Perplexity 模型通过 chat-completions 端点将 `<query>` 原样作为唯一用户消息接收。该请求不属于会话模型上下文。

#### Token 影响

每次搜索会产生独立的提供方 token；`maxTokens` 限制生成答案。

#### KV Cache 影响

与会话请求缓存相互独立。同一模型路由下的相同查询可能复用提供方缓存；查询或路由改变会建立不同前缀。

### 间接的会话工具结果

#### 模型看到的内容

通过 [`dsh-tool-web`](../tool-web/README.md)，会话模型会看到生成答案及结构化结果元数据，或只含 URL 的引用。该提供方的具体错误消息包括带处理指引的凭据缺失消息、`Perplexity search credential resolution failed: <error>`、`Perplexity search aborted`、`Perplexity search request failed: <error>` 和 `Perplexity returned an unprocessable response body: <error>`；HTTP 失败保留提供方消息。错误包装层属于消费方。

#### Token 影响

注册不会直接产生会话 token。答案与源 token 取决于数据，源数量受服务限制；保留的结果或错误会重复发送，直到发生压缩（compaction）。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **引用回退源只含 URL**：Perplexity 省略结构化 `search_results[]` 时，源不含 `title`／`snippet`／`publishedAt`，因此工具只渲染纯主机名标签。
- **超量返回的来源仍会增加 token 消耗和延迟**：协议没有结果数量控制，`maxResults` 只能由 seam 在事后截断。
- **只公开 `model`／`maxTokens`／`searchRecency`**：Perplexity 的其他搜索控制项（域名过滤条件、`web_search_options` 上下文大小、图片）有待提供方无关的 Service Definition 字段支持（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)）。
- **动态凭据的可用性在操作内部解析**：同步的 `available()` 可以确认解析器存在，但无法查询异步凭据存储。因此，选中的无密钥提供方会使搜索以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败；调用方取消在本地与凭据预检存在竞态，但无法强制任意凭据后端自行停止工作。

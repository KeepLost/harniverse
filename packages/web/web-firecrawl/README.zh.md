# @deepseek-ai/dsh-web-firecrawl

[English](README.md) | 中文

由 [Firecrawl](https://www.firecrawl.dev) 支持的 harness [web 能力 seam](../web/README.md)（`ctx.web`）聚合 provider。它注册一个 `firecrawl` provider，默认提供 Search（`POST /v2/search`），并可选提供 markdown Scrape（`POST /v2/scrape`）能力，使用原生 `fetch`，不依赖厂商 SDK。

这是一个带有 `inject: ['web']` 的函数／命名空间插件。它向 `ctx.web` 提供能力，不替换 aggregate service，也不新增 AI answer、crawl 或 extract 工具。已挂载的凭据服务具有权威性；只有没有该 seam 时才读取启动环境。每次 search 和 fetch 操作都会独立解析 Firecrawl 凭据引用；Firecrawl 基础 API 也允许匿名请求，因此未配置 key 是合法的。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 未设置 | 可选的 Firecrawl API key 字面值。优先使用 `apiKeyEnv`；非空字面值会直接使用。 |
| `apiKeyEnv` | `FIRECRAWL_API_KEY` | 每个操作解析的凭据引用；没有 credentials seam 时回退到启动环境。 |
| `baseURL` | `https://api.firecrawl.dev` | API 基址；追加 `/v2/search` 和 `/v2/scrape`。 |
| `includeSearchContent` | `false` | 启用时 Search 请求 `scrapeOptions.formats: ['markdown']`，并把每项受限内容映射到 `snippet`。 |
| `searchContentMaxChars` | `10000` | 每项 Search `snippet` 中可选 markdown/raw content 的最大字符数。 |
| `maxChars` | `100000` | Scrape markdown body 返回的最大字符数。 |
| `enableFetch` | `false` | 显式注册远程 Scrape adapter 作为 fetch provider。 |

```yaml
- id: web-firecrawl
  name: '@deepseek-ai/dsh-web-firecrawl'
  config:
    apiKeyEnv: FIRECRAWL_API_KEY
    includeSearchContent: false
    enableFetch: false
```

`apiKey` 带有 `role('secret')`。配置 key 时，Search 和显式启用的 Scrape adapter 发送 `Authorization: Bearer <key>` 与 `redirect: 'error'`；匿名请求省略 authorization header。任何请求都不会跟随重定向。Scrape 默认关闭，因为请求目标由远程 Firecrawl service 而非本地 HTTP provider 解析；只有在部署明确信任并控制该远程边界时才启用。

## 映射

Search 发送 `query`，并在操作提供 `maxResults` 时发送对应的 `limit`。它从不请求 AI answer。Firecrawl Search 的 `{results: []}`、`{success, data: []}` 和 v2 的 `{success, data: {web: []}}` 响应都会将 `url`、`title`、`description` 映射到可移植 source 字段。启用可选内容时，将 `markdown` 或 `content` 追加到 source 的 `snippet`，并由 `searchContentMaxChars` 限制；当前 seam 不会扩展厂商专属 source content 字段。

Scrape 发送 `{url, formats: ['markdown']}`，把返回的 `markdown`（缺少时使用 `content`）映射为 `text` 类型的 `WebFetchBody`。优先使用 `metadata.url` 作为最终结果 URL，缺少时回退到 `metadata.sourceURL` 和请求 URL；存在时，`metadata.statusCode` 成为目标状态。`maxChars` 限制 body 并设置 `truncated`。即使 Firecrawl API 响应本身为非 2xx，只要有目标正文也会保留；非 2xx 且没有目标正文，或成功响应没有目标正文，都会返回 `WEB_PROVIDER_ERROR`。

凭据解析、provider、网络、HTTP 和响应体失败以 `WEB_PROVIDER_ERROR` 返回；调用方取消以 `WEB_ABORTED` 返回。Firecrawl 匿名 API 路径允许没有 key。

## 模型体验

### 搜索结果 sources

#### 模型看到什么

模型通过 [`dsh-tool-web`](../tool-web/README.md) 接收可移植的 Firecrawl source URL、标题和 snippet，其中可选搜索 markdown 受 `searchContentMaxChars` 限制；最终 `maxResults` 限制由消费方负责。

#### Token 影响

此 provider 不会发起额外的模型推理请求；搜索内容和 source 元数据只影响选定的对话模型消费规范化工具结果时的上下文 token。

#### KV Cache effect

不会直接导致失效；请求前缀变化由上述消费方负责。

### Markdown fetch 结果（显式 opt-in）

#### 模型看到什么

只有在显式配置 `enableFetch: true` 时，模型才会通过 [`dsh-tool-web`](../tool-web/README.md) 接收作为 text fetch 结果的、受 `maxChars` 限制的 markdown body。Firecrawl key、目标传输元数据和 API 包装不会暴露。

#### Token 影响

只有返回的 markdown 会影响选定对话模型的上下文 token；此 provider 不会发起模型推理请求。

#### KV Cache effect

不会直接导致失效；请求前缀变化由上述消费方负责。

## 已知限制与暂缓事项

- Search 内容使用现有 `snippet` 字段，因为当前 web seam 没有 source 级 content 字段；更大的或结构化内容等待 provider-neutral 合同。
- Search 结果数量和 Scrape body 限制既是 provider 侧优化也是消费方可见限制；aggregate seam 仍负责 `maxResults` 的最终 source 截断。
- 目标状态和 URL 依赖 Firecrawl 元数据；缺少时使用请求 URL 与 API 响应状态作为可用回退。
- 远程 Scrape 不是本地公共目标策略，默认关闭；shipped fetch 路径是经过加固的 `web-fetch-http` provider。

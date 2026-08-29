# @deepseek-ai/dsh-web

[English](README.md) | 中文

**`WebRuntime`**（`ctx.web`）定义 harness 具备哪些 web 访问能力（搜索 web、抓取 URL），并通过多个提供方实现，不把模型约定绑定到某个厂商的 API 形状。

本包承担 web 能力的 Service Definition 角色。与 shell/fs 不同，它在一个 seam 上跨越搜索与抓取两种操作，每种操作都可能有多个提供方：

| 包 | 职责 |
|---|---|
| `@deepseek-ai/dsh-web`（本包） | Service Definition：服务、提供方注册表、选择策略、请求／结果词汇、`WebError` 分类体系 |
| `@deepseek-ai/dsh-web-search-deepseek` | 搜索提供方：DeepSeek 官方搜索 |
| `@deepseek-ai/dsh-web-search-exa` | 搜索提供方：Exa |
| `@deepseek-ai/dsh-web-search-perplexity` | 搜索提供方：Perplexity |
| `@deepseek-ai/dsh-web-search-tavily` | 搜索提供方：Tavily |
| `@deepseek-ai/dsh-web-search-brave` | 搜索提供方：Brave |
| `@deepseek-ai/dsh-web-search-kagi` | 搜索提供方：Kagi |
| `@deepseek-ai/dsh-web-firecrawl` | 聚合搜索与 Scrape 提供方：Firecrawl |
| `@deepseek-ai/dsh-web-fetch-http` | 抓取提供方：匿名公共 HTTP(S) |
| `@deepseek-ai/dsh-tool-web` | Consumer：面向模型的 `web_search`／`web_fetch` 工具 schema，构建于 `ctx.web` 之上 |

搜索与抓取没有共享请求 schema 或业务逻辑，但有意共用一个 seam：`ctx.web` 是单一 web 访问中间层，拥有一项提供方选择策略、一套中止／错误词汇和一个面向产品的「该 harness 如何访问 web」配置接口。成对的 `Search`／`Fetch` 方法保持并行是有意为之。

## 服务 API（`ctx.web`）

| 成员 | 语义 |
|---|---|
| `registerSearchProvider(provider)`／`registerFetchProvider(provider)` | 注册后端。同一能力类型下 id 重复时抛出 `WebError` `WEB_DUPLICATE_PROVIDER`。返回 disposer。随调用 fiber 一并 dispose（资源释放）。 |
| `registerProvider(provider)` | 将一个提供方的搜索和／或抓取能力作为一个生命周期单元注册。 |
| `listProviders(capability?)` | 返回不含机密的已注册提供方 id 与能力，可按能力筛选。 |
| `search(request, signal?)` | 解析搜索提供方并运行一次搜索。在结果上强制执行 `request.maxResults`（截断 `sources[]`，设置 `truncated`）。能力无法运行时抛出 `WebError`。 |
| `fetch(request, signal?)` | 解析抓取提供方并获取一个 URL。非 2xx 响应是结果，不会抛出异常。无法安全获取或表示资源时抛出 `WebError`。 |

提供方注册的是**能力**而非工具。`dsh-tool-web` 是面向模型的名称、描述、提示词指引、JSON Schema 和呈现的唯一归属方。

## 选择

选择绝不依赖注册、配置或 HMR（热模块替换）顺序：操作带有 `provider` 时使用它，否则使用配置的 `searchProvider` 或 `fetchProvider` 默认值。两者都没有时，操作必须显式提供 id；运行时不会自动选择或 fallback。`WebRuntime` 会注册一个包含两个默认值的实时 `web` settings 分节：

| 情况 | 执行 |
|---|---|
| 已配置 id 已注册且 `available()` | 运行该提供方 |
| 已配置 id 未注册 | `WEB_PROVIDER_CONFIGURED_MISSING` |
| 已配置 id 已注册但不可用 | `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` |
| 没有操作或配置的 id | `WEB_PROVIDER_DEFAULT_MISSING` |

失败分支会抛出 `WebError`；调用方按其结构化 code 和消息中的提供方 id 路由。提供方自身的同步 `available()` 是便宜的局部检查，**禁止发起网络调用**，也无法证明异步凭据存储中存在密钥。选中的不可用或无密钥提供方会直接失败；运行时不会切换到其他提供方。`dsh-tool-web` 永远不会调用 `available()`；工具通过 `ctx.web.search()`／`fetch()` 执行，并按抛出的 code 路由，因此提供方选择只有一个归属方。

## 词汇

`WebSearchRequest`（`query`、`provider?`、`maxResults?`）→ `WebSearchResult`（`content?`、`sources[]`、`truncated`）；每个 `WebSearchSource` 都有必填 `url` 与可选 `title`／`snippet`／`publishedAt`（Perplexity 引用可能只含 URL）。`WebFetchRequest`（`url`、`provider?`）→ `WebFetchResult`（最终 `url`、`statusCode`、`body`、`truncated`）；取消作为可选的直接 `AbortSignal` 参数传给 `search()`／`fetch()`。`WebFetchBody` 是这里拥有的封闭判别联合（`html` | `text`）；消费方使用 `switch` 实现穷尽检查，因此新增类型会导致编译失败，直到处理完毕。完整约定见 `src/types.ts`，其中也包含 `WebError` code 分类体系。

## 模型体验

通过 `dsh-tool-web` 间接影响；该工具会保留有界的规范化提供方数据，或者原样保留以下失败：已配置的提供方缺失、提供方不可用、无提供方、存在多个提供方以及 `Error: <message>`；本注册表自身不贡献提示词或 schema。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **提供方无关的搜索控制项仍然很少**：新近程度、域名过滤条件、区域提示与搜索深度暂缓至多个提供方都能诚实支持时（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)）。
- **`WebFetchBody` 没有 `pdf` 分支**：可提取文本的 PDF 支持属于明确的暂缓工作；封闭联合会使新增该分支成为三个 web 包中由编译强制执行的变更。
- **提供方支持的页面提取不属于 `fetch()` 范围**：Firecrawl/Tavily 风格的 `web_extract` 能力暂缓，而不会扩展抓取操作。

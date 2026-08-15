# @deepseek-ai/dsh-web-search-exa

[English](README.md) | 中文

由 [Exa](https://exa.ai) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.md)（`ctx.web`）。它调用 Exa 的 `POST /search` 端点并请求高亮摘要内容，把扁平 `results[]` 映射为 seam 规范化的 `WebSearchResult`。

这是一个**实现**包：它向 `ctx.web` 注册提供方，通过可选的 `ctx.credentials` seam 为每次搜索解析凭据，且不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。与 `@deepseek-ai/dsh-llm-deepseek` 一样，它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

已挂载的凭据服务具有权威性；没有该服务时，提供方会回退到启动环境。每次搜索都会解析该引用，因此在 Web 的 Models 页中存储或轮换的密钥无需重启，即可用于下一次调用。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 未设置 | Exa API 密钥字面值。优先使用 `apiKeyEnv`，避免密钥进入配置；非空字面值优先。 |
| `apiKeyEnv` | `EXA_API_KEY` | 每次搜索都会通过 `ctx.credentials` 解析该凭据引用；没有该 seam 时则从启动环境解析。值缺失时，调用以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。 |
| `baseURL` | `https://api.exa.ai` | 端点基址；追加 `/search`。无法解析时提供方不可用。 |
| `searchType` | `auto` | 以 Exa `type` 发送的检索模式：`auto`（由 Exa 决定）、`keyword` 或 `neural`。 |
| `numResults` | （未设置） | 请求不含 `maxResults` 时使用的默认结果数。未设置时不发送默认值。必须是正整数。 |
| `highlightsPerResult` | `1` | 每个结果请求的 highlight 句子数（Exa `highlightsPerUrl`）。必须是正整数。 |

```yaml
- id: web-search-exa
  name: '@deepseek-ai/dsh-web-search-exa'
  config:
    apiKeyEnv: EXA_API_KEY
```

上面的条目是 `web-search-exa` Settings 段的 base 层。叠加其上的用户层会作用于下一次搜索，因为提供方会在每次调用开始时对完整配置段创建一次快照，而不是在注册时固化配置。`apiKey` 带有 `role('secret')`，因此经过脱敏的 `describe()` 响应只报告该字段是否已设置，绝不会返回其值。

## 映射

Exa 返回扁平 `results[]`，不返回生成答案，因此省略 `content`。每项结果映射为 `WebSearchSource`：`url` ← `url`、`title` ← `title`、`snippet` ← 第一个非空的 `highlights[]` 条目（没有高亮摘要的结果缺少可移植的 snippet，会被丢弃）、`publishedAt` ← `publishedDate`。请求的 `maxResults` 优先于已配置的默认 `numResults`，并作为 Exa `numResults` 发送，以优化成本和延迟；最终上限由 seam 强制执行。提供方和凭据解析失败以 `WEB_PROVIDER_ERROR` 呈现，凭据缺失以 `WEB_PROVIDER_CREDENTIAL_MISSING` 呈现，调用方取消以 `WEB_ABORTED` 呈现。在凭据预检之前或期间取消不会发出 HTTP 请求。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题、首条 highlight 与发布日期，或将带有处理指引的凭据缺失消息以及确切的错误消息 `Exa search credential resolution failed: <error>`、`Exa search aborted`、`Exa search request failed: <error>` 和 `Exa returned an unprocessable response body: <error>` 置于消费方的错误包装层内；生成答案与提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **没有非空白高亮摘要的结果会被整个丢弃**：没有可映射的可移植 snippet，因此返回源可能少于请求数量。
- **只公开 `searchType`／`numResults`／`highlightsPerResult`**：Exa 的其他控制项（livecrawl、category、域名／日期过滤条件、全文内容）等待提供方无关的 Service Definition 字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)）。
- **动态凭据的可用性在操作内部解析**：同步的 `available()` 可以确认解析器存在，但无法查询异步凭据存储。因此，选中的无密钥提供方会使搜索以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败；调用方取消在本地与该预检存在竞态，但无法强制任意凭据后端自行停止工作。

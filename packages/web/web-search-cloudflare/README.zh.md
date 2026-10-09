# @deepseek-ai/dsh-web-search-cloudflare

[English](README.md) | 中文

由 [Cloudflare Web Search API](https://developers.cloudflare.com/web-search/) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.md)（`ctx.web`），注册 id 为 `cloudflare`。它使用原生 `fetch` 调用 `POST {baseURL}/accounts/{accountId}/ai/websearch/`。Cloudflare 会把查询经由你的某个 AI Gateway 转发给上游引擎（Ceramic.ai、Exa 或 Linkup），费用计入 AI Gateway 额度；如果使用网关上保存的引擎密钥（自带密钥，BYOK），则由引擎直接向你收费。

这是一个实现包，也是带有 `inject: ['web']` 的函数／命名空间插件。它向 aggregate web service 注册 provider，不新增工具，也不使用 LLM seam。已挂载的凭据服务具有权威性；只有没有该 seam 时才查询启动环境。每次搜索都会解析 token 引用，因此 Web Models 页面保存或轮换的 token 无需重启即可用于下一次调用。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 未设置 | Cloudflare API token 字面值。优先使用 `apiKeyEnv`；非空字面值会直接使用。 |
| `apiKeyEnv` | `CLOUDFLARE_API_TOKEN` | 每次搜索解析的凭据引用；没有 credentials seam 时回退到启动环境。缺失时调用以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。 |
| `accountId` | 未设置 | Cloudflare 账户 id，首次搜索前必须设置。为空或格式不合法（不是 1 到 64 个字母、数字、`_`、`-`）时，调用会在任何凭据解析或网络操作之前以 `WEB_PROVIDER_CONFIG_INVALID` 失败。 |
| `gatewayId` | `default` | 转发请求的 AI Gateway。每个账户都有一个名为 `default` 的网关。为空白时 provider 不可用。 |
| `engine` | `ceramic` | 作为 Cloudflare `provider` 字段发送的上游引擎：`ceramic`、`exa` 或 `linkup`。 |
| `byokAlias` | 未设置 | 网关上已保存的引擎密钥别名。设置后，若该别名未配置，Cloudflare 会让请求失败而不是回退到额度。必须是 1 到 64 个字母、数字、`_`、`-`，否则 provider 不可用。 |
| `baseURL` | `https://api.cloudflare.com/client/v4` | Cloudflare API 基址。无法解析时 provider 不可用。 |
| `snippetMaxChars` | `2000` | 每条结果保留的描述最大长度。必须是正整数。 |

```yaml
- id: web-search-cloudflare
  name: '@deepseek-ai/dsh-web-search-cloudflare'
  config:
    accountId: 0123456789abcdef0123456789abcdef
    apiKeyEnv: CLOUDFLARE_API_TOKEN
```

API token 需要 **Account > Workers AI > Read** 与 **Account > AI Gateway > Read** 两项权限。`apiKey` 带有 `role('secret')`，不会出现在脱敏的设置描述中。token 以 `Authorization: Bearer <token>` 发送。每个带凭据请求都使用 `redirect: 'error'`，会在访问目标前拒绝重定向。

## 映射

请求体包含：模型查询（`query`）、配置的 `engine`（作为 `provider`）、`options.gateway.id`、可选的 `byokAlias`，以及仅在请求带有 `maxResults` 时才发送的 `limit`（上限为 Cloudflare 的 10）。最终的 `maxResults` 限制由 aggregate web seam 负责。

Cloudflare 返回 `{ items, metadata }`，不含生成的答案，因此省略 `content`。每项结果将 `url` 映射为 `url`、`title` 映射为 `title`、`description` 映射为 `snippet`，并按 `snippetMaxChars` 截断（不会切开代理对）。没有可用 `url` 的条目会被丢弃，响应结构异常时返回空 sources 而不是报错。`imageUrl`、`faviconUrl` 与 `lastModifiedDate` 不做映射：可移植结构里没有对应字段，而且最后修改时间并不是发布日期。

凭据缺失以 `WEB_PROVIDER_CREDENTIAL_MISSING` 返回，账户 id 不可用以 `WEB_PROVIDER_CONFIG_INVALID` 返回，provider／网络／HTTP／响应体失败以 `WEB_PROVIDER_ERROR` 返回，调用方取消以 `WEB_ABORTED` 返回。Cloudflare 用四种封装报告 HTTP 失败（`errors[]`、`error[]`、单独的 `message`、`error.code`）；取到的第一条可用信息会变成 `Cloudflare web search failed: <detail>`，没有任何信息的响应体则变成 `Cloudflare API error (HTTP <status>)`。在凭据解析或请求发出前取消不会发送 HTTP 请求。

## 模型体验

### 搜索结果 sources

#### 模型看到什么

模型通过 [`dsh-tool-web`](../tool-web/README.md) 接收规范化且受 `maxResults` 限制的 source URL、标题，以及按 `snippetMaxChars` 截断的 snippet；没有发布日期。Cloudflare token、账户 id、网关 id、请求元数据及其他 provider 私有字段不会暴露。失败信息以原文 `Cloudflare search credential resolution failed: <error>`、`Cloudflare search request failed: <error>`、`Cloudflare returned an unprocessable response body: <error>`、`Cloudflare search aborted`、账户 id 与 token 的引导消息，或上述 HTTP 错误消息的形式，包在消费方的错误封装中到达模型。

#### Token 影响

此 provider 不会发起额外的模型推理请求。每条 snippet 最多 `snippetMaxChars` 个字符，这是决定一次搜索占用多少上下文的主要开关：仅 Ceramic.ai 每条结果就可能返回多达 8,000 个字符。

#### KV Cache effect

不会直接导致失效；请求前缀变化由上述消费方负责。

## 已知限制与暂缓事项

- **Cloudflare Web Search API 仍处于 beta** —— 请求和响应结构已于 2026-10-09 对照真实 API 核对，但其限制（查询 1,024 字符、结果 10 条）与价格可能变化。
- **超过 1,024 字符的查询会被 Cloudflare 拒绝** —— 表现为通用的 `Cloudflare web search failed: Invalid web search request body`；适配器不会截断或预先校验模型查询。
- **不公开引擎专属控制** —— Cloudflare 除 `provider` 与 `limit` 外没有提供其他控制，且当前 provider-neutral seam 也没有过滤器或时效性字段。
- **动态凭据的可用性在操作内部确认** —— 同步的 `available()` 只能确认解析器存在，无法查询异步凭据存储，因此选中了但没有 token 的 provider 会让搜索以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。账户 id 同样在搜索时检查，以便给出可操作的提示，而不是笼统的“不可用”错误。

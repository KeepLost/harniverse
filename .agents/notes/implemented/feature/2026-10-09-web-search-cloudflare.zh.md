# Agent Note: 新增 Cloudflare 作为 Web 搜索提供方

Status: implemented

[English](2026-10-09-web-search-cloudflare.md) | 中文

## Problem

Cloudflare 于 2026-10-02 发布了 Web Search API：`POST /accounts/{accountId}/ai/websearch/` 会把查询经由账户下的某个 AI Gateway 转发给 Ceramic.ai、Exa 或 Linkup，费用计入 AI Gateway 额度；如果网关上保存了该引擎的密钥（自带密钥，BYOK），则由引擎直接向用户收费。拥有 Cloudflare 账户和 API token 的用户此前无法在 `web_search` 中使用它：harness 只提供 DeepSeek、Exa、Perplexity、Tavily、Brave、Kagi 和 Firecrawl 这几个提供方。

Cloudflare 并不符合其他提供方共有的形态。端点路径里要有账户 id，请求体里要有网关 id；引擎是一个请求字段；成功响应是 `{ items, metadata }`，用 `description` 而不是 snippet；失败则以四种封装之一到达（`errors[]`、`error[]`、单独的 `message`、`error: { code }`）。它的描述最长可达 8,000 个字符（Ceramic.ai），而 seam 和 `dsh-tool-web` 都不会对其设限。

## Decision

新增插件包 `@deepseek-ai/dsh-web-search-cloudflare`，向 `ctx.web` 注册 provider id `cloudflare`，并持有 `web-search-cloudflare` 设置分节，做法与 `web-search-kagi` 完全一致：函数插件、`inject: ['web']`、每次搜索通过 `ctx.credentials` 解析凭据（没有该 seam 时使用启动环境）、每个带凭据请求都使用 `redirect: 'error'`。它被挂载进 base bundle，因此无需额外组合，就会出现在网页搜索卡片和 `web_search` 的提供方列表中。

该分节包含 `apiKey`（secret）、`apiKeyEnv`（默认 `CLOUDFLARE_API_TOKEN`）、`accountId`、`gatewayId`（默认 `default`）、`engine`（默认 `ceramic`，另有 `exa`、`linkup`）、`byokAlias`、`baseURL` 与 `snippetMaxChars`（默认 2,000）。上游引擎叫 `engine` 而不是 `provider`，因为 `provider` 在这里已经表示 harness 的 `ctx.web` 提供方。

账户 id 在搜索执行时检查，而不是放在 `available()` 里。为空或格式不合法时，调用会在任何凭据查询或请求之前以 `WEB_PROVIDER_CONFIG_INVALID` 失败，并提示去设置 `accountId`。如果让 `available()` 返回 false，用户只会看到“已注册但不可用”，不知道该改什么；缺少 token 的情况同样在操作内部报告。账户 id 限定为 1 到 64 个字母、数字、`_`、`-`，这也保证它放进 URL 路径是安全的。

`description` 映射为 snippet，并按 `snippetMaxChars` 截断；如果截断点会切开代理对，就多退一个单元。没有这个限制时，八条 Ceramic.ai 结果每次查询就可能把 64,000 个字符塞给模型。`lastModifiedDate`（仅 Exa 返回）不会映射到 `publishedAt`：它是修改时间，而可移植结构把 `publishedAt` 定义为发布或抓取时间。`limit` 只在请求带有 `maxResults` 时发送，并以 Cloudflare 的上限 10 封顶，因为更大的值会被 Cloudflare 以 HTTP 400 拒绝。

HTTP 失败按 `errors[]`、`error[]`、`message`、`error.code` 的顺序取第一条可用信息，形如 `Cloudflare web search failed: <detail>`；没有任何信息的响应体则为 `Cloudflare API error (HTTP <status>)`。

设置页在提供方选择器里新增了 Cloudflare 条目，包含 token、账户 id、网关 id、引擎、密钥别名、接口地址和 snippet 长度字段。`web-search-cloudflare` 同时加入 API 代理所服务的命名空间和 remote-runtime 快照同步的命名空间，因此该分节与其他提供方分节一样可读、可写，并会随 SSH 主机同步。

请求与响应结构、四种错误封装，以及 `limit` 大于 10 时的 400，都是在编写测试之前于 2026-10-09 用账户 token 对真实 API 观察得到的；测试使用的就是这些结构。

## Alternatives considered

**通过 `/ai/run` 推理端点搜索（请求中的另一个示例）。** 否决：它通过 AI Gateway 运行模型并返回生成文本，而不是来源，因此无法满足 `WebSearchResult.sources` 的契约。Workers 的 `env.AI.websearch()` 绑定同样不可行，因为 harness 并不运行在 Workers 中；这种情况下文档指定的路径就是 REST 端点。

**把 Cloudflare 的三个引擎暴露为三个提供方（`cloudflare-exa` 等）。** 否决：引擎只是同一个账户、网关和 token 下的一个参数，所以用带 `engine` 设置的单个提供方，就只需要一份凭据和一个设置分节。模型看到的是唯一的 `cloudflare` id，引擎由用户在设置中选择。

**从 `CLOUDFLARE_ACCOUNT_ID` 读取账户 id。** 暂不采用：设置页是主要配置路径，而账户 id 不是机密，再加一条解析规则就要多出分支和一套需要说明的优先级，却没有人提出这个便利需求。

**让描述不加限制地透传。** 否决：其他提供方返回的都是短 snippet，只有这一个返回整页内容。可配置的限制比给 `dsh-tool-web` 增加 snippet 上限的改动小，后者会影响所有提供方。

**把 `lastModifiedDate` 映射为 `publishedAt`。** 否决：这会在面向模型的来源列表里把修改时间标成发布日期。

## Consequences

在网页搜索卡片中选择 `cloudflare`，或通过 `DSH_WEB_SEARCH_PROVIDER` 选择它，会让 `web_search` 走 Cloudflare。用户必须设置 `accountId` 和 token（卡片会通过凭据服务写入 token）；在此之前，搜索会失败并提示去设置缺少的那一项。

snippet 限制意味着 Ceramic.ai 超过 2,000 个字符的描述默认会被截断；调高 `snippetMaxChars` 就是用模型上下文换取更多页面文本。Cloudflare 的 API 仍处于 beta，限制和价格可能变化；超过 1,024 个字符的查询会表现为 Cloudflare 通用的 `Invalid web search request body`，因为适配器不会预先校验模型查询。

该包的 47 个单元测试、客户端卡片测试和 API 代理设置测试均通过；该包以及 `ui-settings-plugins` 的每个文件行覆盖率与分支覆盖率都是 100%。设置了 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 时，`cloudflare.e2e.ts` 会对真实 API 运行该提供方以及注册到 `ctx.web` 后的路径（未设置则自动跳过），并已用账户 token 通过。`plugin-config.e2e.ts` 在真实的 Web 应用中选择 Cloudflare，确认 API 代理提供其分节。

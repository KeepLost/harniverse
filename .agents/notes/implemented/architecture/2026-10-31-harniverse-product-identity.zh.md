# Agent Note: Harniverse 产品身份与出站署名集中化

Status: implemented

[English](2026-10-31-harniverse-product-identity.md) | 中文

## 问题

出站请求对产品的标识各说各话。LLM 流量携带上游的 `deepseek-harness/1.0.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)`（来自 `dsh-llm` 的 `attribution.ts`），而 web 搜索提供方、DeepSeek web API 和 `web-fetch-http` 手写了过时的 `deepseek-harness/0.0.1` 常量（URL 注释有三种写法），HTTP 通知发送方自称 `harniverse-notification/1`，MCP 客户端自述为 `dsh-mcp-client/0.0.1`。所有未设置 `User-Agent` 的出口——语音转写、SenseVoice 模型下载、Brave/Kagi/Cloudflare/Tavily/Firecrawl、飞书与 Telegram 聊天适配器、SDK 的 GrantAccess 交换、chat-app 的状态探测——都随 Node fetch 隐式发出 `user-agent: node`。pi-ai 还有两条路由会在网络上丢失该身份：Codex 路由在合并调用方请求头之后又设置自己的 `User-Agent`，Google SDK 则向该头部追加内容。另外，DeepSeek Search API 的默认配置把触发搜索的用户原话（前 128 字符）作为 `ori_question` 随每次搜索发给搜索端点。

## 决策

- **一个身份包。** `@deepseek-ai/dsh-identity`（`packages/util/identity`）拥有产品身份：`APP_IDENTITY`、`userAgent()`、`attributionHeaders()`，以及新增的、面向协议客户端自述的 `clientIdentity()`。`dsh-llm` 的 `attribution.ts` re-export 该契约，适配器的导入和 `dsh-llm/attribution` 子路径都不变。
- **产品名是 `harniverse`。** 产品标识从上游的 `deepseek-harness` 改为 `harniverse`，渲染为 `harniverse/<version>`，不带 url 注释：下游没有公开的仓库主页，指向上游 URL 会构成错误归属。`AppIdentity.url` 变为可选；白标部署仍可传入。
- **版本号只有一个授予源。** 身份读取自己包的 manifest，`pnpm run release:dsh` 一步把该版本授予整个 dsh 家族（含工作区根），因此 User-Agent 永远不会标出仓库里不存在的版本。本次变更以 `1.0.0-rc.3` 发布。
- **所有产品自有的出站 HTTP 出口都携带身份。** 五处手写常量被替换（`web-deepseek-api`、`web-search-exa`、`web-search-perplexity`、`web-fetch-http` 的 `DEFAULT_USER_AGENT`、`notification-http`），MCP 的 `clientInfo` 改由 `clientIdentity()` 提供，上文列出的匿名出口现在显式设置该头部。`web-fetch-http` 保留其 `userAgent` 配置覆盖。通知协议头（`X-Harniverse-Event*`）是去重契约，名称不变。
- **pi-ai 的 fetch 钩子钉住身份。** `llm-pi-ai` 用 `enforceAttributionFetch` 包装传输层 fetch，在请求时、即所有库的请求头决策之后重设 `user-agent`。这在不打 vendor 补丁的前提下修复了 Codex 覆盖和 Google 追加两个问题。
- **`ori_question` 默认关闭。** `web-deepseek-api` 的 `sendOriginalQuestion` 默认值改为 `false`；未经用户开启，只有模型改写的查询词外发。理由：用户原话是用户内容；配置了非 DeepSeek 模型时其接收方与聊天提供方不同；而改写后的查询词已经携带了意图。

### 非目标（有意保持不变）

会话与亲和标识（`session_id`、`x-client-request-id`、`prompt_cache_key`、OpenRouter 亲和头）、SDK 指纹头（`X-Stainless-*`、`x-goog-api-client`、AWS 的 `x-amz-user-agent`）、目录路由上的服务商准入头（Codex 的 `originator`、Copilot 的 `Editor-Version`、Anthropic OAuth 的 `x-app`）、远程主机代理转发、无头 Chrome 与 Electron 的 User-Agent、以及子进程流量（pnpm、git）均维持现状：它们各有功能分量（prompt 缓存亲和、服务商准入要求或协议正确性），移除它们换来的隐私收益不值得承担弄坏提供方的风险。`x-deepseek-harness-compact` 名称不变：它是功能性流量标记，不是身份。

## 验证

- `packages/util/identity/tests/identity.spec.ts` 钉住身份事实、两种 `userAgent` 渲染、头部映射和 `clientIdentity`。
- `dsh-llm` 的 attribution 套件验证 re-export 契约不变，并断言 `harniverse` 默认值。
- 线上断言：DeepSeek web API 的捕获测试现在钉住 `user-agent`，exa/perplexity 的套件在线上断言它；notification-http 套件期望共享的 `userAgent()`；pi-ai 的 mock-server 套件仍证明署名压过 profile 头，新增单测钉住 `enforceAttributionFetch` 对 init 头和 `Request` 对象两种输入的行为。
- web-deepseek-api 的 settings 组合测试覆盖新默认值（关）、显式开启和再次关闭。
- `pnpm run release:dsh --no-commit 1.0.0-rc.3` 一次性授予整个 dsh 家族（工作区根与全部 330 个 manifest，含新包）；设置对话框金蛋随之更新。

## 备选方案

**保留 `deepseek-harness` 作为产品标识。** 否决：harniverse 才是用户运行的产品，其通知头早已自称 Harniverse，而诚实的标识正是署名的意义所在。对服务商而言这只是线上表现的无害变化。

**按适配器逐个灌输身份而非改默认值。** 否决：白标参数仍然可用，但为了改一个常量让所有适配器多背一层身份参数，是这个下游不需要的管道；在 fork 内改默认值并留说明是更小、更诚实的 diff。

**带运行时配置的 Cordis 身份服务。** 暂不采用：身份是静态公开事实，当前没有消费者需要配置，且既有的署名决策已否决配置门控。出现真实消费者时再引入服务。

**在全局 undici dispatcher 上强制该头部。** 否决作为主机制：它看不到 `ws` 包、`node:http` 直连、AWS SDK 流量和子进程，而且会把行为集中到每个包作者都看不见的地方。fetch 包装器留在 `llm-pi-ai` 内，需求在哪里它就在哪里。

**同时剥离 SDK 指纹头与会话头。** 否决：它们各有功能（缓存亲和、服务商准入），移除行为未对各服务商验证，混进本次变更会让影响面无法评审。作为非目标记录在案。

## 后果

- 服务商和端点将看到 `harniverse/1.0.0-rc.3`，取代两种产品四种写法；在网关日志中匹配 `deepseek-harness/...` 或 `harniverse-notification/1` 发送方取值的部署需要更新匹配规则。
- 之前混在通用 `node` 客户端里的流量（搜索提供方、聊天适配器、模型下载、语音）现在诚实地亮明产品身份。
- `docs/config-catalog.md`、`docs/subsystems/llm-streaming.md`、type-equivalence manifest 和受影响的 README 描述了新默认值与身份所有者。
- 本说明把 2026-06-21 强制署名决策的适用范围从"LLM 适配器"扩展到"所有产品自有的出站身份"；该决策的仅 User-Agent 契约和对 OpenRouter 头的拒绝继续有效。

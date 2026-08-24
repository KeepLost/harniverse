# @deepseek-ai/dsh-tool-web

[English](README.md) | 中文

面向模型的 web 工具套件 `web_search` 与 `web_fetch`，构建于 [web 能力 seam](../web/README.md)（`ctx.web`）之上。它只负责面向模型的事项：工具名称、JSON Schema、snake_case 参数名称、提示词区段、结果数量上限、结果格式、HTML→markdown 呈现，以及 UI 呈现投影——`presentCall`、`presentResult`（以 `kind: 'search' | 'fetch'` 区分的 `card: 'web'` 结果卡片），以及承载有损渲染文本无法携带的结构化搜索来源或抓取摘要的 `output.presentationMeta`（见 [web-result-card Agent Note](../../../.agents/notes/implemented/feature/2026-07-30-web-result-card.md)）。所有 web 访问都通过 `ctx.web`；该包绝不导入具体提供方。两个工具都不公开面向模型的超时：每个工具的协作式工具调用超时预算通过配置在此声明（`fetchTimeoutMs`／`searchTimeoutMs`，附加为 `ToolDefinition.timeoutMs`），由 [`@deepseek-ai/dsh-tool-call-timeout-policy`](../../guard/timeout-policy/README.md)（`tools/execute` 包装层）强制执行。单提供方操作会将 `exec.signal` 直接转发给 seam；多查询搜索则为兄弟查询构造合并信号，并在失败返回前等待批处理 quiescence。

每个工具独立注册；只需要其中一个工具的产品可以通过配置禁用另一个（`{ search: false }`／`{ fetch: false }`）。仅当抓取也通过配置启用时，搜索指引才会提及 `web_fetch`；仅启用搜索的组合则会要求模型使用返回的 snippet 并引用其 URL。

## 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `web_search` | `queries`（非空 string 数组） | 用于发现信息。并发运行最多 `searchMaxQueries` 个查询，去除完全相同的 URL 并公平合并来源。返回可选答案与来源 URL；多查询答案会按查询标记。`max_results` 和查询数量**不**面向模型：工具设置上限（`searchMaxResults` 默认 8，`searchMaxQueries` 默认 4），并逐个查询传给 seam。 |
| `web_fetch` | `url`（string） | 获取特定 URL。HTML 主体渲染为 markdown（turndown，带 GFM 表格／删除线）；文本主体原样通过。非 2xx 状态会报告，而非报错。工具调用超时是部署策略（`dsh-tool-call-timeout-policy`），不是模型参数。 |

两个工具都选择并发调度，因为提供方读取会返回内容，不会修改父 agent（智能体）的状态。

规范化后的服务结果也是标准工具值：`WebSearchResult` 与 `WebFetchResult`。原生渲染器会保留下文所述的答案、来源和抓取正文文本；提供方对搜索结果数量和正文大小的上限仍属于获取限制，而非仅用于呈现的截断。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `search` | `true` | 注册 `web_search`。 |
| `fetch` | `true` | 注册 `web_fetch`。 |
| `searchMaxResults` | `8` | 一次 `web_search` 调用返回的来源数量上限（seam 截断更长的提供方列表并标记）。 |
| `searchMaxQueries` | `4` | 一次 `web_search` 调用接受的非空查询数量上限；配置不能超过协议最大值 `16`，查询字符串在检查该上限后按完全相同值去重。 |
| `fetchTimeoutMs` | `30000` | `web_fetch` 的协作式工具调用超时预算（ms）。 |
| `searchTimeoutMs` | `30000` | `web_search` 的协作式工具调用超时预算（ms）。 |
| `fetchMaxOutputChars` | `200000` | 同步转换的源字符数与单次完整 `web_fetch` 输出的上限（状态头、渲染后的主体与页脚合并计算）；主体被截断时，在能容纳的情况下附带截断提示。 |

`fetchTimeoutMs`／`searchTimeoutMs` 声明每个工具的协作式超时预算（附加为 `ToolDefinition.timeoutMs`），由 [`@deepseek-ai/dsh-tool-call-timeout-policy`](../../guard/timeout-policy/README.md) 强制执行；面向模型的 schema 不公开超时参数。`fetchMaxOutputChars` 同时限制同步转换工作量和完整渲染结果：只转换至多该数量的源字符，随后对状态头、转换后的前缀和截断提示合并设限。默认值为本地提供方的 100,000 字符主体上限留出余量，但渲染膨胀仍可能使最终上限截断结果。

```yaml
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
```

<a id="search-query-contract"></a>

### 搜索查询契约

`web_search` 要求 `queries` 为包含 1 至 `searchMaxQueries` 个字符串的数组。模型 schema 会在执行前以 `INVALID_ARGS` 拒绝缺少 `queries`、标量旧式 `{ query: "..." }` 或非数组的 `queries`。通过 schema 后，空数组报告 `queries must contain at least one query`，空白项报告 `each query must be a non-empty string`，超限数组报告 `queries must contain at most <N> query` 或 `queries`，并且都不会调用提供方。完全相同的查询字符串在检查数量上限后去重，并保留首次出现顺序，因此重复查询不能绕过配置上限。

### 多查询搜索

下面的并发 fan-out、融合取消、quiescence、round-robin 合并和按查询标记答案规则，仅适用于验证后仍有至少两个不同查询的情况。单项数组是直接的单提供方操作。

不同查询会通过同一个 `ctx.web.search()` seam 并发执行。每次提供方调用仍只接收一个标量 `query` 与共享的 `maxResults` 上限；提供方适配器不实现批量 API。单项数组会为这次单提供方操作直接转发 `exec.signal`。融合批次则在一个兄弟查询失败时中止派生的兄弟信号，等待所有已启动的搜索 settle，然后才返回第一个失败；这种 quiescence 可避免工具失败后仍有迟到的兄弟结果发布，调用方取消也会中止该融合批次信号。

成功的批量结果按查询顺序进行来源 rank 的 round-robin 合并，跳过完全相同的 URL，并在 `searchMaxResults` 处停止；提供方或合并截断都会设置 `truncated`。非空的提供方答案按查询顺序保留为 `### <query>` 区段，使模型可以区分答案来源。单项数组直接使用提供方结果，但仍遵守相同的面向模型契约。

## 稳定注册

工具注册遵循产品**启用状态**，而非后端可用性。即使选中的提供方缺失、错误配置、存在歧义或暂时不可用，工具仍保持可见；seam 在执行时解析提供方，执行以结构化 `WebError`（例如 `WEB_PROVIDER_UNAVAILABLE`、`WEB_PROVIDER_AMBIGUOUS`）失败，`ToolRuntime.execute()` 会把它转为模型可读、钩子／UI 可路由的错误工具结果。这样无需把插件加载顺序、凭据状态或 HMR（热模块替换）时机纳入面向模型约定，也能保持模型 schema 稳定。要彻底移除 web 工具，请在此处通过配置将其禁用。

工具绝不会调用提供方的 `available()`，也不会枚举提供方；唯一执行路径是 `ctx.web.search()`／`ctx.web.fetch()`，提供方不可用时，选择机制会在执行阶段抛出结构化 `WebError`，其错误码由工具接收。提供方选择完全留在 seam 内，由单一主体负责。

## 模型体验

### 系统提示词

#### 模型看到的内容

搜索与抓取分别贡献以下 web-search 和 web-fetch 指引。搜索会在注册时根据配置选用启用抓取或仅搜索的文本。scope 工具限制不会移除这些独立注册的区段。

##### 启用抓取时的 Web 搜索指引

```markdown
Use the web_search tool to discover current information on the web. The required queries array accepts 1–4 non-empty search queries; use a one-item array for a single search. It returns an optional answer plus a list of source URLs. Follow up with web_fetch when you need the full content of a specific result, and cite the relevant URLs as markdown links.
```

##### 仅搜索时的 Web 搜索指引

```markdown
Use the web_search tool to discover current information on the web. The required queries array accepts 1–4 non-empty search queries; use a one-item array for a single search. It returns an optional answer plus a list of source URLs. Use the returned source snippets when available, and cite the relevant URLs as markdown links.
```

##### Web 抓取指引

```markdown
Use the web_fetch tool to retrieve the content of a specific HTTP(S) URL (for example a result from web_search). It returns the page content decoded to text. Cite the URL as a markdown link when you use its content.
```

#### Token 影响

每个通过配置启用的工具都会为每次请求增加固定的指引 token 开销，即使限制隐藏了其 schema。切换抓取状态不仅会注册或移除抓取区段，也会更改搜索指引。

#### KV Cache 影响

只要启用工具、scope 与指引文本不变，前缀就保持稳定。配置启用状态（包括因切换抓取状态而改变搜索指引分支）或插件生命周期可能使从第一个变化的提示词区段起的复用失效；scope schema 限制不会移除该区段。

### 工具 schema

#### 模型看到的内容

模型会看到生成的 [`web_search` 与 `web_fetch` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-web)。结果数量与超时预算属于部署设置，不是模型参数。

#### Token 影响

每次请求都会产生固定的 schema token 开销；通过配置禁用会同时移除 schema 与指引，scope 限制只移除 schema。

#### KV Cache 影响

只要定义与可见性不变，前缀就保持稳定。配置启用状态、插件生命周期或 scope 限制可能使从第一个变化的 schema token 起的复用失效。

### 搜索结果

#### 模型看到的内容

可选的提供方答案之后是 `Sources:`，再跟随内容取决于数据且格式严格为 `- [<title-or-url>](<url>)` 的行，并可添加后缀 ` — <snippet> (<publishedAt>)`。既无答案也无来源时，结果显示 `No results found.`。列表被截断至上限时会添加 `(Showing the first <count> sources. Refine the query for more.)`；每个结果都以 `Cite the relevant URLs above as markdown links in your answer.` 结尾。

#### Token 影响

数据相关结果会重复发送直到压缩（compaction），来源数量由 `searchMaxResults` 限制。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 抓取结果

#### 模型看到的内容

成功抓取的精确形状是 `Fetched <finalUrl> (HTTP <statusCode>)`、一个空行，以及由提供方返回的已解码正文。发生截断时会再添加一个空行和 `(Content truncated. Fetch a more specific URL or section for the full text.)`；失败变为 `Error: <message>`。查询与 URL 保留在调用历史中。

#### Token 影响

提供方上限限制主体大小；保留的调用参数与结果会重复发送直到压缩，超时策略可以把迟到结果替换为简短错误。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 参数错误

#### 模型看到的内容

空白 URL 输入精确地变为 `Error: url must be a non-empty string`；搜索参数形状错误要么是 schema 层的 `INVALID_ARGS`，要么是上文[搜索查询契约](#search-query-contract)中的 `queries` 数组验证消息。

#### Token 影响

只有失败调用会增加这些保留 token。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **HTML→markdown 转换会在 GFM 无法安全表示的输入上降级**：[turndown](https://github.com/mixmark-io/turndown)（带 GFM 表格／删除线）通过真实 DOM 转换至多 `fetchMaxOutputChars` 个源字符。保守的 512 层词法守卫会将深层或嵌套有歧义的主体作为原始 HTML 直接透传，转换异常也会如此处理；表格的 `colspan` 会被忽略，因为 GFM 无法表示跨列单元格。这些限制可避免阻塞事件循环，也避免不受信任的数值属性使输出膨胀（[已归档的依赖决策](../../../.agents/notes/archived/simplification/2026-07-26-turndown-for-tool-web-html-markdown.md)）。
- **面向模型的接口有意保持精简，后续扩展暂缓**：`max_results` 保持为配置上限（不是模型参数），`web_fetch` 只接受 `url`（没有 `format`／`prompt`／LLM（大语言模型）摘要模式）；两项都列为 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) 中的后续步骤。
- **没有 web 专用权限策略**：两个工具都不会请求 `ctx.approval` 就直接执行；需要确认的部署必须添加 `tools/pre-execute` 策略，该包不定义持久化的 URL／域名授权。

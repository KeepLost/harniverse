# @deepseek-ai/dsh-llm-deepseek

[English](README.md) | 中文

Harness LLM 接缝的 DeepSeek 适配器，通过直接 `fetch` + SSE（由 `eventsource-parser` 分帧）同时讲两种官方线协议：**Messages**（Anthropic 兼容内容块与原生思考重放）和 **Chat Completions**（OpenAI 兼容格式；事实来源：API 文档 —— guides/thinking_mode、guides/tool_calls、api/create-chat-completion），各自翻译为 `StreamChunk` 协议。

同一接缝还存在第二个由库支撑的实现 `@deepseek-ai/dsh-llm-pi-ai`。本包拥有 `deepseek-official` 提供方路由 —— 与 pi-ai 的目录名 `deepseek` 刻意区分，因此一个组合可以并排挂载两条 DeepSeek 路径；为 `deepseek-official` 再注册一个适配器仍会抛出 `LlmError('DUPLICATE_ADAPTER')`。

包根暴露 Cordis 插件契约与 `DeepSeekAdapter`；线序列化、SSE 解析与 chunk 翻译助手不属于该根契约。

## 配置

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY  # default; resolved per request via ctx.credentials, then the environment
    protocol: messages           # messages | chat-completions; default follows the endpoint (see below)
    baseURL: https://api.deepseek.com # optional; $DEEPSEEK_BASE_URL then the official endpoint when omitted
    thinking: enabled        # optional; provider default is enabled
    reasoningEffort: high    # optional; off | low | high | max — omitted ⇒ high
    maxTokens: 256000        # optional positive per-request output cap; this is the default
    streamIdleTimeoutMs: 300000 # optional; positive finite Node timer delay; five-minute default
    retryPolicy:             # optional; omission uses bounded normal defaults
      mode: always           # normal | always
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
    defaultContextWindow: 1000000 # optional positive-integer fallback; this is the default
    models:                  # optional; defaults to V41 Flash and V4 Pro
      - id: deepseek-v4-flash
        name: DeepSeek-V4-Flash
       - id: private-reasoner
         description: Company-hosted reasoning model
         contextWindow: 512000
         inputModalities: [text, image] # image routes opt into request-image projection
         imagePixelBudget: low           # optional: "low" (512×512 preset) or a positive pixel count
         imageMaxBytes: 1048576          # optional encoded bytes for one request version
     maxRequestFilesBytes: 134217728    # optional aggregate file-reference budget
     maxInlineRequestImageBytes: 20971520 # optional aggregate inline fallback budget
     maxImagesPerRequest: 600            # optional retained image count
     filesApiTimeoutMs: 60000            # optional Files API resolution timeout
```

`protocol` 选择线实现。显式值按配置生效；缺省时官方 Messages 根 `https://api.deepseek.com/anthropic` 为默认，而任何自定义 `baseURL`（或来自可信环境层的 `$DEEPSEEK_BASE_URL`）保持 `chat-completions`，直到运维显式切换为 `messages` —— 自定义基址通常是无法服务 Messages 线协议的 OpenAI 兼容网关。Messages 的 `baseURL` 必须是不含凭据、query 或 fragment 的 HTTP(S) 根，派生请求路径时不会重复尾部的 `/v1`。Messages 请求以 `x-api-key` 加 `anthropic-version: 2023-06-01` 认证；chat-completions 请求使用 `Bearer` 授权。两种协议都拒绝 HTTP 重定向（`redirect: 'error'`），凭据因此绝不会被重放到第二个源。

插件注册唯一的提供方路由 `deepseek-official` 及其解析后的 `retryPolicy`。请求以 `provider: 'deepseek-official'` 选中它；其 `model` 原样作为线 `model` 字符串传递，因此更换 DeepSeek 模型不需要生命周期时的重新注册。省略 `models` 时通告 `deepseek-flash`（`DeepSeek-V41-Flash`，1,000,000 token 上下文、文本与图片输入、历史内系统提示更新）与 `deepseek-v4-pro`（`DeepSeek-V4-Pro`，更强的代理式编码与困难推理，仅文本）；显式列表整体替换这些默认值，`models: []` 则不通告任何模型。目录条目经 `ctx.llm.listModels('deepseek-official')` 暴露给 ACP 编辑器、Web 选择器等客户端，但仅为建议性质：未列出的模型 id 仍原样通过。条目省略名称时默认取其 id。

`contextWindow` 为每个已配置模型的可选字段，且不经过建议目录暴露。`ctx.llm.resolveModelInfo('deepseek-official', model).context` 先取模型精确值，再对无容量条目或未列出的透传 id 取 `defaultContextWindow`。适配器默认值为 1,000,000；压力敏感插件因此获得部署自有的容量，而不把模型选择器当作权威。为 `deepseek-official` 注册另一个适配器会抛出 `LlmError('DUPLICATE_ADAPTER')`。

`maxTokens` 是适配器配置的会话请求输出上限，默认 256,000。目录条目可携带自己的 `maxTokens` 并在该模型上胜出；无此字段的条目与任何未列出的透传 id 回退到 profile 值，因此为单个模型加上限只改变该模型而非整条路由。精确模型解析把胜者暴露为 `defaultMaxTokens`；`LlmRuntime` 在 agent 循环写入 `request/header` 前把它物化为 `GenerateOptions.maxTokens`，线请求因此可重建。显式请求或 `AgentOptions.maxTokens` 值胜出并序列化为 `max_tokens`。适配器不依据 `contextWindow` 收紧该请求预算；上下文或提供方输出上限更小的部署必须配置兼容的 `maxTokens`。

目录模型在 `inputModalities` 显式包含 `image` 之前均为纯文本。对具备图片能力的模型，适配器经 `ctx.attachments` 读取持久图片引用，派生有界请求版本，并发送 DeepSeek Files API 引用或单一全内联的回退表示。超出聚合字节或数量预算时先省略较旧的图片；一个请求绝不混合文件引用与内联图片。默认目录的 `deepseek-flash` 条目具备图片能力，因此官方 V41 Flash 路由无需额外配置即可服务请求图片。

同一个精确模型结果还在部署策略允许思考时，为每个透传模型在 `reasoning` 下暴露有序的 `off`、`low`、`high`、`max` 档位。`reasoningEffort` 选择部署默认值，缺省回退为 `high`。`agent/request` 可在每一步会话上替换它；解析值记录于 `request/header`。`low`、`high`、`max` 启用思考 —— chat-completions 把它们序列化为官方顶层 `reasoning_effort`，Messages 序列化为 `output_config.effort`；适配器自有的 `off` 则序列化 `thinking.type: disabled` 并省略档位字段。不支持的值在网络 I/O 之前以 `UNSUPPORTED_REASONING_EFFORT` 失败。

`thinking: disabled` 是部署锁，只发布 `off` 且以 `off` 为默认。省略 `reasoningEffort` 或配置为 `off` 均合法；配置任何其他值都会使插件加载失败，绕过配置直接按请求启用思考同样在网络 I/O 之前失败。`GenerateOptions.purpose: 'session-title'` 的请求也会强制关闭思考并省略已解析的档位，把有界输出留给可见的标题文本，而不改变会话或压缩默认值。

Messages 请求携带原生思考重放：每个响应在持久助手内容旁保存一版按块签名的封套，对同一模型的下一次请求会随思考块重放这些签名。跨模型、外来或不可用的重放元数据被静默丢弃 —— 一行诊断指名提供方路由与原因，不暴露内容或签名 —— 持久内容改以提供方中立形式发送。不再能解析为 JSON 对象的历史工具实参以空输入过线，持久历史保持字节稳定。

`streamIdleTimeoutMs` 约束每次未完成的提供方读取（含首次 `fetch`），不统计消费者在 chunk 之间的时间。提供方 SSE 注释会为未完成的读取续活动窗口，但绝不成为 `StreamChunk` 值或会话日志事件。一个稳定的中止信号贯穿整次调用的请求与 body 读取；超时停止传输并抛出 `LlmError('TIMEOUT')`，更早的调用方中止抛出 `LlmError('ABORTED')`。适配器对每次 `stream()` 调用恰好发出一个提供方请求；它把配置的策略注册为提供方元数据，`dsh-llm-retry` 另在持久 agent 步边界执行它。

## 动态配置（settings + credentials）

连接事实不冻结于加载时。`resolveAdapterOptions` 是从原始配置到已校验事实的唯一显式解析步，适配器通过 thunk **每次操作重读一次**：协议、基址、目录、请求默认值与空闲预算都在下一次请求生效，而进行中的流保持其启动时的事实。两个可选接缝为该 thunk 供数：

- **`ctx.settings`** —— 插件以同一 `Config` schema 注册 `llm-deepseek` 命名空间，并将其 `cordis.yml` 条目作为组合 `base`，因此用户设置文档中的 `llm-deepseek:` 小节无需重启即可覆盖任意字段。未挂载设置服务时仅由条目配置驱动，行为不变。通过 schema 但未通过超 schema 界限的在线设置快照（重复目录 id、损坏的思考/档位组合）保持上一份正确事实并记录失败；条目配置本身仍使插件加载失败。
- **`ctx.credentials`** —— API key 每次流调用解析，来自供给端点的*同一份*已解析快照。配置只携带 `apiKeyEnv`，绝不携带字面 key：引用经凭据接缝解析，无接缝时经可信环境层解析。由于凭据事实与连接事实同行，被解析器拒绝的设置快照既不贡献端点也不贡献 key：上一代整体继续服务。每个解析出的 key 在使用前都做格式检查，无法放进 HTTP 头的值会以 `LlmError('INVALID_CREDENTIAL')` 失败并指名失败的入口 —— 绝不包含 key 的任何部分 —— 而不是表现为不透明的 `fetch` `TypeError`。无处可取 key 的请求以 `MISSING_CREDENTIAL` 失败并指名每个配置入口，路由保持注册、目录保持可浏览 —— 首次运行的引导是“浏览模型、存 key、再提示”，中间无需重启。

唯一的注册期捕获事实是重试策略：其解析值变化时，插件原地重注册路由（同一适配器实例、一个同步小节），因此 `ctx.llm.providerRetryPolicy('deepseek-official')` 始终报告当前策略。

插件还在可配置提供方目录（`ctx.llm.listConfigurableProviders()`）中声明自己的路由：提供方 `deepseek-official`、设置命名空间 `llm-deepseek`、空设置路径 —— 整个小节即 profile。配置面利用该条目把本适配器与休眠的 pi-ai 提供方并列展示。

DeepSeek Files 映射是提供方本地且按协议作用域的。它们以端点/API key/协议作用域哈希与请求图片变体为键，存放在 `DSH_HOME/llm-deepseek` 之下并仅限属主权限，绝不进入 Session 事件或通用附件引用。两种协议共享同一 Files API 表面但各有线风格：chat-completions 使用 OpenAI 形状对象与 `purpose: user_data`；Messages 使用 Anthropic 形状对象（`x-api-key`、`anthropic-beta: files-api-2025-04-14`），从请求的生存期合成过期时间，并在文件操作上始终发送 beta 头。引用文件 id 的会话请求只在请求体确实携带文件引用图片时附带该 beta 头。缓存映射在过期前刷新；配额响应只删除 harness 拥有的文件后重试一次，指名过期文件 id 的响应对该作用域清空并以内联形式重试同一请求。

## 应用归因

每个请求都携带来自 dsh-llm `attributionHeaders()` 的共享归因头 —— 标识 harness 的强制 `User-Agent` 基线（见 [dsh-llm § 应用归因](../llm/README.md#app-attribution-attributionts)）。直接 DeepSeek 请求与 OpenAI 兼容网关请求在本适配器契约下不携带提供方特定的应用归因头；OpenRouter 应用归因推迟到未来显式的 OpenRouter 适配器或模式。`GenerateOptions.purpose` 为 `compaction` 的请求（dsh-compaction-basic 的辅助摘要调用）额外携带 `x-deepseek-harness-compact: 1`，宿主因此能把压缩流量与会话请求区分开。

DeepSeek 请求标识独立于应用归因。凭据解析后，每个提供方请求都携带来自 [`@deepseek-ai/dsh-anonymous-user-id`](../../identity/anonymous-user-id/README.md) 的稳定匿名 id 作为 `x-deepseek-harness-user-id`；携带 `GenerateOptions.sessionId` 的请求还把该值原样作为 `x-deepseek-harness-session-id` 发送，无会话的直接调用则省略会话头。两个头都发往解析后的 `baseURL`（含配置的网关），且保持在请求体与模型可见内容之外。

## 协议格式说明

Chat Completions：

- 仅流式（始终开启 `stream_options.include_usage`）。`usage` 可能附着在收尾 chunk 上或作为仅 usage 的尾随 chunk 到达 —— 翻译器把两者都推迟到 `[DONE]`，因此 `usage` 总在 `finish` 之前且 `finish` 之后无内容。
- 适配器自有的 `off` 档映射为 `thinking: {type: 'disabled'}`，绝不以 `reasoning_effort: 'off'` 过线；`low`、`high`、`max` 原样过线。
- 首个思考模式 chunk 携带 `reasoning_content: ""` —— 已处理（不会产生多余的思考块）。
- **推理回传规则**：每个携带推理的助手回合都把 `reasoning_content` 序列化回历史。思考模式在工具调用回合要求它；DeepSeek 在别处忽略它，而兼容网关可以哈希回传文本以恢复上游思考签名。
- 缓存核算：`cacheReadTokens` ← `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`；DeepSeek 不报告缓存写指标。

Messages：

- 仅流式，发往 `<messages 根>/v1/messages`；`message_stop` 终结交互，`usage` 先于 `finish`。
- 思考块从持久封套重放原生签名；文本与工具块绝不携带签名。
- 工具结果包裹其内部内容并分组在其他用户内容之前；工具调用必须与紧随的结果配对（未配对的历史在网络 I/O 之前以 `INVALID_REQUEST` 失败）。
- 声明 `systemPromptUpdate: 'in-history'` 的模型把后续系统更新作为历史内 `system` 消息接收，并在其跟随的用户回合之后刷入；其他模型只看到起始系统快照。
- 缓存核算：`cacheReadTokens` ← `cache_read_input_tokens`，`cacheWriteTokens` ← `cache_creation_input_tokens`。
- 带内 `error` 事件通过与 HTTP 错误相同的提供方失败分类器归一化。

## 错误

非 2xx 响应抛出带稳定代码的 `LlmError`：`AUTH`（401/403、`authentication_error`/`permission_error`）、`QUOTA`（402 或提供方细节表明配额、余额或额度耗尽的响应）、`RATE_LIMIT`（其他 429、`rate_limit_error`）、`CONTEXT_WINDOW_EXCEEDED`（提供方代码、类型或消息表明上下文溢出的 400）、`INVALID_REQUEST`（其他 400、413、`invalid_request_error`）、`SERVER`（5xx、`api_error`/`overloaded_error`），否则 `HTTP_<status>`。其可序列化的 `failure` 保留 HTTP 状态，加上有效的正 `Retry-After` 秒数/日期延迟，以及出现时的 `request-id` / `x-request-id` / `x-deepseek-request-id`。响应前的传输失败（DNS、拒连、TLS、代理）抛出 `TRANSPORT` 并指名配置端点、把原始拒绝链为 `cause`；调用方中止抛出 `ABORTED`，循环的取消信号保持权威。协议违规抛出 `STREAM_CLOSED`（chat-completions 缺 `[DONE]`；Messages 缺 `message_stop`）或 `MALFORMED_RESPONSE`（坏的 JSON 载荷、畸形事件字段）。以非 `max_tokens` 原因完成的 Messages 流会拒绝不能解析为 JSON 对象的工具实参；`max_tokens` 下的截断保留部分 JSON 交由共享装配器修剪。停止收尾却未开启任何内容块的完成流成为 `finish {kind: 'error'}`，代码 `EMPTY_RESPONSE`（默认策略重试）。

当 agent 循环提供其运行时线观察者时，本适配器为每次直接 fetch 尝试追加一条 `llm/wire-attempt` 记录（`api: 'chat-completions'` 或 `api: 'messages'`），包括内部的过期文件回退请求。它记录紧凑的请求元数据与规范指纹，不复制 Session 消息、系统文本或工具；响应状态与精选诊断头随归一化的失败或成功的流结果一起记录。

## 模型体验

### DeepSeek 请求

#### 模型看到的内容

选定的 DeepSeek 模型收到 harness 系统提示、消息历史、工具 schema、停止序列与调用配置，没有适配器自撰的提示散文。chat-completions 把每个先前带推理的助手回合的推理内容逐字回传；Messages 在这些块旁重放原生思考签名，并把请求图片渲染为内容部件。具备图片能力的路由还把持久用户与嵌套工具结果图片作为有界内容部件发送。每张图片前置其附件 id 与请求尺寸；提供方看到 Files API 文件引用或内联数据，而 Session 历史只保留持久附件引用。

#### Token 影响

提供方分词决定精确输入。推理回传（chat-completions）或签名重放（Messages）把每个带推理回合的思考链带入后续请求；可用时报告缓存读用量，Messages 额外报告缓存写用量。

#### KV Cache 影响

未变更的装配前缀有资格获得 DeepSeek 缓存复用，本适配器在用量中报告它。模型路由变更或任何上游提示、schema、前缀或历史变更都可能从首个变更 token 起阻止复用；推理重放在每个带推理回合适加。

### DeepSeek 响应

#### 模型看到的内容

推理、文本与原始字符串工具实参被翻译为 harness chunk，供循环记录与装配。工具调用的 `id` 与 `name` 是身份，因此重复它们为空或 null 的续联 delta 不会覆盖已确立的值。

#### Token 影响

生成的 token 遵循请求记录的推理档位与 `maxTokens`；只有循环保留的块影响后续输入。

#### KV Cache 影响

循环保留的响应块附加到下一次请求并保持其先前可复用的前缀；被丢弃的块没有后续缓存效应。更换提供方或模型会选择不同的缓存域，且 Messages 重放签名仅在单一模型内可移植。

## 已知限制与暂缓事项

- **设置的 `models` 列表整体替换组合列表** —— 设置层合并按字段进行，而数组是一个字段；按条目的目录合并需要带键的形状。
- **未映射 `tool_choice`** —— 不属于核心词汇表（MVP 裁剪，与 pi-ai 孪生一致）。
- **请求使用原始 `fetch` 而非 `@cordisjs/plugin-http`** —— 没有共享的代理/拦截配置；要等第二个适配器需要它时再引入（`TODO(http)`）。
- **chat-completions 序列化把用户与工具结果内容拍平为文本块** —— 插件新增的块类型被跳过，空工具输出以字面量 `(no output)` 过线。
- **DeepSeek 图片输入按模型选择加入** —— 纯文本目录条目不服务图片，替代附件提供方必须实现 `readImageRequest`，图片路由才能服务图片。
- **Files 映射是缓存而非持久模型状态** —— 删除本地索引或丢失远端文件会导致重新上传或内联回退；无需 Session 迁移。
- **不支持 Messages API 扩展** —— 官方 Messages 表面的提供方扩展字段与接受回调不在本适配器范围内。

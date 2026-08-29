# Agent Note: Web provider aggregation and explicit selection

Status: implemented

[English](2026-08-29-web-provider-registry-and-selection.md) | 中文

## Problem

Web 能力包含独立的搜索与抓取操作，而同一个厂商可能同时实现两者，另一个厂商可能只实现其中一项。面向模型的工具还需要使用工具插件启动后才注册的 provider，包括通过动态 Cordis runner 创建的临时 Host 插件。如果按注册顺序选择，或在失败后静默切换 provider，结果来源和行为都会变得不清晰。

## Decision

`WebRuntime` 在每个 `ctx.web` 实例中拥有一个注册表，并暴露 `search` 与 `fetch` 两种能力类型。一个 provider 可以注册其中一项或两项，并以一个聚合 `WebProvider` 作为生命周期单元；disposer 会移除该 provider 贡献的所有能力。旧的 `registerSearchProvider` 与 `registerFetchProvider` 仍作为单能力包装方法保留。

每项操作都接受可选的开放字符串 `provider` id。执行时按以下顺序选择：

1. 操作显式给出的 provider id。
2. 该能力配置的默认 provider。

两者都没有时，操作以 `WEB_PROVIDER_DEFAULT_MISSING` 失败。选中的 provider 未知或不可用时，直接返回结构化 `WebError`；运行时不会自动选择、聚合、重试或回退到另一个 provider。搜索与抓取在实时 `web` settings 分节中拥有独立默认值。settings 和 composition 环境值表示默认选择，不表示凭据，也不引入隐藏重试行为。

`listProviders(capability?)` 返回脱离注册表且不含机密的 provider id 与能力类型。面向模型的 `dsh-tool-web` consumer 在动态提示词上下文中使用这份实时目录，并保持 provider 参数为开放字符串，而不是生成静态枚举。因此，工具 schema 组装后注册的 provider 可以参与下一次操作，其 id 也会出现在下一次提示词组装中。未知 provider 的错误同样会列出当前已注册的 id。

Provider 插件拥有完整的厂商集成：端点构造、凭据、请求与响应映射、取消、边界和 provider 错误。一个 provider 可以暴露多项操作，但这些操作不因此共用面向模型的 schema。Firecrawl 采用这种聚合形状提供 Search 与 Markdown Scrape；Tavily、Brave、Kagi、Exa、Perplexity 和 DeepSeek 提供搜索，匿名 HTTP provider 提供抓取。

动态 Host 插件可以注入 `web`，并在 `cordis_run` 期间注册结构化 provider。`cordis_define` 只保存源代码，写入磁盘的普通 package 不会被这份注册表自动发现。动态注册跟随插件 fiber，在 stop、undefine、插件卸载或进程重启时消失。共享进程注册表意味着运行中的动态 provider 可能对其他 session 可见；动态 Cordis 仍是选择加入的可信运行时扩展，而非安全边界。

Provider 凭据使用已有的 `ctx.credentials` contract，并在每次操作时解析。设置界面通过 `credentials.set` 写入，只展示 configured/source/writable 状态。既有优先级保持不变：进程环境变量、托管凭据文件、项目 `.env`、用户 `.env`；Web provider 不创建例外。Provider 专属配置留在其 provider namespace 中，模型参数既不携带 key，也不携带厂商私有控制项。

`dsh-tool-web` 对所有 provider 结果应用相同的面向模型不可信内容边界，包括 provider 生成的 Markdown。`artifact_read` 拥有自己的无条件 artifact 边界，不共享 Web 清理或 marker 逻辑。

## Alternatives considered

**每项操作各自拥有一个 provider 注册表。** 内部仍然分开注册表，因为搜索与抓取的 contract 不同；但一个厂商同时拥有两项能力时，公开注册的生命周期单元使用聚合形状。这避免重复凭据和部分 teardown，又不会强迫无关能力共用一个接口。

**隐式选择唯一 provider。** 改为显式默认值或操作 id。拥有多个 provider 的部署不应从 Loader 或 HMR 顺序获得语义，没有默认值的部署也应明确告诉模型缺少什么。

**自动 fallback 或 provider 聚合。** 不采用。fallback 会在调用方已经选择 provider 后改变授权、成本、延迟和结果来源。合适时，调用方可以使用另一个 id 发起新的显式工具调用。

**静态 provider 枚举或单独的 provider-list 工具。** 不采用。动态 Cordis provider 可以在工具 schema 生成后出现。开放字符串、实时提示词目录和可行动的选择错误可以保持工具 schema 稳定，也不增加一次模型往返。

**扫描文件或 npm 名称加载 package。** 不采用。普通 package 仍由 Loader composition 负责，临时内存 package 由 dynamic runner 负责。WebRuntime 只消费当前进程中已经完成注册的 provider。

## Consequences

模型可以选择具体的搜索或抓取后端，并直接收到该后端的成功或失败，不会发生隐藏替换。成功运行的 Host 动态插件添加的 provider 可以在下一次 Web 操作中使用，而仅执行 `cordis_define` 不会产生运行时效果。实时目录只是 metadata，不承诺凭据、健康状态或网络一定成功。Provider 实现仍可独立测试，并能在有具体 consumer 时增加厂商能力而不改变面向模型工具。

规范化的搜索与抓取 contract 保持精简。Provider 专属过滤器、AI answer、爬取任务和结构化提取不会被偷偷塞进 `web_search` 或 `web_fetch`；有具体 consumer 时再定义独立 capability contract。HTTP fetch provider 现有的私有网络限制继续单独记录，因此不能把 `web_fetch` 当作通用的 SSRF 安全边界。

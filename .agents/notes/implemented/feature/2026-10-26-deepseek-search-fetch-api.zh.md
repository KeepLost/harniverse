# Agent Note: DeepSeek Search / Fetch API 取代基于 Messages 的搜索

Status: implemented

[English](2026-10-26-deepseek-search-fetch-api.md) | 中文

## Problem

随发的 base 组合默认选择 `deepseek-official`——即 `dsh-web-search-deepseek` 提供方。该提供方走 Anthropic 兼容的 Messages API 并携带 `web_search_20250305` 服务端工具,因此一次搜索要按一整轮模型调用支付延迟与 token。它的存在是因为在 wave-4 W06 吸收时,DeepSeek 没有专门的搜索端点。

2026-10-15,官方服务开放了直连的 Search 与 Fetch 端点(`/v1/tools/search`、`/v1/tools/fetch`):每次操作一个普通 HTTP 请求,返回结构化结果或页面 Markdown,按次计费。官方 DSH 随之加了 `dsh-web-deepseek-api` 插件;wave-5 调查将其记为 row 5。

## Decision

按 Harniverse 契约适配并吸收官方插件,落为 `packages/web/web-deepseek-api`,同时彻底废弃 `dsh-web-search-deepseek`(owner 决策,2026-10-26)。

新包在一个实时设置区段(`web-deepseek-api`:`apiKey` 密文、`apiKeyEnv` 默认 `DEEPSEEK_API_KEY`、`baseURL` 默认官方端点、`count` 1–50 默认 10、`sendOriginalQuestion` 默认 true)之上向 `ctx.web` 注册 `deepseek-search-api`(搜索)与 `deepseek-fetch-api`(抓取)。两个提供方按操作对区段做一次投影,因此提交的变更无需重新注册即可到达下一次操作。base 组合行换成新插件,默认 `searchProvider` 变为 `deepseek-search-api`;`$DSH_WEB_SEARCH_PROVIDER` 依旧可覆盖。

相对官方形态的适配:剥离账号令牌认证路径(C2 DeepSeek 账号家族维持拒绝);volatile-config 模式改为我们的 `installSettingsSection` 投影;省略 `ready()`(我们的 `WebSearchProvider` 接口没有就绪成员);`ori_question` 与官方一致,经 `deriveMessages()` 读取发起会话最近一条人类提问;每个结果的 `summary` 被丢弃,因为我们 `WebSearchSource` 词汇没有 per-source 摘要字段(缝的 README 本就把 DeepSeek 记为无摘要)。

废弃移除了该包、其 `web/deepseek-search-llm-request` 会话事件、`web-search-deepseek` 设置命名空间,以及所有组合、UI、SDK 与文档引用。在用户层固定了 `searchProvider: deepseek-official` 的部署需要重选;已配置但缺失的提供方以 `WEB_PROVIDER_CONFIGURED_MISSING` 使搜索失败,这正是缝的既定应答。

## Alternatives considered

**两个提供方都保留。** Messages 路径仅剩的价值是给没有 Search API 计费的用户一个更便宜的入口;这不该由我们裁决,而且把按模型轮计价的搜索留作可选默认会诱发意外开销。官方两者都留且默认 Messages;我们把直连 API 作为唯一的 DeepSeek 路径。

**把 `ready()` 移到缝上。** 我们的缝上没有消费者需要按路由的就绪信息;为一个没有下游调用方的上游模式增加接口成员违反最小契约原则。

## Compatibility

废弃该提供方会移除 `web/deepseek-search-llm-request` 这个 `SessionEventMap` 成员,会话契约 digest 将其记为结构性(非增量)v0 变更。在本变更中有意识地重建基线的理由:

- 该事件是插件自有的分发前记录,从来不是核心词汇成员:它不参与任何 surface 重建、派生消息或请求前缀——忽略它的读取方会重建出完全相同的会话。
- 废弃前的日志必须继续可打开。因此该类型作为有文档记录的已退役条目并入生成的 `KNOWN_SESSION_EVENT_TYPES`(`scripts/gen-persistence-catalog.ts` 中的静态 `RETIRED_SESSION_EVENT_TYPES` 清单),`assertEventsSupported` 放行它,而代码里不再有任何声明合并。这些事件作为惰性数据加载,与信封 `ignorable` 事件完全一致。
- 不再有写入方发出该类型,因此写入方侧的版本升级判据("当旧运行时无法再正确处理新日志时升级")不可能触发:新日志永远不会包含该事件。

验证:一条持久化回归测试经生产读取路径加载含该已退役事件类型的日志。

## Consequences

- 一次 DeepSeek 搜索就是一次 HTTP 请求;不再消耗或记录辅助模型轮,`web/deepseek-search-llm-request` 事件及其 persistence-catalog 条目随之消失。
- 浏览器 Web 搜索卡片新增抓取选项(`deepseek-fetch-api`),DeepSeek 字段变为 `baseURL`/`count`/`sendOriginalQuestion`。
- 验证:提供方与设置套件(24 项)、base 组合规格、apiproxy 设置白名单规格、SSH remote-runtime 规格,以及 web e2e 回归(`web-search-round`、`shipped-composition`、`plugin-config` 及刷新后的对话框 golden)全部在新提供方下通过;搜索替身按 Search API 线格式应答,并断言精确的请求信封、Bearer 凭证、count 收紧与截断后的 `ori_question`。

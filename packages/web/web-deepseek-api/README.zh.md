# @deepseek-ai/dsh-web-deepseek-api

[English](README.md) | 中文

DeepSeek Search / Fetch API 在 harness [web 能力缝](../web/README.md)(`ctx.web`)上的两个提供方:每次操作一次直接请求,不再有辅助模型请求。插件注册 `deepseek-search-api`(搜索)与 `deepseek-fetch-api`(抓取),二者共享一个凭证与一个 API 基址;由 `web.searchProvider` 与 `web.fetchProvider` 选用。它取代已废弃的 `dsh-web-search-deepseek`——那条基于 Messages 的搜索路径每次搜索都要烧一整轮模型调用。

这是一个**实现**包:向 `ctx.web` 注册两个提供方,每次操作通过可选的 `ctx.credentials` 缝解析共享凭证;它不持有 `ctx.web` 的 key,也不注册面向模型的工具(那是 `@deepseek-ai/dsh-tool-web` 的职责)。函数/命名空间插件(`inject: ['web']`)。

挂载了 credentials 服务时以它为准;没有该服务时,启动环境就是全部凭证平面。引用按操作解析,所以在 Web 模型页存入或轮换的密钥无需重启即可到达下一次调用。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 省略 | 字面 DeepSeek API 密钥。优先用 `apiKeyEnv`,避免密钥进入配置;非空字面值优先。 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 每次操作经 `ctx.credentials` 解析的凭证引用;该缝缺席时从启动环境解析。缺失时调用以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。 |
| `baseURL` | `https://api.deepseek.com/v1/tools` | API 基址(含路径前缀);自动追加 `/search` 与 `/fetch`。不可解析的值使两个提供方都不可用。 |
| `count` | `10` | Search API 单次搜索的结果数,1 到 50。更小的请求 `maxResults` 优先,并作为成本/延迟优化下发;最终上限仍由缝强制执行。 |
| `sendOriginalQuestion` | `false` | 把触发本次搜索的用户问题(空白折叠、截断到 128 字符)作为 Search API 的 `ori_question` 一并发送,以改进结果排序。默认关闭:未经用户开启,只发送模型自己改写的查询词。 |

```yaml
- id: web-deepseek-api
  name: '@deepseek-ai/dsh-web-deepseek-api'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
```

上面的条目是 `web-deepseek-api` 设置区段的基线层。两个提供方按操作对完整区段做一次投影,而不是在注册时固化,因此提交的用户层变更无需重新注册即可到达下一次操作。`apiKey` 带 `role('secret')`,所以脱敏的 `describe()` 响应只报告该字段是否已设置,绝不返回其值。

## 映射

Search API 返回扁平的 `results[]` 且没有生成式回答,因此省略 `content`。每个结果映射为一个 `WebSearchSource`:`url` ← `url`,`title` ← 非空 `title`,`snippet` ← 非空 `snippet`,`publishedAt` ← 非空 `date`。每个结果的 `summary` 被丢弃:缝的来源词汇没有 per-source 摘要字段,凭空造一个等于让缝说谎。Fetch API 返回页面 Markdown:成功即视为以 HTTP 200 语义取回了请求页——该 API 既不报告目标状态码,也不报告重定向后的最终 URL,且目标无可取内容时直接失败,因此结果携带 `{ kind: 'text', content }` 与 `truncated: false`。

提供方与凭证解析失败以 `WEB_PROVIDER_ERROR` 报出,并附上实际分发的端点与设置恢复指引;凭证缺失以 `WEB_PROVIDER_CREDENTIAL_MISSING` 报出并点名插件;调用方取消以 `WEB_ABORTED` 报出。取消发生在凭证预检之前或之中时分发不出任何 HTTP 请求。HTTP 重定向在接触 `Location` 目标之前即被拒绝,以 `WEB_PROVIDER_ERROR` 报出。

## 模型体验

间接,经由 [`dsh-tool-web`](../tool-web/README.md):它在消费者的错误包装下保留本提供方受上限约束的 URL、标题、摘要与发布日期,或可直接行动的端点指引与凭证缺失失败;提供方私有字段不进入上下文。

#### KV 缓存影响

无直接失效;命名消费者拥有任何请求前缀变更。

## 已知限制与未竟工作

- **每个结果的 `summary` 被丢弃** —— 缝的 `WebSearchSource` 没有摘要字段;增加它是一次协调的 Service Definition 变更,不是提供方的事。
- **`fetch()` 对每次成功都报告 HTTP 200** —— Fetch API 不暴露目标状态码与重定向后的最终 URL。
- **动态凭证可用性在操作内解析** —— 同步的 `available()` 只能确认解析器存在,无法查询异步凭证库。因此被选中而无密钥的提供方以 `WEB_PROVIDER_CREDENTIAL_MISSING` 使操作失败。

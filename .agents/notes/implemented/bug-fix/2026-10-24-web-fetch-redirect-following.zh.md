# Agent Note：web_fetch 在逐跳校验的有界预算内跟随重定向

Status: implemented

[English](2026-10-24-web-fetch-redirect-following.md) | 中文

## Problem

自 [safe web defaults](../architecture/2026-08-30-agent-profile-capability-defaults.md) 起，本地 HTTP 抓取提供方拒绝一切重定向：`maxRedirects` 被钉死为零，任何 3xx 响应都抛 `WEB_REDIRECT_BLOCKED`，且错误消息不给出目标 URL。真实网页时刻依赖重定向——`http`→`https` 升级、`www` 规范化、域名迁移、短链服务——模型得到的只是无法行动的报错，而本应正常落地的抓取却失败了。官方上游自我们的 fork 基线起一直是有界的同源跟随设计；固定拒绝是 Harniverse 独有的收紧，用真实能力换取了传输层检查早已提供的安全性。

## Decision

在有界预算内跟随重定向，包括跨源。每一跳都重跑直接请求会得到的完整验证：`Location` 头相对响应 URL 解析，`validateFetchUrl` 重新检查 URL 卫生（协议、凭证、长度），`requestOnce` 重新执行字面范围检查、DNS 答案验证与公共地址钉死。跨源目标同样跟随，因为请求是匿名的——不存在可转发的 cookie、凭证或会话（[web 包规则](../../../../packages/web/AGENTS.md) 拒绝的是带凭证提供方请求的重定向，本提供方不属于此类），而 SSRF 防御由逐跳地址检查承担，与源无关。`maxRedirects` 默认 `5`（上游先例数字），可配置，`0` 表示一律不跟随；超出预算抛 `WEB_REDIRECT_BLOCKED`，无可用 `Location` 的重定向抛 `WEB_PROVIDER_ERROR`，每次抛出前先取消响应体以免 socket 泄漏。抓取结果如实报告实际落地的最终 URL，引用不会错误归属内容来源。

这里有意偏离上游的同源限定：上游的跨源错误消息会点名目标并邀请手动重试，同一模型下一轮即可经同一工具与同一逐跳校验到达同一目标——在 agent 语境下该限定不带来防护，只增加一次工具调用。此为 Harniverse 下游决策。

## Alternatives considered

**保持固定拒绝。** 维持现状，继续承担 Problem 所述的代价；没有任何不变量要求它。

**逐字采用上游同源策略。** 仍会破坏 `www` 规范化、短链与域名迁移；其手动重试逃生口本身就说明该限定在此不构成防护。

**无预算跟随。** 重定向环会持续消耗请求直到超时；预算让成本有确定上界。

## Consequences

- `web_fetch` 在默认五跳内落到真实页面；更长的链以清晰的预算错误失败，而不是无法行动的拒绝。
- 运营者可将 `maxRedirects` 配为 `0` 恢复一律不跟随——这是合法配置，不是错误。
- 提供方循环骨架与上游 `followAndRead` 保持对齐，仅缺 `isSameOrigin` 检查，未来上游同步面很小。
- 全部安全不变量保留：逐跳 URL 卫生、公共地址与 DNS 验证、IP 钉死、字节／字符／时间上限、匿名请求。
- [capability defaults note](../architecture/2026-08-30-agent-profile-capability-defaults.md) 中 "`maxRedirects` is fixed at zero" 的表述由本 note 取代；该 note 其余内容继续有效。

## Testing

`packages/web/web-fetch-http/tests/fetch-http.spec.ts` 覆盖：跟随相对 `Location` 的同源重定向；跟随跨源重定向并报告最终 URL；预算执行（第六跳被拒、目标未被联系）；`maxRedirects: 0` 对所有 3xx 状态不联系目标；无 `Location` 的重定向报 `WEB_PROVIDER_ERROR`；指向字面私有地址的重定向在传输前被 `WEB_BLOCKED_URL` 拒绝；每个重定向错误路径的响应体取消；构造断言接受 `0`／`5`／`7`、拒绝小数与负数。`packages/web/tool-web/tests/integration.spec.ts` 端到端证明工具跟随跨源重定向并渲染 `Fetched <final-url> (HTTP 200)`。包级套件：187 个测试全绿。

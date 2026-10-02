# Agent Note: Patched SSE parsers deliver gateway-collapsed multi-document frames

Status: implemented

[English](2026-10-02-patched-sse-multi-document-frames.md) | 中文

## Problem

所有者的 OpenAI 中继路由每一回合都以 `Unexpected non-whitespace character after JSON at position N (line 2 column 1)` 失败：重试两次后终止。网关会间歇性地丢失两个 SSE 事件之间的空行，使一个事件的 `data:` 载荷携带两份完整 JSON 文档（`{...}\n{...}`）。OpenAI 与 Anthropic 的 SDK 流按 SSE 规范拼接多行 data 后对整体做 `JSON.parse`，第二份文档于是成了尾部垃圾。同类缺陷也抵达 `anthropic-messages` 路由：pi-ai 自有的 `iterateAnthropicEvents` 解析器（对拼接后的 `state.data` 做 `parseJsonWithRepair`）形态完全相同。

复现在真实线路上完成：本地 tap 代理录制了 wire，所有者的会话日志显示重试间失败逐字节一致（中继对带缓存的 `prompt_cache_key` 重放同样的 malformed 字节）。前一份 note [2026-10-01-anthropic-ambient-key-precedence](2026-10-01-anthropic-ambient-key-precedence.md) 曾以「重试可达健康路径，无需拥有解析器」拒绝客户端容错——重试证据推翻了该前提：malformed 帧按响应确定性重放，任何重试次数都无法恢复，而 OpenCode 面对同一网关之所以成功，只是因为它的 provider 栈做了宽容解析。

## Decision

- `patches/openai@6.26.0.patch`：`Stream.fromSSEResponse` 的两个解析点改经 `parseJSONDocuments`——正常情况返回 `[JSON.parse(data)]`；解析抛错时按换行拆分载荷并逐行解析非空行，把每份文档作为独立事件交付；拆分无法修复的载荷原样重抛原始错误。
- `patches/@earendil-works__pi-ai@0.82.1.patch`：`iterateAnthropicEvents` 在 `parseJsonWithRepair` 外获得同样的拆分修复，保留其包装错误文本，并在拆分事件间延续 `message_start`/`message_stop` 记账。
- Anthropic SDK 本体不打补丁：pi-ai 的 anthropic 路径经 `.asResponse()` 拿原始响应并走自有解析器，SDK 的流解码器不在受影响路径上。

## Alternatives considered

- **按前一份 note 的拒绝只做重试** — 拒绝：重试重放同样被缓存的 malformed 字节；失败是确定性的，不是瞬时的。
- **在 SDK 解析前用规范化 `fetch` 包装重排字节流** — 拒绝：pi-ai 的客户端构造不接受 `fetch` 覆盖，穿针引线需要在两层调用间打更大的 vendored 补丁，远重于两处解析器局部修复。

## Consequences

符合规范的服务器感知不到变化：单文档载荷走未改动的快路径。折叠事件的网关至多损失 SSE 规范理论上允许、而 OpenAI 系协议服务器从不发送的「多行单 JSON」载荷。由 `tests/adapter.spec.ts`（"delivers every merged OpenAI/Anthropic frame a gateway collapses into one data payload"）锁定：真实适配器驱动 mock 服务器投喂 malformed 帧。

# Agent Note：在每个含推理轮次回传 DeepSeek reasoning

Status: implemented

[English](2026-08-19-deepseek-reasoning-passback-every-turn.md) | 中文

## 问题

`dsh-llm-deepseek` 只在同时携带工具调用的 assistant 轮次回放 `reasoning_content`。DeepSeek 要求思考模式的工具调用携带该字段，并会忽略其他轮次中的该字段，因此直接调用 API 时省略它没有影响。

该适配器也允许通过 `Config.baseURL` 使用兼容 gateway。Gateway 在为其他提供方重新编码会话时，可能通过对回放的推理文本计算 hash 来恢复上游思考签名。普通回答轮次既没有签名，也没有用于恢复签名的推理文本，导致重建出的会话偏离持久 Session 历史。

## 决定

只要 assistant 轮次的内容携带推理，`serializeAssistant` 就会发送 `reasoning_content`，不再取决于该轮次是否调用工具。不含推理的轮次仍省略该字段。

回放文本与 Session 派生消息保留的 reasoning 块逐字节一致。纯文本请求与支持图片的请求共用 `serializeAssistant`，因此两条路由遵循同一历史规则。

## 考虑过的替代方案

- **保留直接 DeepSeek 的 token 节省行为。** 这会静默破坏通过推理文本恢复签名的兼容 gateway，而且适配器无法根据 URL 推断 gateway 行为。
- **增加回传策略设置。** 错误值会静默使历史无法重建，而该字段在不需要它的直接 DeepSeek 轮次中不起作用。
- **改为持久化提供方签名。** DeepSeek chat completions 不公开这类签名；回放推理是唯一可用的恢复输入。

## 后果

每个含推理的普通回答轮次都会把其推理 token 带入后续请求。文本稳定地位于该轮次的历史位置，未变化的后续前缀仍可使用 cache。

## 验证

序列化测试覆盖含推理的普通文本、工具调用旁的推理、纯推理输出和完全不含推理的轮次。真实 Loader 组合把普通含推理 assistant 轮次经 `LlmRuntime` 和 DeepSeek 适配器发送到 mock 提供方，并断言确切协议消息。

# Agent Note: 加密推理链成为一等 block 数据

Status: implemented

[English](2026-09-26-encrypted-reasoning-chain.md) | 中文

## 问题

OpenAI Responses 推理链的无状态回放只是 pi-ai 内部 `thinkingSignature` 的偶然结果；Harness 持久的 `ReasoningBlock` 只携带 `text`，UI 无法区分提供方生成的摘要与完整推理链，导出没有一等密文，而路由切换会静默压平或丢弃先前的推理，模型永远不会被告知自身历史已降级。

## 决策

在 `ReasoningBlock`（`packages/llm/llm/src/types.ts`）上增加三个可选增量字段，`SESSION_FORMAT_VERSION` 保持 0，符合仅增量政策（摘要校验确认无变化）：

- `summary: true` —— 文本是提供方对被隐藏推理链的摘要；
- `encrypted` —— 提供方签发的加密推理载荷，只能在确切路由上回放；
- `itemId` —— 提供方签发的推理 item id。

流转换器（`llm-pi-ai/src/stream.ts`）把 thinking 区块的闭合从 `thinking_end` 推迟到终止 `done` 事件，因为 pi-ai 把完整推理 item（id、`encrypted_content`）放在最终消息的区块上；闭合的区块从解析后的 `thinkingSignature` 中提升这些事实，并在存在加密载荷时精确标记 `summary`。error finish 仍让未闭合的 thinking 区块按增量组装（与之前一致）；无法解析的签名保持不透明，经 envelope 原样回放。

请求侧，`piStreamOptions` 在 OpenAI Responses 上随任何选定的推理强度一并发送 `reasoningSummary: 'auto'`：pi-ai 只有在存在 summary 选项时才发出 `reasoning.summary` 与 `reasoning.encrypted_content` include，而这个 include 正是推理链在该路由无状态回放的关键。未选择强度的模型保持现有的显式关闭思考分发。

路由降级现在对模型可见：当较早的 assistant 轮次携带无法在当前路由回放的推理内容 —— 没有存储回放元数据，或提供方／模型不同 —— `toPiContext` 会在请求历史末尾追加恰好一条 `<system-reminder>` 提示，说明只有已记录的推理文本存留。该提示由已记录的消息来源确定性推导，请求仍可从 Session 日志重建；适配器的 logger 警告保留给运维方。

UI 通过 `AssistantBlock` 与 trajectory 记录投影 `summary`：推理区块全部为摘要的轮次，其折叠区标签显示 "Reasoning summary" 而非 "Thinking"。导出保留密文，因为持久区块携带它。

## 备选方案

**在流时间区分摘要增量与推理增量。** 不可行：pi-ai 把 `response.reasoning_summary_text.delta` 与 `response.reasoning_text.delta` 都发成同一种 `thinking_delta` 事件，唯一真实的标记就是加密载荷本身的存在。

**当 envelope 缺失时用新字段重建 `thinkingSignature`。** 否决：envelope 仍是回放的规范载体，且携带更多信息（完整 item JSON）；部分重建会制造第二个更弱的真相源。

**修改 `BlockAssembler` 的不匹配处理。** 有意不变：envelope 与区块来自同一个终止消息，数量不匹配即是损坏，而 pi-ai 0.82.1 已为 store:false 分片流内置了"先合并再过滤"的防御。

## 后果

同路由轮次带加密内容无状态回放其推理 item；持久转录现在把密文与 item id 作为一等数据携带；切换路由的模型会被告知丢失了什么；UI 区分摘要。此变更之前记录的会话只是缺少这些可选字段。pi-ai 回放 envelope 无需版本提升：`thinkingSignature` 本就包含这些字段被提升出来的 JSON。

## 测试

`pnpm exec vitest run packages/llm/llm-pi-ai packages/llm/llm packages/client/ui-trajectory packages/client/runtime` —— 新增覆盖把 item 元数据提升到闭合区块（增强、朴素与不透明签名三种情形）、断言 block-end 位于 usage／finish 之前的顺序，并验证降级提示（缺失元数据、过期路由、无推理历史、恰好一条提示）。`verify-session-contract-digest` 报告摘要无变化。

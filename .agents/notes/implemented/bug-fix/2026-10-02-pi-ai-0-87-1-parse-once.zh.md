# Agent Note: pi-ai 0.87.1 与 parse-once 补丁

Status: implemented

[English](2026-10-02-pi-ai-0-87-1-parse-once.md) | 中文

## 问题

此前固定 pi-ai 0.82.1 并携带 [SSE 帧修复补丁](2026-10-02-patched-sse-multi-document-frames.md)。上游 0.85+ 引入了对累积工具调用参数 JSON 的逐增量解析：每个 `toolcall_delta` 都对整段局部 JSON 运行 `parseStreamingJson`，一次大型工具调用因此在事件循环上付出 O(n²) CPU，兆级参数流会拖死进程内的所有会话（官方 `a0f59aac40`，修复 #4739）。wave-4 决策（R12）升级到 0.87.1、重放 SSE 帧修复，并为 Harniverse 路由的每个协议加 上parse-once 移除。

## 决策

- **pi-ai 0.82.1 → 0.87.1**（`^0.87.1`，catalog 钉定，`minimumReleaseAgeExclude` 同步更新）。该依赖连带 `openai` 6.26.0 → 6.40.0，因此 SSE 帧修复的 OpenAI SDK 半边针对 6.40.0 重新生成，同时覆盖两个发布构建（`core/streaming.js` 与 `core/streaming.mjs`——ESM 消费者加载的是 mjs 构建）。
- **pi-ai 补丁**（`patches/@earendil-works__pi-ai@0.87.1.patch`）携带两个独立修复：Anthropic `iterateAnthropicEvents` 的多文档拆分（自 0.82.1 补丁逐字重放），以及六个增量位点（anthropic-messages、bedrock-converse-stream、mistral-conversations、openai-completions、openai-responses-shared、pi-messages）的逐增量 `parseStreamingJson` 移除——与官方 `a0f59aac40` 在 0.87.1 dist 上的改动一致。终末解析（`content_block_stop`、`function_call_arguments.done`、`response.output_item.done`、`toolcall_end`）保留，最终化的参数精确；局部块保持 `{}`。
- **漂移适配**由门禁表面暴露：`baseten` 思维格式被扣留（没有 Harniverse 部署点名其 `chat_template_args` 表面；需要它的路由在自己的 catalog 条目携带该格式，直到出现真实需求）；终态 `pending` 与 `deferred` 停止原因映射为不可重试的 `PI_AI_ERROR`；`ToolCall.arguments` 收窄为 `JsonObject`（由构造保证满足——值来自 `JSON.parse`）；环境密钥解析传入现在必需的 `signal`（配置物化不可取消）。
- **Replay 身份无需移植**：Harniverse 本就把请求模型记录为 `model`、`responseModel` 单独存放，并按 assistant source 校验——这正是官方 `6ed596f71b` 采纳的语义。
- 调用方信号已中止时到达的 `error` 事件现在映射为 `aborted`（pi-ai 0.87 把调用方中止作为终态 error 事件而非抛出交付；移植自官方 adapter 的 `callerSignal` 处理）。

## 备选方案

**整体采纳官方的 compat 漂移门禁。** Harniverse 的 compat 表面是刻意收窄的精选集（推理派发 + chat-template kwargs）；上游新增的 mid-conversation compat 字段保持不建模，而不是扩张一个未经审计的配置表面。

**留在 0.82.1。** catalog 更新（DeepSeek 模型更名、按模型的档位变化）正是升级的意义；parse-once 修复反正需要补丁。

## 测试

`tool-argument-streaming.spec.ts`（自官方移植，并扩展 `anthropic-messages` 用例）以 7 字符碎片切分 2 KiB 参数、直接驱动各路由协议的流：每个增量的局部参数保持 `{}`，最终化的调用携带精确对象。合并帧 fixture（经补丁 SDK 的 OpenAI Responses、经补丁 pi-ai 解析器的 Anthropic）保持通过；llm-pi-ai 全套与 ACP keyless 快照套件通过。

## 后果

流式工具调用增量不再暴露局部参数对象（消费方在调用完成前看到 `{}`）——最终 `tool-call` 块不变。DeepSeek catalog id 更名（`deepseek-v4-flash` → `deepseek-flash`）、其思维档位新增 `low`；DeepSeek 请求改发 `max_tokens`（pi-ai 的拼写选择），Anthropic 请求携带 `?beta=true`。于 2026-10-02 wave-4 吸收期间移植自官方 `6ed596f71b` + `a0f59aac40`。

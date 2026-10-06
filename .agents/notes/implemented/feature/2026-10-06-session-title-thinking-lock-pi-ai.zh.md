# Agent Note: session-title 思考锁延伸到 llm-pi-ai

Status: implemented

[English](2026-10-06-session-title-thinking-lock-pi-ai.md) | 中文

## 问题

某部署把会话标题生成经 `dsh-llm-pi-ai` 路由到具备推理能力的模型上，辅助调用在两条不同路径上失败：

- **Anthropic Messages** —— 适配器把未指定档位解析为隐式中间档；预算型思考模型随即要求调用方上限内容纳 ≥1,024 token 的思考预算。面对标题预算（32–64 token），请求在任何网络 I/O 之前就以 `UNSUPPORTED_OPTION` 被拒。
- **OpenAI Responses 与 OpenAI 兼容网关** —— 解析出的档位把思考发上线；推理 token 计入同一个很小的上限，结束原因落到 `length`，标题 Consumer 报告 `title output reached maxOutputTokens`。

`dsh-llm-deepseek` 不受影响：它早已把 `GenerateOptions.purpose: 'session-title'` 映射为思考禁用，作为部署锁。`dsh-llm-pi-ai` 则完全不解析 `purpose`，而 session-title 插件从不选择档位，因此每个具备推理能力的 pi-ai 路由都命中两条失败之一。

## 备选方案

- 让显式 `reasoningEffort` 覆盖该锁:否决——标题 Consumer 从不选择档位,而一个宽松的锁会让任何做出选择的调用方重新触发预算拒绝。
- 只抬部署预算、适配器不做任何解析:否决——预算型思考的 Anthropic 路由对 `maxTokens < 1,024 + cap` 仍会直接拒绝,任何预算值都无法同时修复两类失败。

## 决策

- **是锁，不是默认值**：在 `PiAiAdapter.stream()` 中，携带 `purpose: 'session-title'` 的请求在 profile 默认、模型默认或显式 `reasoningEffort` 选择生效*之前*就把 reasoning 解析为 `off`——镜像 llm-deepseek 的部署锁，包括拒绝被显式选择穿越。Anthropic Messages 装订 `thinking: {type: 'disabled'}`；OpenAI Responses 不发送 effort 字段；`streamSimple()` 协议以省略 reasoning 选项表达 off，那是它们唯一的 off 写法。
- **诚实的线上边界**：endpoint 永远在推理的模型（OpenAI 兼容网关后面的 reasoner-only 部署）没有任何 off 写法可发。对这类路由，修复是部署预算：随附 base 组合与 session-title 示例把 `maxOutputTokens` 从 64/32 抬到 **256**，让有界的标题调用能容忍推理消耗而不是直接被拒。
- llm-pi-ai 的 README 在其档位解析规则旁记录该锁，并把线上边界限制列入 Known Limitations；session-title-llm 的 README 从"其他适配器"改为点名两个适配器。

## 后果

- pi-ai 路由上的会话标题生成不再在预算型思考的 Anthropic 模型上失败,也不会把上限耗在被分派的思考上;对无视该锁的 endpoint,部署仍以 `maxOutputTokens` 为唯一杠杆。
- session-title 请求上的显式 `reasoningEffort` 会被该锁静默覆盖,与 llm-deepseek 一致;没有任何已出货调用方会选择它。

## 验证

- `packages/llm/llm-pi-ai/tests/adapter.spec.ts` —— 在 `reasoning: 'max'` 的 profile 上，session-title 请求落线为 `thinking: {type: 'disabled'}` 且无 `reasoning_effort`（显式 high 也无法穿越锁）；预算型思考的 Anthropic 模型在 `maxTokens: 32` 下以 `max_tokens: 32, thinking: {type: 'disabled'}` 完成，而锁之前的行为是 `UNSUPPORTED_OPTION`。两条测试均在修复前对未改动适配器确认过 RED。
- `scripts/verify-cordis-config.ts` 在抬升后的组合值上通过。

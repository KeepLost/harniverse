# Agent Note: An unspecified request sends the implicit middle thinking level

Status: implemented

[English](2026-10-02-implicit-thinking-level.md) | 中文

## Problem

未指定思考档位的推理型模型把思维链内联进了可见的回复正文：所有者的 `anthropic`/`claude-opus-4-8` 回合抵达时是单个 text 块、以模型的自我推演开场，`deepseek`/`deepseek-v4-pro` 经官方 API 亦然。真实线路的 wire 抓包说明了原因——没有显式思考请求时，Anthropic 中继把上游 thinking 块转换成无标签文本，而 DeepSeek V4（仅支持 `high`/`max`）收到 `thinking: {type: "disabled"}` 后把推理内联进 `content`。OpenCode 不出现泄漏，是因为它默认显式请求 thinking；自定义手工声明路由从不泄漏，是因为其模型依赖网关保留的 reasoning-content 字段。

## Decision

- `implicitThinkingLevel(model)`：对推理能力已获描述的模型，隐式档位为 pi-ai 的 `clampThinkingLevel(model, 'medium')`（DeepSeek V4 收敛到 `high`）；钳到 `off` 或无可钳者没有隐式档位。
- `effectiveDefaultEffort(profile, model)`：模型的 `defaultReasoningEffort` 钉住优先于路由的 `reasoning`；显式 `default` 钉住返回 `'pinned-none'`，同时压制路由默认与隐式档位——不点名档位就是该模型配置出的答案。
- `PiAiAdapter.stream` 发送 `options.reasoningEffort ?? effectiveDefaultEffort ?? implicitThinkingLevel`，`resolveModel` 把同一值报告为 `reasoning.defaultEffort`，列表与 wire 因此一致。

## Alternatives considered

- **保留提供方默认并启发式剥离泄漏的思考** — 拒绝：无标签的自我推演在 wire 上没有边界标记，任何启发式都会破坏正当的正文。
- **把默认全部推到现有 `reasoning` 配置字段** — 拒绝：这会把部署级档位压到不支持的模型上，并把修复埋进配置而不是修正 seam 的默认。

## Consequences

推理型模型上未指定档位的请求现在默认消耗 thinking token；要让模型沿用提供方默认的部署钉住 `defaultReasoningEffort: default`，显式 `off` 仍然禁用。真实线路验证：`claude-opus-4-8` 与 `deepseek-v4-pro` 在先前泄漏的相同提示词下均返回分离的 `reasoning` + `text` 块。由 `tests/adapter.spec.ts` 锁定（"clamps an unspecified request to the nearest supported thinking level"、"keeps an explicit defaultReasoningEffort pin off the wire" 及改写的未指定档位 wire 测试）。

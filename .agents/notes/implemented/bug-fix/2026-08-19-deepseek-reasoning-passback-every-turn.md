# Agent Note: DeepSeek reasoning passback on every reasoned turn

Status: implemented

English | [中文](2026-08-19-deepseek-reasoning-passback-every-turn.zh.md)

## Problem

`dsh-llm-deepseek` replayed `reasoning_content` only on assistant turns that also carried tool calls. DeepSeek requires that field for thinking-mode tool calls and ignores it elsewhere, so the omission is harmless against the direct API.

The adapter also supports compatible gateways through `Config.baseURL`. A gateway re-encoding the conversation for another vendor may recover an upstream thinking signature by hashing the replayed reasoning text. A plain-answer turn then arrived without either the signature or the reasoning text needed to recover it, and the reconstructed conversation diverged from the durable Session history.

## Decision

`serializeAssistant` emits `reasoning_content` for every assistant turn whose content carries reasoning, independent of tool calls. A turn without reasoning still omits the field.

The replay is byte-exact with the reasoning blocks retained in the Session-derived message. Text-only and image-capable requests share `serializeAssistant`, so both routes preserve the same history rule.

## Alternatives considered

- **Keep the direct DeepSeek token-saving behavior.** It silently breaks compatible gateways that recover signatures from reasoning text, and the adapter cannot infer gateway behavior from its URL.
- **Add a passback policy setting.** A wrong value silently makes history unreconstructable, while the field is inert on direct DeepSeek turns that do not need it.
- **Persist a provider signature instead.** DeepSeek chat completions exposes no such signature; replayed reasoning is the only available recovery input.

## Consequences

Every reasoned plain-answer turn contributes its reasoning tokens to later requests. The text remains stable at that turn's history position, preserving cache eligibility for unchanged subsequent prefixes.

## Verification

Serializer tests cover plain reasoned text, reasoning beside tool calls, reasoning-only output, and turns with no reasoning. A real Loader composition sends a plain reasoned assistant turn through `LlmRuntime` and the DeepSeek adapter to a mock provider and asserts the exact wire message.

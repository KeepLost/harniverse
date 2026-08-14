# Agent Note: Provider-neutral default composition

Status: implemented

English | [中文](2026-08-14-provider-neutral-default-composition.zh.md)

## Problem

The base profile mounted the native DeepSeek adapter and the Web client opened a DeepSeek credential dialog for an unconfigured installation. Those defaults gave one vendor product policy even though the LLM runtime and Models page support catalog providers and custom routes through `llm-pi-ai`.

## Decision

The base bundle enables `llm-pi-ai` and keeps `llm-deepseek` as a disabled row that a later profile layer may re-enable. The generic adapter starts with no routes until settings configure a catalog or custom provider; the composition does not invent a provider, model, endpoint, or credential.

`ui-settings-models` registers the Models section and product notice but does not register the `deepseek-official` onboarding entry. Provider credentials are configured explicitly through the Models page. The reusable DeepSeek editor and adapter implementation remain available when a deployment enables that provider, without restoring a vendor-specific first-run prompt. This default-composition decision partially supersedes the assembled-product behavior in the [DeepSeek credential onboarding decision](../feature/2026-07-30-deepseek-onboarding-credential-setup.md); its provider-join and credential-handling implementation remains useful to the Models page.

## Alternatives considered

**Hide the dialog only while the DeepSeek adapter is disabled.** Rejected because re-enabling an optional provider would also restore a product-wide first-run requirement for that provider.

**Choose one installed pi-ai provider and model as the new default.** Rejected because no route is universally configured and no provider credential or model is valid for every deployment. The model picker is the explicit selection point after configuration.

**Remove the native DeepSeek adapter package.** Rejected because optional direct-provider support is useful and does not impose vendor policy while its composition row stays disabled.

## Consequences

A clean Web profile shows no DeepSeek API-key dialog. Its Models page can configure any supported pi-ai catalog or custom route, and a deployment can explicitly enable the native DeepSeek row. Until a usable route is configured and selected, the composer requires model selection rather than sending through an invented fallback.

The base-bundle test pins the enabled and disabled adapter rows, while the client registration test pins that the product notice is the only onboarding contribution from `ui-settings-models`.

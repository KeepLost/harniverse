# Agent Note: Web tools default closed in the base bundle

Status: implemented

English | [中文](2026-08-15-web-tools-default-closed.zh.md)

## Problem

A model that sees `web_search` before receiving deployment-specific routing instructions can use one search method as though it covered every source, and a failed request gives it no prior method selection policy. Enabling a fixed search tool in every shipped preset also makes the model-facing tool schema and guidance part of every request even when the deployment supplies networking through a Skill, external program, or another plugin.

The Web service, providers, live settings, and credentials remain useful independently of default model exposure. Removing those rows would turn an exposure decision into a provider removal and discard the explicit opt-in path.

## Decision

The base bundle mounts `dsh-web`, all three official search providers, and `dsh-tool-web`, but configures the tool consumer with `search: false` and `fetch: false`. No shipped preset receives `web_search`, `web_fetch`, or their prompt guidance from the base. A later patch may replace the complete `tool-web` config to enable search after that deployment chooses its routing and content-safety policy; fetch additionally requires a provider.

Provider selection, live settings, and credential resolution stay mounted. `DSH_WEB_SEARCH_PROVIDER` and `web.searchProvider` select the provider an explicitly enabled search uses, while the provider rows remain keyless at boot. Search e2e scenarios apply an explicit `tool-web` opt-in patch before exercising the real provider and model-visible result.

This decision partially supersedes the default-exposure portion of the [default Web search decision](../feature/2026-07-31-web-default-search.md). That note continues to own provider credential resolution, auxiliary DeepSeek request logging, endpoint separation, and the opt-in search execution behavior.

## Alternatives considered

**Keep `web_search` enabled and rely on a Skill description.** Declined because the model can call the visible tool before loading the Skill, and every request still carries the schema and prompt guidance.

**Dynamically reveal Web tools after Skill loading.** Declined because changing tool schemas within a session changes the model request prefix and weakens prompt-cache reuse. It also creates activation state that the existing Skill loader does not own.

**Remove the Web service and provider rows from the base.** Declined because default model exposure and provider availability are separate decisions. Keeping dormant providers preserves live configuration and a small explicit overlay for deployments that want the native tool.

**Remove the `tool-web` row entirely.** Declined because an enabling overlay would then have to insert a package row rather than replace one configuration, and the base would stop declaring the supported opt-in consumer.

## Consequences

The model-facing tool roster and Code Mode SDK omit both Web tools by default. Provider settings remain visible and take effect when a deployment enables search. Native search tests explicitly enable the consumer, while shipped-composition, preset, and built request coverage pin the default absence.

This is not process-level network confinement. Presets with Bash can still invoke network-capable external programs unless the deployment applies sandbox or egress policy; the base bundle only declines to expose its native Web tools.

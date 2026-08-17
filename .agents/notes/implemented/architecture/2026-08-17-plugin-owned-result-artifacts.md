# Agent Note: Plugin-owned result artifacts

Status: implemented

English | [中文](2026-08-17-plugin-owned-result-artifacts.zh.md)

## Problem

Finalized-result retention lived inside `ToolRuntime`, where the core imported the optional spill Service Definition and emitted instructions naming `artifact_read`. The retrieval tool was a separately composed package. A valid patch could therefore keep core retention while removing the only Consumer able to recover its artifacts, producing successful results that promised an unavailable tool. `SpillRef.retrievalHint` also let each storage Provider choose model-facing wording even though storage and presentation evolve for different reasons.

Authentication token management had the parallel ownership error at the application boundary: the universal launcher parsed provider-specific commands and imported `dsh-authentication-local` directly instead of booting an app plugin through the profile tree.

## Decision

`ToolRuntime` exposes `tools/finalize-result`, an asynchronous scope-filtered waterfall after definition-owned `finalizeContent` and before authoritative lossless materialization and `tools/result`. The core owns invocation order, failure normalization, immutable commit, and observation; it has no spill dependency, retention limit, artifact marker, or retrieval-tool name.

`@deepseek-ai/dsh-tool-result-artifacts` is one Consumer of `ctx.tools` and `ctx.spillStore`. Its single plugin registers both the final-result retention listener and `artifact_read`, so retention, marker wording, `TOOL_RESULT_RETENTION_FAILED`, page limits, and retrieval lifecycle cannot be patched apart. Base and headless compose it globally; Web disables that row and each agent preset mounts the same package in its own scope.

`SpillRef` carries only `{ locator, bytes }`. Providers own persistence, opaque addressing, paging, cancellation, and exact byte reporting. Consumers own every model-facing notice and instruction. The optional `spill-policy` remains a separate best-effort early transformer and renders its own provider-neutral locator guidance.

The standalone `@deepseek-ai/dsh-auth-app` bundle applies the same ownership rule to management. `dsh auth` is only an alias for the `auth` profile; `auth-startup` parses the app grammar and releases an injected `auth-runner`, which invokes local management APIs and requests bounded exit. The profile mounts no Agent, WebServer, or runtime authentication Provider, so an empty Harness home can create its first token.

The notification and session-telemetry Definition packages continue to bundle their coordinator Consumers. Generated capability projections list that same package in the Consumer column instead of showing an absent role.

## Alternatives considered

**Make ToolRuntime require `artifact_read` by name.** Rejected because a core registry would still know one Consumer's model protocol and package lifecycle; name checks also do not prove that retention and retrieval unload together.

**Keep retention in core and register a built-in retrieval tool there.** Rejected because this turns an optional storage seam into core policy and makes Provider-free tool runtimes carry irrelevant configuration and model surface.

**Let Providers continue returning retrieval prose.** Rejected because backend storage facts do not determine which tools or UI a deployment composes. A remote Provider can change without changing the stable Consumer instructions.

**Keep `dsh auth` as a boot-free launcher mode.** Rejected because it creates a second application protocol outside Cordis and makes the root launcher depend on one concrete authentication Provider.

## Consequences

A composed result-artifact Consumer guarantees that every successful retention marker names the retrieval tool mounted by the same fiber. Custom deployments may omit the whole capability, in which case ToolRuntime returns unbounded definition-finalized results because no final-result policy was composed; the bundle, not the core, chooses the shipped 50,000-code-point bound.

The final-result waterfall is powerful: a listener can asynchronously transform complete outcomes and a throw becomes a normalized tool failure. Listeners must call `next()`, preserve typed same-process fields they do not own, observe cancellation for owned work, and settle before immutable notification.

Real Loader tests cover empty-home token creation and the combined retention/retrieval package. Focused pipeline tests pin finalizer ordering, agent-loop tests pin the durable artifact reference and bounded surface, and generated catalog checks prevent stale package or event projections.

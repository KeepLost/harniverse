# Agent Note: Continuable delegation is background-first

Status: implemented

English | [中文](2026-08-11-background-first-continuable-delegation.zh.md)

## Problem

A continuable child already has a durable Session id, independent turns, follow-up messaging, and a manager-owned settlement notice. The model-facing delegation contract must make the useful scheduling choice explicit: the parent should wait only when its next action requires the child's result, rather than selecting a provider lifecycle or Task surface.

The child-scoped `report` prompt requires a self-contained final report, while [manager-owned settlement delivery](2026-08-06-manager-owned-subagent-settlement-delivery.md) independently sends the run outcome and closing message. A completed child can therefore wake its parent with a final report and again with settlement. Background-first scheduling must preserve both deliveries: the child-authored handoff remains mandatory guidance, while the manager-authored notice covers every terminal path regardless of model compliance.

## Decision

`tool-subagent` exposes `mode: sync | async`. Synchronous invocations use `ctx.subagents.invoke(provider, 'sync', request)`. Continuable asynchronous delegation uses `ctx.subagents.invoke(provider, 'async', request)`. Omitted `mode` follows the selected lifecycle policy: continuable instances default to `async`, while one-shot instances default to `sync`. `sync` waits for the one-shot result and disposes its run. Continuable `async` resolves when the child's inbox accepts the initial prompt, returning the durable child Session id and invocation id; it has no Task or result promise. Deployments may disable async invocations, leaving the synchronous path available. No second model-facing default-selection vocabulary is added.

The model-facing text divides responsibility by location:

- the tool description states the call behavior, durable Session id, runtime settlement notice, and the explicit `mode: sync` override;
- the `mode` parameter states whether to wait for the result or return after inbox acceptance;
- a `tool:<toolName>` system-prompt section tells the model to start independent delegations together, continue useful work while they run, and choose foreground only when the next action depends on the result. The section renders only when that tool remains visible in the assembly scope, so a child tool restriction removes the schema and its guidance together.

The [continuable child report obligation](2026-08-06-continuable-child-report-obligation.md) remains unchanged: the child prompt requires one self-contained final report and earlier reports for findings that change the parent's next action. Manager-owned settlement remains unconditional and does not inspect whether a report arrived. The two messages may repeat final content, but they retain distinct authors and purposes: `report` is the child's explicit handoff, while settlement records how the run ended and preserves terminal output when the child cannot cooperate. `reportDelivery` remains deployment scheduling policy with `wakeup` as its default.

The keyless headless `subagent-settlement` scenario uses the continuable default, receives the child Session id at inbox acceptance, and reaches the final parent answer through the manager-authored settlement notice even though its fixture deliberately does not call `report`. Package tests separately pin explicit `mode: sync` as foreground, the parent scheduling text, and the child's mandatory-report prompt. The optional control plugin may provide current-turn interruption; continuation and inspection use `session_message` and `session_inspect`.

## Alternatives considered

**Expose a background boolean instead of `mode`.** A boolean hides the distinction between waiting for a one-shot result and accepting a durable continuable Session, and would reintroduce provider and Task vocabulary into the model contract. The two-value `mode` names the caller's waiting policy directly.

**Add a second model-facing default.** An independent default could disagree with the schema wording and installed prompt. The selected lifecycle policy already distinguishes a continuable Session from a one-shot Task, which determines the advertised omitted-mode behavior.

**Change only the prompt.** Prompt preference without runtime invocation through the selected mode would still leave acceptance and result waiting ambiguous. The model must be able to rely on the advertised mode behavior rather than reproduce it perfectly on every tool call.

**Suppress settlement after a final report arrives.** Conditional settlement reintroduces per-Activation bookkeeping and loses the unconditional runtime guarantee when a child reports progress and then fails. Settlement remains unconditional even when the resulting message overlaps a final report.

**Use `report` only for progress before settlement.** This removes duplicate final content but also removes the explicit child-authored handoff from the child prompt. The final-report obligation remains, and runtime settlement remains its independent fallback and terminal record.

## Consequences

- An ordinary continuable call is non-blocking when its advertised default is used; serialized delegation is an explicit `mode: sync` choice.
- Independent subagent calls in one assistant message overlap under the tool loop's concurrency-safe dispatch, while dependent foreground calls can still be issued one at a time.
- Parent guidance, tool schema, runtime resolution, and settlement delivery state the same default.
- A compliant child reports one self-contained final result and may report important findings earlier. Every Activation also produces an unconditional settlement notice, so a completed run may deliver overlapping final content twice.
- One-shot async Tasks and deployments that disable async invocations retain their existing behavior.

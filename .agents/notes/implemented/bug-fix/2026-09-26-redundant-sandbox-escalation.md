# Agent Note: Redundant sandbox escalation fields are a no-op

Status: implemented

English | [中文](2026-09-26-redundant-sandbox-escalation.zh.md)

## Problem

A model may repeat the session's effective mode in `sandbox_permissions` on an ordinary tool call, sometimes with an empty `justification`. The registry-global target enum cannot remove a target already active in a particular session. Pairing validation or the strict-widening check then rejects a command that needed no extra authority. The [sandbox decision](../feature/2026-07-06-sandbox.md) owns the approval boundary; prompt guidance alone cannot guarantee a valid call from every model route.

## Decision

The sandbox package exports `normalizeRedundantEscalation`. Bash, pwsh, write, and edit resolve the call's effective policy, then remove both escalation fields from a copy of the arguments only when the requested mode exactly equals the effective mode. The recorded model call remains unchanged; execution uses the standing policy and never asks for approval. Without a resolved policy, no declaration is removed. Genuine wider requests still require a paired non-empty sentence and user approval; narrower requests still fail before execution. `approveEscalation` retains its strict-widening contract for actual escalation requests.

The shell tools teach models to omit optional arguments that do not change the call and to omit both escalation fields on ordinary calls. Their tool schemas require a strictly wider target and a non-empty reason only on a denied-command retry. The file mutation schemas use the same wording for their escalation fields. Capability-specific guidance appears only when the mounted backend advertises escalation.

## Alternatives considered

- **Rely only on prompt text** — rejected because a model's tool-call arguments may still include defaults or an empty placeholder despite correct guidance.
- **Treat every non-widening target as a no-op** — rejected because a narrower request expresses a conflicting authority choice and must fail closed. Only exact equality is redundant.
- **Put normalization in the tool registry or approval service** — rejected because neither owns the effective per-call sandbox policy; the enforcing consumers resolve it before dispatching an escalation request.

## Consequences

Same-mode calls run once under their already-active policy, with no approval event and no change in authority. Other malformed or unsupported escalation requests remain errors. The recorded tool call may contain the redundant fields, while the executed command uses the normalized copy. Unit tests cover each consumer, the shared helper, and genuinely wider and narrower requests; keyless composition snapshots pin the model-visible prompt and schema.

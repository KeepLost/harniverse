# Agent Note: Per-Session Supervision Mode

Status: implemented

English | [中文](2026-09-01-per-session-supervision-mode.zh.md)

## Problem

Permission preset, sandbox, and approval policy describe what an Agent may do, but they do not describe whether a human-dependent operation may wait. An unattended run could therefore enter the same user-question or approval seams as an interactive run and stall, while a plan review could block completion even when the independent work was already clear.

## Decision

Harniverse owns an independent `supervision/mode` Session event with two values: `supervised` and `unsupervised`. The `dsh-supervision` Service owns the fold, runtime-context guidance, command, and session projection. New user-question and approval requests are rejected before provider dispatch in `unsupervised`; existing in-flight requests are not retroactively cancelled. The model-facing guidance says not to retry blocked interactions, to continue independent work, and to report unresolved user decisions.

Agent Profile metadata may set `supervisionMode` for a new ordinary Session. The Web composer exposes the same current-session switch beside Access Mode. A newly created Child Profile may set its fixed mode; otherwise a child captures the parent's mode at delegation. An `unsupervised` parent cannot define a `supervised` child.

Plan Mode follows a separate boundary rule: unsupervised sessions cannot enter plan mode, but an already-active plan may exit without a user review and proceed on the next step.

## Alternatives considered

**Reuse approval policy `never`.** Rejected because approval policy is a narrower action-decision contract and cannot express user questions, plan review, or the UI's independent supervision choice.

**Cancel all pending interactions when switching modes.** Rejected because mode changes are future policy events; ownership of an already-started operation remains with that operation and its cancellation signal.

**Hide human-dependent tools from the model.** Rejected because the capability seams must remain available to supervised sessions and execution must enforce the decision at the operation boundary rather than relying on prompt or catalog filtering.

## Consequences

Every new session has a durable, replayable supervision value, and projection-capable clients can render the current choice without a second mutable mirror. Persisted child logs retain the delegation-time mode, so cold resume does not re-read the parent's later state. `unsupervised` does not answer external provider-specific dialogs; those adapters retain their own unattended contracts.

## Verification

Focused service, user-question, approval, Plan Mode, child inheritance, Profile metadata, and Web composer tests cover fail-fast behavior, direct plan exit, durable delegation snapshots, and the independent UI selector. The persistence event catalog, Host/Client type aggregates, GUI suite, and built Web replay suite are run as part of delivery.

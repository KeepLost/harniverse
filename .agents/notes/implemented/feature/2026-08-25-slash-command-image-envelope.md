# Agent Note: Slash-command image attachment envelope

Status: implemented

English | [中文](2026-08-25-slash-command-image-envelope.zh.md)

## Problem

The Web composer could submit durable images with an ordinary prompt, but a slash-command claim carried only text. Enter adjudication could not distinguish an image-bearing draft, the command Remote had no image envelope, and command handlers received no durable attachment references. Submitting `/plan` with images therefore consumed the command path while silently dropping the images.

A browser-only declaration check would not protect direct Remote, CLI, fixture, or same-process callers. Admitting bytes before resolving the command or its capability could also create durable objects for unknown or image-incompatible commands. Releasing browser files when dispatch began would make serialization, transport, cancellation, admission, and handler failures destructive instead of retryable.

## Decision

The input-trigger contract carries a `SubmitEnvelope` image count into Enter adjudication. An owning `CommandClaim` declares `images: true` and receives ordered `SubmitImageAttachment` payloads only when the resolved Host command descriptor declares `input.images: true`. Unknown commands, client popup contributions, decorations, bare Host commands, and non-declaring input commands reject image-bearing Enter before UI action or Remote dispatch.

The conversation input shell extends the [composer transaction owner](../bug-fix/2026-08-24-composer-transaction-and-cache-precision.md) across command-image serialization and Host settlement. It captures only unreserved image ids, keeps the draft and browser resources on every unsuccessful settlement, and removes ids and revokes their resources only after success. Cancellation and scope disposal suppress late publication and await the retained completion.

`CommandRuntime.execute(agent, line, images, signal)` is the authoritative capability boundary. It resolves syntax and the effective command before attachment work, enforces `input.images` for direct and Remote callers, decodes canonical base64 through `admitEncodedImages`, and applies the mounted attachment store's deployment limits through ordered batch admission. The handler receives frozen provider-neutral `ImageBlock`s containing durable references; the command package imports no provider wire vocabulary. Declaration and admission refusal enter no handler and create no durable image object.

A handler owns every grammar and model-use decision after admission. If a subcommand cannot use images, it returns an error so the composer retains its source drafts. If the images become model-visible, the handler writes them through its ordinary durable domain message path; provider adapters continue to own request projection. `/plan` declares image capability, rejects images with the exact `off` subcommand, and steers ordered durable image blocks followed by optional text as one logged user message.

## Alternatives considered

**Reuse provider-native image payloads in the command contract.** Rejected because the command registry is provider-neutral. Durable `ImageBlock` references preserve the existing attachment seam and leave request encoding, upload, and privacy policy with each provider adapter.

**Enforce image support only in the Web client.** Rejected because direct Remote, CLI, fixture, and same-process callers could bypass a presentation-layer check and invoke an incompatible handler or write attachments with no owner.

**Admit images inside each command handler.** Rejected because every command would duplicate base64 validation, deployment limits, storage lookup, ordering, and error settlement. The executor is the single operation that knows the resolved declaration before handler execution.

**Release browser resources after serialization or Remote dispatch.** Rejected because neither point proves command success. Retaining the original draft objects until successful settlement makes every failure path retryable without reconstructing user input.

## Verification

Attachment tests cover canonical base64, invalid payloads, media policy, count and aggregate limits, ordered admission, and no writes before batch validation completes. Command runtime tests cover unknown and unsupported commands, direct-call enforcement, absent storage, accepted ordered blocks, handler suppression, and attachment admission errors.

Client tests cover envelope forwarding, popup and bare-command refusal, fixture Remote forwarding, successful release, and draft/image retention across serialization, transport, cancellation, and handler failure. Plan tests cover image-only and mixed image/text messages plus `/plan off` refusal. A keyless assembled Web composition covers unsupported retention and successful image-only `/plan` cleanup.

## Consequences

Command declarations expose one small image capability while command handlers receive the same durable provider-neutral block currency as ordinary model input. Direct callers cannot bypass policy, and accepted `/plan` images become reconstructable logged input without changing ordinary prompt projection.

Successful command-image submission performs browser encoding and Host durable admission before handler execution. Cancellation after durable admission can leave an unreferenced immutable object for deferred garbage collection, matching the attachment seam's retention-neutral policy; the browser source remains available because the command did not settle successfully.

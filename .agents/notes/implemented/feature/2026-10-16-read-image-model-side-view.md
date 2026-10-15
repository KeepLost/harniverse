# Agent Note: read_image model-side view

Status: implemented

English | [中文](2026-10-16-read-image-model-side-view.zh.md)

## Problem

`read_image` returns images to the model as durable references plus a per-request projection: the attachment store keeps the original bytes, while the request path derives a bounded model-request version (`readImageRequest`, default 2048² px / 1 MiB, 512² low detail). The UI showed none of this. A tool card rendered the image block of a settled result as raw JSON, and the details panel did the same, so a user could not see what the tool actually produced — let alone the resized copy the model received, which is the view that matters when a model misreads a screenshot.

## Decision

**Expose each image-capable route's projection policy, project on demand at read time, and render every settled tool-result image through it.**

The LLM seam carries the policy. `LlmResolvedModelInfo` gains `imageRequestPolicy?: ImageRequestPolicy`; `resolveModelInfoFor` validates it (`INVALID_MODEL_IMAGE_POLICY`) beside the other metadata. The DeepSeek adapter publishes the same `requestImagePolicyOf(model)` its request path uses, only for catalog entries whose `inputModalities` include `image`; the pi-ai adapter publishes its route budget when pi-ai's model `input` includes `image`. A route without an image capability publishes nothing, which reads as "no model view to resolve".

The Host projects at read time. `session.attachment` accepts `variant: 'model'`: it locates the referenced image, resolves the call config of the request that next carried it (the header in effect at the first step/turn boundary after the carrying event, or the header current at log end for an interrupted turn), resolves that route's policy through `llm.resolveModelInfo`, and serves `readImageRequest` bytes with `projected: true` and the projected media type and dimensions. Any failure on that path — no policy, unresolvable route, `ATTACHMENT_PROJECTION_UNSUPPORTED`, route error — serves the stored original with `projected: false`, so an old provider composition degrades to today's answer instead of an error. The projection is computed per read and never stored: policies are deployment- and model-owned facts that change with configuration, and the durable object stays the original.

The client threads a loader. Runtime `readAttachment` passes the variant through; the conversation controller owns `resolveImage(sessionId, attachment, variant)` with a per-`${sessionId}:${variant}:${attachmentId}` cache; the chat-node, details, and tool-call owner props all expose it as `loadModelImage`. ui-tool consumes it generically: every tool row renders its result's image blocks inline beneath the collapsed row through the shared attachment gallery (model-side loader, conversation-namespace labels bridged locally), and `ToolDetails` renders the same gallery under the card. Image blocks leave the flattened result text everywhere — the JSON blob is gone from both surfaces.

## Alternatives considered

**Persisting the projected bytes at `read_image` time.** Rejected: the projection is a function of the route's current policy; persisting one frozen copy either bloats the durable store per route or goes stale the moment a policy changes, and the on-demand read is one bounded derive against bytes already on the host.

**Serving the original only and labeling it.** Rejected as the primary behavior: the user's report is specifically that the model sees a different image than the tool produced; the original-only answer is kept precisely as the labeled fallback.

**A dedicated image viewer route keyed by message id.** Rejected: `session.attachment` already owns session-authorized image reads and its reference-scan authorization; a parallel route would duplicate the trust boundary.

## Consequences

Every image-bearing tool result now shows the image in chat and details, projected the way the model received it when the route can say so and clearly marked (`projected: false`) when it cannot. The wire change is additive (optional request field, optional response flag), so replayed old fixtures and older clients are untouched. The authorization surface does not grow: the same declared-carrier scan gates both variants.

Verification: apiproxy projection tests (policy projection, no-policy original, unsupported/route-failure fallbacks), runtime variant pass-through, llm policy validation and adapter publication (deepseek, pi-ai), ui-tool row/details gallery rendering with the loader wired, and the full client suite green.

PR: #192 (merge)

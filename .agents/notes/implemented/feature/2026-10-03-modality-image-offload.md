# Agent Note: Modality image offload — text-only routes settle at the request boundary

Status: implemented

English | [中文](2026-10-03-modality-image-offload.zh.md)

Scope: `packages/compaction/image-offload-policy`, `packages/compaction/compaction-image-offload`, `packages/attachment/attachment`, `packages/host/apiproxy`

## Problem

Switching a session to a text-only model — or a route fallback landing on one — wedged every later turn: both adapters throw `UNSUPPORTED_CONTENT` the moment any retained image occurrence rides the request, and the apiproxy compounded it by refusing the switch itself whenever the session had ever held an image. The wave-3 image-offload machinery only knew `'age'` and provider `'pressure'`, and its stub carried no path, so a vision model returning to the session had no documented way to re-view what had been unloaded.

## Decision

- **New `'modality'` reason** beside `'age'` and `'pressure'` (`image-offload-policy/src/types.ts`). `resolveImageOffloadDecisions` gains `routeAcceptsImages: false`, which bypasses age and pressure and settles **every** active occurrence — tool-result images included — oldest first.
- **Request-boundary settlement before dispatch** (`compaction-image-offload/src/index.ts`). The `agent/request` listener is re-registered `{ prepend: true }` so it wraps outermost: age decisions settle before `next()`, then `await next()` observes the **final** config — including any model a fallback listener substituted — and, when `resolveModelInfo` reports input modalities without `image`, appends one `image/offload` decision covering all occurrences. Unknown modalities, a missing llm or attachment service, or a resolution failure skip the settlement silently; the adapters' own `UNSUPPORTED_CONTENT` guard remains the loud safety net. Images produced later in the same session settle at the next boundary.
- **Path-bearing stubs through the A5 hard-link mechanism.** Each settled occurrence gets a stub formatted like `fileHandleText` (new `imageHandleText` in `dsh-attachment/file-handle`): name, size, digest prefix, the read-only hard-link path minted by `attachments.publishFileHandle`, and the statement that the current model cannot view images. The stub rides the durable decision as an optional per-target `stub` field and replays verbatim — the minted path is machine-local, so only the log can reproduce the exact text the model saw. Age and pressure targets keep the canonical constant stub.
- **The first request after a model switch ignores prefix stability** — deliberately: the route changed, so the provider prefix is already cold; the settlement does not try to preserve it.
- **Switching back keeps the stubs** (model-visible ⇔ logged); the model re-views an image through `read_image` on the named path, whose route gate admits it exactly because the route is vision again.
- **The apiproxy refusals are gone**: `selectModel`, `selectModelTarget`, and the image-prompt admission no longer reject text-only models for image-bearing sessions, and the `serializeImageAdmission` seam those checks justified is removed (archive/close paths no longer wait on it).

### Session-contract claim (v0 additive)

The `image/offload` payload gains one **optional** `stub` field per target. The session-contract digest stayed unchanged (`verify-session-contract-digest` passes without a baseline refresh): the digest records the payload type reference, and `ImageOffloadEventData` remains the declared reference. The persistence catalog embeds the expanded declarations and was regenerated (`gen-persistence-catalog`, `known-event-types.ts`, bilingual pairing re-recorded). Readers that ignore unknown target fields — older projections, the invariant before this change — are unaffected because the field is optional and validated only when present.

## Alternatives considered

- Reactive recovery on `UNSUPPORTED_CONTENT` (the official `IMAGE_OFFLOAD_REQUIRED` waterfall shape): rejected — the owner decision requires settlement **before dispatch**, and Harniverse providers raise no durable pressure code the waterfall could bind to.
- Deriving the stub path inside the projection at derive time: rejected — replay on another machine would render a different path, breaking "model-visible ⇔ logged".
- Keeping the apiproxy admission refusals as a UI nicety: rejected — they contradict the settlement (the switch is now safe) and forced the extra serialization seam.

## Consequences

Text-only routes finally continue cleanly after a switch or fallback; the request carries truthful path-bearing stubs instead of failing. `read_image` re-views work because the minted links are content-addressed and idempotent. Compositions without the attachment service keep the old loud adapter failure (settlement cannot mint a path). The stub text is Chinese-line formatted like its file-handle sibling for prompt consistency.

## Verification

- `packages/compaction/image-offload-policy` policy specs: modality selects every active occurrence (user and tool-result), bypasses age, never re-settles prior decisions.
- `packages/compaction/compaction-image-offload` specs: projection renders verbatim stubs beside constant stubs across consecutive decisions and rejects empty stubs; the invariant companion rejects empty/non-string stubs; `tests/modality.spec.ts` covers vision → text-only → vision switching (stub persists, minted link bytes equal the retained attachment, `read_image` on the path re-enters model context), later-produced images settling at the next boundary, no settlement on vision or unknown-modality routes, and a real `model-policy-fallback` route landing on a text-only target without `UNSUPPORTED_CONTENT`.
- `pnpm run verify-session-contract-digest`, `pnpm run verify-persistence-catalog`, `pnpm run verify-translation-pairing` all green after the catalog refresh.

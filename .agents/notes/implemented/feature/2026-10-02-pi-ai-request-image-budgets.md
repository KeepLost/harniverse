# Agent Note: pi-ai request images project under per-model budgets

Status: implemented

English | [中文](2026-10-02-pi-ai-request-image-budgets.zh.md)

## Problem

The pi-ai adapter shipped every request image as the stored original: `context.ts` resolved image blocks with `AttachmentStore.readImage`, so whatever bytes admission had accepted (up to 5 MiB and 40 MP per image) went on the wire verbatim. `llm-deepseek` had already moved to `readImageRequest` projection under per-model budgets (2048² pixels / 1 MiB defaults, 512² for `'low'` detail); pi-ai routes — including OpenAI, Anthropic, and DeepSeek gateways behind pi-ai — kept paying full-size tokens for content every provider downscales server-side anyway.

## Decision

Port the `llm-deepseek` pattern into `llm-pi-ai` with the same defaults:

- `models` entries gain two optional fields: `imageMaxBytes` (encoded bytes one projected request image may occupy, before base64 expansion) and `imagePixelBudget` (total pixels request images project under, aspect-preserving, or `'low'` for the 512² low-detail budget). Both are carried through route resolution as `configuredImageBudgets` on `ResolvedPiAiProviderProfile`, alongside `configuredMaxTokens` — catalog entries declare no budgets of their own, so absence cleanly means "adapter defaults".
- The adapter computes an `ImageRequestPolicy` per request from the routed model's entry (`'low'` → 512², an explicit number wins, absent → 2048² pixels and 1 MiB) and hands it to `toPiContext`, which threads it into `userContent` for both user images and nested tool-result images. Dispatch now calls `attachments.readImageRequest(ref, policy)`; `readImage` is no longer on the request path.
- The overload set keeps the old `(options, attachments, onReplayDegrade?)` shape working and adds `(options, attachments, policy, onReplayDegrade?)`; explicit overloads (rather than a union parameter) preserve contextual typing of the replay-degrade callback.
- A mounted attachment provider that cannot project (base-class `readImageRequest` refusing with `ATTACHMENT_PROJECTION_UNSUPPORTED`) now fails the image-bearing request where the stored-original read used to succeed — the same contract `llm-deepseek` already has. The bundled attachment store implements projection, so compositions on the default store are unaffected.

## Alternatives considered

**Keep shipping originals.** Rejected: token cost and wire size for a downscale every major provider performs server-side; `llm-deepseek` had already established the projected-request contract as the house pattern.

**Derive budgets from pi-ai's model catalog (for example `inputLimits`).** Rejected: the installed catalog states provider capability, not deployment policy; the two new fields follow `maxTokens` in being explicit configuration that resolution records per model id.

## Consequences

Request images on pi-ai routes are bounded by configuration instead of admission limits; admission gates (5 MiB / 40 MP / 20 per message) remain the durable-store ceiling and are unchanged. Custom attachment providers that only override `readImage` must now also implement `readImageRequest` to serve image-bearing pi-ai requests. Test stubs across `adapter.spec.ts`, `context.spec.ts`, and `convert.spec.ts` project through `readImageRequest`, with a shared `ProjectingStubStore` base for the adapter-level store stubs.

## Tests

`pnpm exec vitest run packages/llm/llm-pi-ai/tests` — 300 tests, including the new `projects request images through readImageRequest with per-model budgets` adapter test (asserts the policy reaching the store is `{maxPixels: 512 * 512, maxBytes: 2048}` from an `imagePixelBudget: 'low'` + `imageMaxBytes: 2048` entry, that the projected bytes — not the original — reach the wire, and that `readImage` is never called), plus the migrated stubs asserting nested tool-result images and the no-observer path still resolve. `pnpm exec tsc -p packages/llm/llm-pi-ai --noEmit` and `scripts/run-oxlint.ts` on the touched files are clean.

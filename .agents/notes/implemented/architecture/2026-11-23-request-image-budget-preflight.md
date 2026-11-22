# Agent Note: Pre-flight request-image budgets — the body-limit ponytail lands

Status: implemented

English | [中文](2026-11-23-request-image-budget-preflight.zh.md)

## Problem

`compaction-body-limit-recovery` (see [413 request-body recovery](../bug-fix/2026-11-03-body-limit-recovery.md)) was the reactive net: discover the transport cap by hitting it, settle every image, compact, retry. Its own ponytail named the ceiling — "a proactive request-body budget … pre-settle before send" — because a 413 round-trip is a wasted attempt and whole-history settlement drops images the request could have kept. The pi-ai path had no aggregate bound at all: `toPiContextWithImages` inlined every retained occurrence as base64, so an image-heavy session on any gateway could exceed the body cap on every attempt.

## Decision

- **`dsh-llm` owns the shared selection.** `packages/llm/llm/src/request-images.ts` extracts `limitRequestImages` (oldest-first selection under byte and count budgets with removal quanta) and `projectImageOmissions` (commit dropped wire coordinates through `GenerateOptions.onImagesOmitted`, or local omission stubs without the hook) from `dsh-llm-deepseek`, where they existed for the DeepSeek provider limits. `ImageWireLocation` becomes a `dsh-llm` type both adapters share.
- **pi-ai profiles gain the route budgets** `maxRequestImageBytes` (default 20 MiB), `maxRequestImages` (default 50, Azure OpenAI's documented GPT-4o/4.1 bound), `imageOffloadByteQuantum` (default 10 MiB), and `imageOffloadCountQuantum` (default 10), validated as positive safe integers at profile resolution. `toPiContextWithImages` reads one request version per unique attachment, applies the selection before the message walk, and projects the dropped occurrences — so over-budget requests shrink **before they leave**, settling through the composed compaction owner's durable `image/offload` path (`compaction-image-offload` wires `onImagesOmitted`) or local stubs without it. Repeated references read once.
- **`compaction-body-limit-recovery` is deleted** per its own upgrade-path note: the pre-flight budget removes the image-driven 413 class it existed for, and the age/modality/budget settlements now run before dispatch. `REQUEST_BODY_TOO_LARGE_CODE` and its classifiers stay in `dsh-llm` — the classification remains the honest signal for a genuinely oversized non-image envelope.

This diverges from the official 0.2.3 approach (`IMAGE_OFFLOAD_REQUIRED` failure + agent/request-error retry loop): harniverse already settles provider image pressure inline at assembly (`onImagesOmitted` → durable `image/offload` → fresh projection), so the same durable events land with zero wasted attempts and no new retry path.

## Alternatives considered

- **Adopt the official fail-and-retry shape** — rejected: it reuses our existing settlement seam only after a failed round-trip; the inline selection lands the same durable decision before the request leaves.
- **Keep the reactive package beside the budget** — rejected: two owners for one failure class; the note's own removal condition ("remove this package when that lands") applies.
- **A whole-body (text + images) pre-flight budget** — deferred: the image aggregate covers the observed 413 class (per the recovery note, text-only histories almost never trip body caps; tool results are bounded by `tool-result-artifacts`). A text-side estimator needs provider-specific size signals worth its own design.

## Consequences

- pi-ai image-heavy sessions stop paying 413 round-trips; the oldest occurrences settle durably once per quantum of new images, and a later vision request re-reads retained originals through the existing offload stubs.
- Deployments behind tighter gateways lower `maxRequestImageBytes` per route; the DeepSeek line keeps its own connection-level limits unchanged.
- The recovery package's text-side safety net is gone: a single enormous non-image envelope now surfaces its original transport error instead of being compacted once. Tool results are capped by `tool-result-artifacts` (50k chars visible, spill + `artifact_read` paging), and context-overflow compaction still runs on its own trigger.
- Evidence: `llm-pi-ai/tests/request-image-budget.spec.ts` (byte and count budgets, hook settlement, local stubs, single read per attachment, 4 tests); `llm-deepseek` suites unchanged in behavior (485+ tests); llm/compaction composition catalogs and module graphs regenerated.

# Agent Note: generic file upload

Status: implemented

English | [中文](2026-09-07-generic-file-upload.zh.md)

## Problem

Images were the only attachment class with a durable pipeline (admission, content-addressed storage, model-visible inline text). Any other user file — a PDF, a CSV, a log — could reach the model only by pasting bytes into the composer, where they inflated the wire prompt, escaped the session log's reconstruction guarantee, and bypassed every size/durability policy the attachment seam already owned. A5 extends the seam so any file rides the same discipline: one upload route, one admission transaction, one publication layout.

## Decision

Three owner-approved points fixed the shape (brief `A5-FILE-UPLOAD-BRIEF.md`): `maxFileBytes` defaults to 100 MiB (resolved per store, `FileAttachmentLimits`); published read-only handles live in one global `attachments/v1/links/` directory (`<sha8>-<leaf>`); and observers cannot upload. The capability gate reuses the closed four-capability vocabulary — the route demands `harniverse.operate`, whose "may act on sessions" semantics is exactly upload authority, rather than minting a fifth `harniverse.attachments` capability (a deliberate brief deviation recorded here; zero authorize-surface change, observers denied because they lack operate).

**Storage** (`c468b0e778`): the `dsh-attachment` seam gains `FileAttachmentRef` / `SaveFileAttachment` / `StoredFileAttachment` / `FileAttachmentLimits` and three default-denying `AttachmentStore` members (`saveFile` / `readFile` / `publishFileHandle`), so an unprepared store refuses uploads instead of accepting them. `attachment-local` implements them: `saveFileObject` stores bytes verbatim under the content address (empty files invalid, oversize rejected at the complete-result boundary), `readFileObject` re-verifies the digest before returning bytes, and `publishFileHandle` creates an idempotent 0o444 hard link with a sanitized leaf (`UNSAFE_LEAF` cleansing, `.bin` fallback for unnamed files). The image publication skeleton was extracted into a shared `publishObject` (durability, atomic link, dedup verification preserved verbatim).

**Route** (`1b6a0ab45d`): `POST /api/attachment/upload` in the client-connection Host face — trust fence (`isTrustedApiRequest`) → authentication → operate check (403) → store capability probe (501) → Content-Length precheck (413) → chunked body with a capped accumulator that destroys the request the moment the ceiling is crossed (413) → receipt JSON. The body is raw bytes, not multipart; the name rides `x-attachment-name` URI-encoded. `AttachmentError` maps `FILE_TOO_LARGE`→413, `INVALID_FILE`→400.

**Admission** (`124a1d02e0`): file parts in a prompt content array enter one `durablePromptContent` transaction returning `{blocks, files}` — every file part is `readFile`-verified and `publishFileHandle`-published before any block exists; any failure rejects the whole prompt (attachment-error), so a session never references an unpublished handle. The model-visible form is deterministic Chinese handle text (`[文件] 名 · 大小 · sha256:前8`, read-only path, an instruction to use the read tool rather than guess from the name) inlined as a text block; file bytes never enter a model request. A log-only `user/file` event is appended immediately before its `user/message` (position correlation) carrying the deduped refs, for UI badges, export manifests, and admission auditing; `MessageSource.user.files` carries the same refs to consumers. `KNOWN_SESSION_EVENT_TYPES` is generated, so the persistence catalog was regenerated in the same commit — appending without regeneration is rejected at runtime.

**Client** (`3e2cf28877`): an XHR upload transport (`fetch` cannot report upload progress universally) with progress and AbortSignal bridging; a composer file entry whose chips show pending/error/remove states in the B7 link-color language; `user/file` badge rows rendered on the owning user message; submit assembles one `file` part per chip ahead of the text. Chinese copy throughout (`locales.ts`), English code comments.

## Alternatives considered

**multipart/form-data** — the route consumes raw bytes because the transport (XHR on a Blob) already owns framing, and a parser would add a boundary surface to audit for a single-file body.

**A fifth capability (`harniverse.attachments`)** — rejected: capabilities are a closed four-vocabulary seam, operate's semantics already cover "may modify session-bound state", and a new capability would need authorize UI, preset, and documentation for authority indistinguishable from operate's.

**Storing handle text in the `user/file` event instead of the message** — rejected: replay and model requests must not depend on a log-only record; the message's own content is the authoritative model-visible surface, and the event is additive metadata.

## Consequences

Observers cannot upload (no operate), sub-profile prompts share the same admission transaction (`session.prompt` and `subagent.prompt` funnel through one admit), and oversized or corrupt files die at the earliest boundary (route precheck, admission verify). The global `links/` namespace flattens publication (one directory, content-addressed prefixes) — collision-safe by sha8 prefix, but a name-collision audit across sessions is a directory listing. `user/file` is deliberately not a SurfaceEventType, so it never reaches surface folding; consumers correlate by position. The 100 MiB default is per-store configurable, not per-profile. Model-visible upload accounting (does handle text belong in token budget notes) is deferred with the README's known-limitations entry.

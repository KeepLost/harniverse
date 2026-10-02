# Agent Note: Declared session attachment carriers

Status: implemented

English | [中文](2026-10-02-declared-session-attachment-carriers.zh.md)

## Problem

Attachment authorization (`session.attachment`) and ZIP export media discovery inferred image ownership from common payload field names on arbitrary events. An ignorable plugin payload whose `data` happened to carry a `content` array with an image-looking attachment could therefore authorize an attachment-store read; two export tests also relied on fabricated carrier shapes (`assistant/message` with flat `data.content`, a nonexistent `context/inserted` event) that only this inference could satisfy.

## Decision

Both readers select content fields by built-in event type: `user/message` (the message is the data itself), `assistant/message` and `tool/result` (`data.message.content`), `agent/inbox/spliced` (validated `inserted[].content`), and `assistant/chunk` block-end blocks. Everything else — including ignorable plugin events with same-named fields — stays opaque: the live route answers `ATTACHMENT_NOT_REFERENCED` without reading storage, and the exporter still writes the complete logical log verbatim while omitting only the media object.

Unlike the official fix, nested tool-result traversal stays: the Harniverse v0 `tool/result` message nests attachment-bearing content inside `tool-result` blocks, and the live route's `imageBlockIn` already restricted recursion to those blocks. Harniverse has no separate compaction carrier to admit — v0 compaction summaries ride `user/message` replace operations, which the `user/message` case already covers.

## Alternatives considered

**Scan common keys on every event.** A field name would grant attachment access without a defined content meaning, and valid content stored under a different declared field would be missed.

**Drop nested tool-result traversal like the official fix.** Official V4 tool results are flat, so nested descent reads extra block fields. The v0 tool-result shape nests attachment-bearing content by design, so traversal is the declared path, not an inference.

## Consequences

Plugins that store image references only inside custom events cannot use these built-in readers for them; they need a declared carrier or their own reader. Adding a built-in content carrier now requires updating both readers plus their acceptance and refusal tests (the refusal tests assert the attachment store is never read). The fabricated export fixtures were corrected to real v0 shapes, so the tests now double as shape documentation.

Ported from official DSH `0c44e5461d` (Tianyi Cui) during the 2026-10-02 wave-4 absorption.

## Verification

`api-proxy-models.spec.ts` denies an ignorable `plugin/custom-note` payload claiming `att-ghost` and asserts `readImage` is never called; `session-export.spec.ts` exports the nested `tool/result` image while skipping the opaque `ghost` media entry and preserving the log verbatim. Full apiproxy suite: 600 passed.

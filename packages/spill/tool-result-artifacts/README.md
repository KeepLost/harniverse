# @deepseek-ai/dsh-tool-result-artifacts

English | [中文](README.zh.md)

The finalized-result artifact Consumer. One function plugin listens on `tools/finalize-result`, durably retains oversized text through `ctx.spillStore`, emits a bounded recoverable result, and registers the model-facing `artifact_read` tool that pages the same storage capability.

## Behavior

After definition-owned `finalizeContent`, the retention listener counts Unicode code points across recursively nested model-visible text blocks. A result over `maxResultTextChars` is saved verbatim before its inline text becomes a head/tail preview containing `[Full result: artifact_read locator="<locator>" (<bytes> bytes)]`; non-text blocks and canonical values remain intact. Storage failure, missing agent ownership, an incorrect backend byte count, or a locator that cannot fit produces the bounded `TOOL_RESULT_RETENTION_FAILED` warning instead of an unrecoverable partial success. The warning states that the operation may have completed and must not be retried blindly.

`artifact_read` requires an opaque `locator` returned by a spill backend and accepts an optional opaque `cursor` returned by an earlier call. The tool passes both strings to `SpillStore.readText` unchanged and never parses them, maps them to host paths, or accesses storage directly.

The canonical result is the closed object `{ text, nextCursor? }`. The Native renderer emits `text` verbatim, preserving Unicode content. When `nextCursor` is present, it appends `artifact_read cursor="<nextCursor>"` after one blank line. Without `nextCursor`, the rendered result is exactly `text` with no wrapper or suffix. Backend rejection becomes a standard failed tool result.

The pending UI presentation uses a generic read card. It treats the locator as opaque input and publishes no file location metadata.

## Configuration

| Key | Default | Meaning |
|---|---:|---|
| `maxResultTextChars` | `50000` | Maximum Unicode code points across recursively model-visible finalized text. Integer from `120` through `50000`. |
| `pageChars` | `12000` | Maximum Unicode code points requested from `SpillStore.readText` per call. Integer from `1` through `50000`. |

Loader normalization and direct `apply(ctx, config)` calls use the same defaults and bounds. Registration also requires `pageChars` plus continuation guidance to fit `maxResultTextChars`; an incompatible deployment fails at load rather than retaining an `artifact_read` page as another artifact. Backend cursors are capped at 90 Unicode code points so the guidance remains within the result limit.

## Export Shape

This is a named function plugin: it exports `name`, `inject`, `Config`, and `apply`, with no default export. It injects `tools` and `spillStore`; unloading its fiber removes both the final-result listener and the retrieval tool.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`artifact_read` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-result-artifacts), including the opaque locator and continuation cursor instructions.

#### Token effect

The tool has a fixed schema cost on each request where it is visible.

#### KV Cache effect

The schema remains prefix-stable while its definition and visibility are unchanged. Plugin lifecycle or scoped visibility changes may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each call retains its locator and optional cursor in tool-call history. A successful result contains at most the backend page requested with `pageChars`, plus short continuation guidance only when unread text remains.

#### Token effect

Result growth is bounded per call by the configured page size plus continuation guidance. Reading additional pages adds separate calls and results to history until compaction.

#### KV Cache effect

Append-only; each page follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Oversized finalized result

#### What the model sees

The model sees a bounded head/tail preview with an opaque `artifact_read` locator, or a bounded non-retry warning when complete retention fails.

#### Token effect

The complete text remains outside model history; only the configured preview and requested pages consume result tokens.

#### KV Cache effect

The preview, warning, and later pages are append-only and do not invalidate the existing reusable request prefix.

## Known Limitations and Deferred Work

- **Sequential text paging only** — the tool has no search, locator discovery, random access, or metadata operation; callers can continue only with the opaque cursor supplied by the backend.
- **No artifact garbage collection** — retained files can outlive every session reference; the selected backend and deployment own cleanup.

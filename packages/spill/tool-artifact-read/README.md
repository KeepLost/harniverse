# @deepseek-ai/dsh-tool-artifact-read

English | [中文](README.zh.md)

The model-facing `artifact_read` tool reads bounded text pages from artifacts stored behind `ctx.spillStore`.

## Behavior

`artifact_read` requires an opaque `locator` returned by a spill backend and accepts an optional opaque `cursor` returned by an earlier call. The tool passes both strings to `SpillStore.readText` unchanged and never parses them, maps them to host paths, or accesses storage directly.

The canonical result is the closed object `{ text, nextCursor? }`. The Native renderer emits `text` verbatim, preserving Unicode content. When `nextCursor` is present, it appends `Continue with artifact_read using the same locator and cursor "<nextCursor>".` after one blank line. Without `nextCursor`, the rendered result is exactly `text` with no wrapper or suffix. Backend rejection becomes a standard failed tool result.

The pending UI presentation uses a generic read card. It treats the locator as opaque input and publishes no file location metadata.

## Configuration

| Key | Default | Meaning |
|---|---:|---|
| `pageChars` | `12000` | Maximum Unicode code points requested from `SpillStore.readText` per call. Must be an integer from `1` through `50000`. |

Loader normalization and direct `apply(ctx, config)` calls use the same default and bounds. Registration also requires `pageChars` plus the reserved continuation sentence to fit the resolved `ToolRuntime.maxResultTextChars`; an incompatible deployment fails at load rather than retaining an `artifact_read` page as another artifact. Backend cursors are capped at 128 Unicode code points so the reserved sentence remains authoritative.

## Export Shape

This is a named function plugin: it exports `name`, `inject`, `Config`, and `apply`, with no default export. It injects `tools` and `spillStore`.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`artifact_read` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-artifact-read), including the opaque locator and continuation cursor instructions.

#### Token effect

The tool has a fixed schema cost on each request where it is visible.

#### KV Cache effect

The schema remains prefix-stable while its definition and visibility are unchanged. Plugin lifecycle or scoped visibility changes may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each call retains its locator and optional cursor in tool-call history. A successful result contains at most the backend page requested with `pageChars`, plus a short continuation sentence only when unread text remains.

#### Token effect

Result growth is bounded per call by the configured page size plus continuation guidance. Reading additional pages adds separate calls and results to history until compaction.

#### KV Cache effect

Append-only; each page follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Sequential text paging only** — the tool has no search, locator discovery, random access, or metadata operation; callers can continue only with the opaque cursor supplied by the backend.

# Agent Note: Wave-6 workspace bytes absorption

Status: implemented

English | [中文](2026-11-10-wave6-workspace-bytes-absorption.zh.md)

## Problem

The file/image context-menu contributions queued as batch D stage (e) need two primitives the current `workspace.files.*` domain does not expose: a file's availability without its content (upstream menus decide "download original" affordances from a stat), and raw bytes of files that are not images or PDFs (upstream downloads the original file through the client). Upstream's `workspaceFiles` face answers these with `stat` and `readBytes`; harniverse's face stops at text and media-typed binary.

## Decision

Add `workspace.files.stat` and `workspace.files.readBytes` as unary rows on the existing read-only domain, both gated by `harniverse.observe` and classified as reads like their siblings:

- **`stat`** answers one regular file's canonical absolute path (symlinks resolved by the shared containment resolution), an opaque freshness token derived from the modification timestamp (the same `{absolutePath, version}` shape the SSE watch frames already carry), and the size. Directories reject with `workspace-entry-type-invalid`; a missing path stays `workspace-entry-not-found`.
- **`readBytes`** returns one raw byte window of ANY regular file as base64 with no media-type verdict, because the consumer is "save the original", not "render": an explicit `{offset, length}` window is capped at 8 MiB per call, while an omitted window reads the complete file only when it fits the same cap (`workspace-file-too-large` otherwise). Reads use a positioned descriptor so a window never materializes the whole file, and the response carries `{path, offset, dataBase64, bytes, eof}` so a caller can stream a larger file window by window.
- **`session.openWorkspacePath` is consciously not ported.** Upstream's reveal-in-file-manager op assumes the saved file lands on the host filesystem; harniverse saves are client-side browser downloads, so a host-side reveal has no meaningful target. The seam is recorded for stage (e): the contribution drops the reveal notice action and keeps download-only semantics.
- Wiring follows the nine-surface row checklist (interface, zod schemas, rpc-map capability/effects tables, handler invoke, fetch client, host proxy, inspector pure functions, client runtime passthrough, and both fake doubles plus the in-memory fixture carrier with dispatch cases).

## Alternatives considered

**Widen `readBinary` beyond the image/PDF allowlist.** Rejected: `readBinary`'s media-type contract is load-bearing for preview surfaces, and stretching it to arbitrary extensions would make every caller re-verify the file kind it thought the allowlist guaranteed.

**Derive availability from `list`.** Listing answers a directory level, not one path's resolved identity; a stat-by-list cannot express symlink-resolved absolute paths or a stable freshness token.

## Consequences

The workspace face can now back "save original" flows for arbitrary regular files under the registered root, window-capped at 8 MiB per call. The API catalog carries both rows. No client UI consumes the rows yet; stage (e)'s file/image contributions are the first consumer, adapting upstream's session-keyed calls to the workspaceId-keyed face. Host-side reveal remains a recorded seam until a host-files save mode exists.

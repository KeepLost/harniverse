# `@deepseek-ai/dsh-file-reference`

English | [中文](README.zh.md)

`ctx.fileReferences` is the Host capability contract for bounded, cancellable path discovery. Providers return relative file and directory paths only; selecting a path never reads, uploads, or attaches its contents. `activeAtToken()` and `formatFileMention()` share the browser grammar for ordinary `@path` and quoted `@"path with spaces"` text.

`FileReferenceService.remoteExportList()` publishes `fileReferences/list` with the required `harniverse.observe` capability. The service is intentionally discovery-only; the model reads selected files through the separately composed `read` tool.

## Model Experience

None, as this package defines a discovery capability and does not add model-facing context by itself.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Provider policy is separate** — workspace bounds, traversal exclusions, and ranking belong to the selected Provider rather than this Definition.

# `@deepseek-ai/dsh-fs-vm`

English | [中文](README.zh.md)

Serves the filesystem seam over one execution world's interior: every target, path, and byte belongs to the guest. Identity is lexical, reads are strict UTF-8 with encoding decisions, guarded writes and literal edits serialize per target and land through the world's own temp-then-rename atomic replace, and mutations are checked against the per-call sandbox policy host-side — the world agent offers no policy enforcement of its own.

## Model Experience

Indirectly, through the filesystem tools, which render this world provider's reads, writes, and edits exactly as they render local files.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **Identity is lexical** — targets normalize without crossing the seam, so guest symlink aliases resolve to separate targets; symlink-aware identity waits for a world-side realpath operation.
- **The freshness token carries the wire stat's granularity** — kind, size, and mtime at the wire's resolution; sub-stat-mtime write races can slip a stale guard.
- **Writes are UTF-8 only and preserve no legacy encoding or mode** — a decodable prior file yields its text as the diff basis; an undecodable one yields `before: null`, and the replaced file's mode is the world's default.
- **`lstat` cannot distinguish a symlink** — the world exposes one stat; path-level trust rules that need `symlink` typing stay on the local provider.
- **World wire caps bound single operations** — reads and write payloads above the world's cap fail `FS_TOO_LARGE`; large-file support is the data-plane milestone's question.
- **No world default working directory exists** — relative paths require a caller `cwd`; there is no host `process.cwd()` fallback in a world. A caller cwd under the boot-anchored host workspace root (`DSH_VM_HOST_WORKSPACE_ROOT`, set by app boot for the vm world) maps one-to-one into `/workspace`; world-absolute cwds pass through, and any other host path fails closed with the mapping diagnosis.

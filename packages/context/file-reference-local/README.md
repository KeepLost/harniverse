# `@deepseek-ai/dsh-file-reference-local`

English | [中文](README.zh.md)

The local Provider indexes each live Agent workspace with a bounded breadth-first traversal. It excludes `.git` and `node_modules` by default, does not follow directory symlinks, rejects paths outside the workspace, and returns deterministic path-only candidates. Direct directory queries inspect the current directory; fuzzy root queries reuse the bounded index.

Each caller supplies an `AbortSignal`. Caller cancellation rejects only that wait, while invalidation aborts the shared index after a tool result so the next query observes new files. Agent disposal tears down both the index and the conditional prompt guidance.

When the effective Agent tool registry contains `read`, the Provider contributes stable guidance telling the model to call `read` before claiming file inspection. Without `read`, the guidance is absent.

## Model Experience

### File-reference guidance

#### What the model sees

When `read` is effective, the Provider adds one stable instruction telling the model to call `read` before claiming file inspection. Selected paths remain ordinary user text and no file contents are attached.

#### Token effect

The guidance consumes a small fixed prompt suffix. Candidate labels, directory listings, and file contents do not enter the request unless the model calls `read`.

#### KV Cache effect

The guidance is stable for an Agent tool capability set, so it preserves the reusable prompt prefix; a later `read` result changes only the request suffix.

## Known Limitations and Deferred Work

- **Local filesystem only** — remote or sandbox-specific discovery requires another `FileReferenceService` Provider.
- **Bounded index** — entries beyond `maxEntries` are not available to fuzzy root queries, while direct directory listings remain live and bounded by `maxResults`.

# @deepseek-ai/dsh-attachment-local

English | [中文](README.zh.md)

The private local implementation of [`@deepseek-ai/dsh-attachment`](../attachment). Objects land at `<DSH_HOME>/attachments/v1/objects/<sha256-prefix>/<sha256>` and are addressed by an opaque `sha256:` id. Each process proves a home durable once by syncing every ancestor entry to the filesystem root, so a directory another process created but has not yet synced is never mistaken for a safe boundary. Writes then use a private staging directory, owner-only files, a synced temporary file, an atomic exclusive hard-link publish, and directory syncs on the publication path (POSIX; Windows relies on filesystem metadata journaling) so the reported reference survives a crash. Write admission and reads fully decode the raster before accepting its format and dimensions; reads also re-check the digest and logged metadata. Byte and pixel limits are write-time admission policy, so a later policy reduction does not make already-admitted history unreadable.

`DSH_HOME` resolves through the shared path policy: explicit config, `$DSH_HOME`, then `~/.dsh`. Session logs contain only the reference and verified metadata, never this host path. `readImage` forwards optional cancellation into the filesystem read, observes it around verification, and preserves it instead of wrapping it as `ATTACHMENT_READ_FAILED`.

The local backend implements `readImageRequest` with deterministic provider-request bytes under `<DSH_HOME>/attachments/v1/request-images`. A request version is aspect-preserving, never enlarged, and bounded by the selected pixel and byte policy. PNG, JPEG, and WebP may pass through when already within policy; other cases use bounded JPEG or WebP encoding. Sidecar files are owner-only, published atomically, revalidated before reuse, and remain separate from durable attachment objects.

Generic files share the same object tree through the seam's file face: `saveFile` stores bytes verbatim under a `maxFileBytes` admission cap (default 100 MiB) with no format sniffing or normalization — the caller's declared media type is recorded as given — and `readFile` re-verifies the digest and byte length. `publishFileHandle` idempotently links a stored object into `<DSH_HOME>/attachments/v1/links/<sha8>-<leaf>` and marks the shared inode read-only (0o444): the handle path a model reads through keeps working even if the object tree is later reorganized, and re-publishing an existing link is a no-op. An unusable display name falls back to `<sha8>.bin`.

## Model Experience

Indirectly, through durable replay of historical user images and structured model image output after restart and fork. Generic files reach a model only as a deterministic handle text (name, byte count, sha256 prefix, read-only link path); the bytes themselves never enter a model request.

#### KV Cache effect

None beyond the image block owned by the requesting adapter.

## Known Limitations and Deferred Work

- Objects are retained indefinitely; reference-aware garbage collection is deferred.
- The local backend assumes the host and provider adapter share this filesystem service.
- Animated GIF metadata is validated from the logical screen; frame-level decoding policy is provider-owned.
- Generic-file media types are caller declarations recorded as given; the store does not verify them from bytes.

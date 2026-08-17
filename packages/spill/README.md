# spill/ — durable tool-result artifacts

English | [中文](README.zh.md)

This family stores complete oversized tool results outside the session log, keeps an opaque artifact reference beside the bounded model-facing result, and exposes paged retrieval through `artifact_read`.

| Package | Role | ctx key |
|---|---|---|
| [`spill/`](spill/README.md) | Defines artifact text save and paged-read operations | `ctx.spillStore` |
| [`spill-local/`](spill-local/README.md) | Provides durable host-filesystem storage and opaque local locators | registers on `ctx.spillStore` |
| [`tool-result-artifacts/`](tool-result-artifacts/README.md) | Owns finalized-result retention and cursor-based model retrieval | listens on `tools/finalize-result`; registers `artifact_read` |
| [`spill-policy/`](spill-policy/README.md) | Optionally applies a best-effort byte policy | listens on `ctx.tools` |

`dsh-tool-result-artifacts` owns the primary full-result path on `tools/finalize-result`. When finalized text exceeds its character limit, it saves the complete formatted text, places an `artifact_read` marker between retained head/tail text, and records `{ kind: 'full-result', locator, bytes }` beside the identical bounded `tool/result`; a retention failure produces a bounded error that warns the model not to retry a potentially side-effecting operation blindly. The optional `spill-policy` is a separate best-effort transformer and is disabled in the shipped base composition.

## Durability and lineage

The session log persists the bounded result and opaque locator, while the backend persists the complete text. Replay therefore reproduces the same model-visible preview and artifact reference; the local backend can resolve that reference after process or service restart when it uses the same root.

A fork inherits existing artifact references from its seeded log without copying or changing ownership of the stored text. New artifacts use the child session id, and neither session close nor runtime shutdown deletes artifacts.

## Model Experience

### Oversized full result

#### What the model sees

When the configured result limit can contain the marker, the model sees a bounded head/tail result containing `[Full result: artifact_read locator="<locator>" (<bytes> bytes)]`, then can pass the opaque locator and each returned cursor unchanged to `artifact_read`. The same limit truncates the marker itself when necessary; results within the runtime limit are unchanged.

#### Token effect

The complete result stays outside model history; each requested artifact page adds bounded text and optional continuation guidance until compaction.

#### KV Cache effect

Artifact markers and later pages are append-only and do not invalidate the existing reusable request prefix.

## Known Limitations and Deferred Work

- **No reachability collector or garbage collection exists** — artifacts can outlive every session reference and require external cleanup that understands the deployment's retention needs.
- **Durability depends on the selected backend** — replay and fork retain locators, but successful later reads require the corresponding backend data and configuration.

The subsystem types are documented in [docs/subsystems/spill.md](../../docs/subsystems/spill.md); rationale is in the [tool output spill Agent Note](../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md).

# @deepseek-ai/dsh-spill

English | [中文](README.zh.md)

The **`SpillStore`** (`ctx.spillStore`) defines backend-neutral operations to save complete tool-result text and read it in bounded pages through opaque locators and cursors.

This package is the Service Definition in a four-package capability whose roles can evolve independently:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-spill` (this) | Service Definition: abstract service and request/result types |
| `@deepseek-ai/dsh-spill-local` | Service Provider: durable private files on the host filesystem |
| `@deepseek-ai/dsh-tool-result-artifacts` | Consumer: finalized-result retention and model-facing sequential text retrieval |
| `@deepseek-ai/dsh-spill-policy` | Optional Consumer: best-effort result byte policy |

A remote or virtual backend can implement this Service Definition without changing result-artifact or policy Consumers.

## Service API (`ctx.spillStore`)

| Member | Semantics |
|---|---|
| `saveText(input)` | Persist `input.content` verbatim; resolve with an opaque locator and exact UTF-8 byte length; reject on storage failure. |
| `readText(input)` | Validate the backend-owned locator, optional cursor, and requested bound; return at most `maxChars` Unicode code points plus an opaque `nextCursor` when unread text remains; reject invalid or unreadable input. |

Storage is grouped by the request's `owner` session as a save-time namespace. The backend chooses its private representation and may derive names from `suggestedName`, but must never trust it as a path. Consumers pass locators and cursors unchanged: only the producing backend interprets and validates them, including rejecting another backend's locator, malformed cursors, and storage-specific integrity failures.

## Vocabulary

`SaveTextSpill` and `SpillRef` describe saves; `ReadTextSpill` and `ReadTextSpillPage` describe cursor-based reads. Both requests carry the caller-owned cancellation signal, which each backend observes through settlement. `SpillLocator` is [branded](../../util/brand) and model-facing only as an opaque string. `SpillOwner.sessionId` selects the save-time namespace: a fork inherits locators in its seeded log without copying or re-owning artifacts, while artifacts saved after the fork use the child session id. `SpillSource` is descriptive metadata for backend naming and inspection, not access control.

The session log can durably record a locator without embedding artifact bytes. Replay reproduces that reference, but later reads depend on the backend retaining its data; disposing a service, closing a session, or shutting down the runtime does not request deletion because `SpillStore` has no deletion operation.

See the [tool output spill Agent Note](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) for the design rationale, including why creation belongs to the runtime spill seam rather than the model-facing `write` tool.

## Model Experience

Indirectly, through `dsh-tool-result-artifacts`, which renders a bounded full-result marker and structured artifact reference and registers `artifact_read`; the service adds no schema itself.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **No deletion or reachability API exists** — the subsystem has no garbage collector and cannot determine when replay, forks, or external records have stopped referencing an artifact.
- **Storage is not access control** — `SpillOwner` namespaces writes but does not authorize reads of a locator; each backend and retrieval consumer must enforce its own boundary.

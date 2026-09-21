# @deepseek-ai/dsh-compaction-image-offload

English | [中文](README.zh.md)

Durable age-based image offload for the model-request projection. Mounts the `image/offload` message projection on the session store and settles one decision at every agent request boundary: when the configured `imageOffloadAfterUserTurns` later-user-turn age is reached for a retained request image, one `image/offload` event is appended and every later model request renders the canonical offload stub in that image's place.

## What it does

The plugin registers `imageOffloadProjection` — a session message projection over the durable `image/offload` event — under `ctx.sessions.registerMessageProjection`, then listens on `agent/request` and the generic `llm/project-request` waterfall. At each boundary it resolves the effective setting ([`compaction.imageOffloadAfterUserTurns`](../compaction-settings/README.md) when a settings provider is present, `'unlimited'` otherwise) and asks [`@deepseek-ai/dsh-image-offload-policy`](../image-offload-policy/README.md) for pending decisions against the complete log; each decision settles by appending one `image/offload` event whose `targets` are `{ messageSeq, imageIndex }` pairs. Provider budget callbacks use the same projection to settle exact omitted occurrences after age decisions and before serialization. The projection replaces exactly those image blocks with the policy's stub text block — one text block per image, in place — so block positions never shift and consecutive decisions compose. Originals are untouched in the log: replay, persistence, and display surfaces that read events directly keep showing the real images.

Mount the plugin after the session store and settings provider, before any session is created or restored. Session projection registrations are captured at session construction. The runtime uses the generic LLM request callback; adapters need no session-service dependency. Pressure coordinates are zero-based positions in the current attempt, and each fallback selection uses the preceding callback's returned projection.

## Setting semantics

`'unlimited'` (the default, also when no settings service is mounted) offloads nothing by age; provider pressure still settles durable occurrences. A positive integer `n` unloads each image once `n` later user-message turns exist at a request boundary. Age decisions are committed before provider pressure decisions, and an occurrence is settled only once. A stored value that is neither `'unlimited'` nor a positive integer fails loud at the boundary — the turn errors instead of guessing an age limit.

## Model Experience

### Offload stub in history

#### What the model sees

After a decision settles, later requests show the `image/offload` stub text block where the image used to be. The stub is truthful — it names the image as offloaded — and the surrounding text blocks, tool results, and block order are unchanged.

#### Token effect

Each settled image's token cost is replaced by the stub's short text cost; nothing else moves.

#### KV Cache effect

Stubs replace images in place without shifting any other block, so the request prefix up to the first settled image stays reusable; reuse invalidates only from the first replaced position, exactly like any other committed history edit.

## Known Limitations and Deferred Work

- **Compositions without this plugin derive originals** — the projection is registration-scoped; a session moved to a composition without the plugin derives the un-stubbed images again (the `image/offload` events remain durable and inert).
- **`0` is not `'unlimited'`** — an invalid stored value fails the turn loud rather than degrading to unlimited.
- **Windowed restore requires the historical event resolver** — restored sessions replay projection events across absolute history and apply targets to retained surface nodes; a backend that cannot resolve the referenced history cannot reconstruct those projections.
- **Display surfaces are unaffected** — UIs that fold events directly still render the original images; only the model-request projection changes.

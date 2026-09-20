# @deepseek-ai/dsh-compaction-image-offload

English | [中文](README.zh.md)

Durable age-based image offload for the model-request projection. Mounts the `image/offload` message projection on the session store and settles one decision at every agent request boundary: when the configured `imageOffloadAfterUserTurns` later-user-turn age is reached for a retained request image, one `image/offload` event is appended and every later model request renders the canonical offload stub in that image's place.

## What it does

The plugin registers `imageOffloadProjection` — a session message projection over the durable `image/offload` event — under `ctx.sessions.registerMessageProjection`, then listens on the `agent/request` waterfall. At each boundary it resolves the effective setting ([`compaction.imageOffloadAfterUserTurns`](../compaction-settings/README.md) when a settings provider is present, `'unlimited'` otherwise) and asks [`@deepseek-ai/dsh-image-offload-policy`](../image-offload-policy/README.md) for pending decisions against the live log; each decision settles by appending one `image/offload` event whose `targets` are `{ messageSeq, imageIndex }` pairs. The projection replaces exactly those image blocks with the policy's stub text block — one text block per image, in place — so block positions never shift and consecutive decisions compose. Originals are untouched in the log: replay, persistence, and display surfaces that read events directly keep showing the real images.

## Setting semantics

`'unlimited'` (the default, also when no settings service is mounted) offloads nothing by age; provider-side pressure handling stays per-request. A positive integer `n` unloads each image once `n` later user-message turns exist at a request boundary. A stored value that is neither `'unlimited'` nor a positive integer fails loud at the boundary — the turn errors instead of guessing an age limit.

## Model Experience

### Offload stub in history

#### What the model sees

After a decision settles, later requests show the stub text block where the image used to be. The stub is truthful — it names the image as offloaded — and the surrounding text blocks, tool results, and block order are unchanged.

#### Token effect

Each settled image's token cost is replaced by the stub's short text cost; nothing else moves.

#### KV Cache effect

Stubs replace images in place without shifting any other block, so the request prefix up to the first settled image stays reusable; reuse invalidates only from the first replaced position, exactly like any other committed history edit.

## Known Limitations and Deferred Work

- **No durable provider-pressure path** — decisions are age-based only. Provider-side budget pressure (for example the DeepSeek request image limit) keeps its per-request silent omission in the LLM adapter; no provider failure currently carries a durable pressure code to settle on.
- **Compositions without this plugin derive originals** — the projection is registration-scoped; a session moved to a composition without the plugin derives the un-stubbed images again (the `image/offload` events remain durable and inert).
- **`0` is not `'unlimited'`** — an invalid stored value fails the turn loud rather than degrading to unlimited.
- **Windowed restore tolerates pre-window targets** — a target whose source event fell outside the restored window produces no entry (no stub), by design.
- **Display surfaces are unaffected** — UIs that fold events directly still render the original images; only the model-request projection changes.

# @deepseek-ai/dsh-tool-compaction

English | [中文](README.zh.md)

Model-facing Consumer for `ctx.compaction`. It registers the direct `context_compact` tool so a model can condense one safe older conversation prefix before continuing with a new phase.

The base and standalone headless compositions load it beside the selected compaction Provider. Web moves it into the standard and Cordis Agent presets; the `code` preset omits it because PTC reaches native tools only through nested dispatch.

## Contract

The tool accepts one required non-empty `reason`, and optional `from`/`to` positions naming the span to compact: 1-based, counting from the oldest retained message, both required together. Omitting both keeps the policy-chosen span. The provider derives the calling Agent from protected execution identity, applies the routed model's retention policy, preserves tool-call/result pairing, and forwards cancellation to summarization. Explicit spans must end before the current turn; boundaries snap outward-in to keep tool calls paired (the result reports how many positions snapped), and the resolved span runs through the programmatic `compactRegion()` transaction with `agent-request` ownership. The result text reports the compacted item count, shadowed tokens, and the retained context's estimated size so the model can judge follow-up calls. The reason records why detailed older context is no longer needed, but it does not select a range or supply summary text. The Provider derives the calling Agent from protected execution identity, applies the routed model's retention policy, preserves tool-call/result pairing, and forwards cancellation to summarization.

Calls without an active Agent and calls nested inside another tool fail before the backend runs. The tool is exclusive, so it cannot overlap sibling calls that could mutate the same Session surface.

## Composition

Mount one compaction Provider before this Consumer:

```yaml
- name: '@deepseek-ai/dsh-compaction-lossless'
- name: '@deepseek-ai/dsh-tool-compaction'
```

## Model Experience

### `context_compact`

#### What the model sees

The [generated schema](../../../docs/tool-catalog.md#context_compact) exposes only `reason`. A successful call reports the number of replaced history items and their estimated tokens without repeating the private summary. A short history returns `No compactable older history is available yet.` without opening a compaction transaction.

#### Token effect

The schema contributes fixed request tokens. A call appends its reason and a short result; successful backend execution replaces a larger older prefix with one summary checkpoint while retaining the recent tail.

#### KV Cache effect

Tool discovery is stable while composition is unchanged. A no-op only appends the ordinary call/result tail. Successful replacement invalidates reuse from the first shadowed history token, while the unchanged prefix before that range remains reusable.

## Known Limitations and Deferred Work

- **Direct calls only** — nested and PTC sub-dispatches fail; the `code` preset omits this Consumer.
- **No range controls** — the model cannot choose event boundaries or provide summary text; Provider policy owns both selection and summarization.
- **Routed capacity required** — retained-tail policy needs context metadata for the latest durable provider/model route.

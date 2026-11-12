---
description: "Conversation view showing per-turn and per-step context tokens, cache counts and hit rate, first-token latency, model versus tool time, decode speed, and retry/error tallies."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-stats

English | [中文](README.zh.md)

## Summary

Adds a Statistics tab beside Chat and Trajectory. The totals header carries loaded-window figures (turns, steps, model and tool time, average TTFT, aggregate decode speed, output tokens, cache hit); turn rows expand into steps with context tokens, cache read·write with hit rate, TTFT, model and decode time, tokens per second, tool accounting with per-name pills, retries, and errors. The Trigger column names what opened the turn — a user prompt (with file and image counts), or a plugin injection with its producer and notice summary — and a step-less turn still shows its close reason. Compactions appear as rows: numbered ones inside their owning turn, standalone ones between turns, with provider, model, token figures, shadowed size, duration, and error. Scrolling back loads earlier turns through shared Session paging. The tab reads Session events only; it registers no tool, prompt section, or service. Cost and billing figures are deliberately absent — the view shows measured facts alone.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it in a client composition that already provides `slots`, `sessions`, `locale`, and the conversation registries. It contributes one entry to the `conversation.view` slot; no configuration fields exist.

### When to choose it

Choose it to compare turns or steps by context size, cache reuse, and where wall time went. Choose `@deepseek-ai/dsh-client-ui-trajectory` for the full event ledger with request headers and interactive timing; the two panels read the same Session and can be enabled together.

### Minimal configuration

```yaml
- id: ui-stats
  name: '@deepseek-ai/dsh-client-ui-stats'
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Four Conversation Definitions fold the event window into nodes for one view target named `stats`. `stats-step` owns one Context per `step/start` and folds stream chunks (first token), the assembled message (usage, interruption, answer preview), tool call/result pairs by callId, and `llm/retry` counts; tool wall time unions settled call intervals so parallel calls do not double-count. `stats-prompt` owns one Context per `user/message`, deriving trigger facts (source kind, producer, declared form, notice summary, preview, file/image counts) with turn attribution from the engine-resolved Location. `stats-turn-end` records the close marker so interrupted tails and close reasons render. `stats-compaction` folds one transaction (`compaction/start` → `summary` → `end`) with provider, model, usage, shadowed tokens, duration, and error.

| File | Responsibility |
| --- | --- |
| `src/client/stats-step-definition.ts` | The step fold: timing, usage, tool pairing, retries |
| `src/client/stats-prompt-definition.ts` | Trigger facts of waking user messages |
| `src/client/stats-turn-end-definition.ts` | Turn close markers |
| `src/client/stats-compaction-definition.ts` | Compaction transaction state |
| `src/client/stats-aggregate.ts` | Turn grouping, row ordering, window totals |
| `src/client/stats-snapshot-builder.ts` | The `stats` view target and keyed builder |
| `src/client/stats-format.ts` | Deterministic count/duration/speed formatting |
| `src/client/StatsView.tsx` | Totals header, turn table, step expansion |

Token counts are disjoint: `inputTokens` excludes cached input, so context = input + cacheRead + cacheWrite and the hit rate divides cacheRead by cacheRead + input, matching the provider usage contract.

</details>

## Further Exploration

- `docs/cookbook/adding-a-conversation-node.md` — the Conversation Node discipline these Definitions follow.
- `packages/session/session-stats` (upstream) — the whole-log projection pattern; this view keeps totals scoped to the loaded window instead.

## Model Experience

None, as the statistics view renders session data in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Totals cover the loaded window, not the whole log** — figures derive from the paged-in event window; a whole-log projection (upstream `dsh-session-stats` pattern) would need a host-side fold.
- **PTC inner dispatches fold into their parent call** — `tool/code-dispatch` inner calls are not attributed separately; their time sits inside the parent `tool/call` pair's wall interval and their output inside the parent result.
- **No per-call accordion** — step rows show per-name tool pills and open-call counts; per-call detail rows stay in the Trajectory inspector.

## Dev Note

Absorbed from the official `dsh-experimental-client-ui-stats` line (wave-6 row 8): the per-step facts view is ruled outside the standing no-metering default, while billing and cost accounting remain banned. Trigger vocabulary follows this codebase's message sources (user prompt, plugin injection with declared form) — the official team-message sender column has no counterpart here.

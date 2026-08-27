# @deepseek-ai/dsh-compaction-lossless

English | [中文](README.zh.md)

Lossless-style automatic compaction for Harniverse. The plugin reuses the existing `CompactionEngine` transaction and projects each committed summary checkpoint into a session-local summary DAG. Raw Session events remain canonical; summary nodes are a derived index with bounded expansion. The [summary DAG Agent Note](../../../.agents/notes/implemented/feature/2026-08-18-summary-dag-compaction-history.md) records the design.

## Composition

The plugin combines two host-side roles:

- `CompactionHistory` registers `ctx.compactionHistory` and rebuilds summary nodes from the current Session event log.
- `LosslessCompactionEngine` registers `ctx.compaction` and inherits the Basic provider's token pressure, overflow recovery, tool-pairing checks, cancellation, durable bracket, and surface replacement.

Load this provider instead of `@deepseek-ai/dsh-compaction-basic`. Both providers register `ctx.compaction` and cannot be active in one context.

The shipped base, standard, code, Cordis, and standalone headless compositions select this provider and load `@deepseek-ai/dsh-tool-compaction-history`. Base, standard, Cordis, and headless also load the direct-only `@deepseek-ai/dsh-tool-compaction`; a custom composition can select `compaction-basic` instead or omit either Consumer.

```yaml
- name: '@deepseek-ai/dsh-compaction-lossless'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    maxSearchResults: 20
    maxExpansionDepth: 3
    maxExpansionTokens: 4000
```

`auto` defaults to `true`, so qualifying step pressure and canonical context overflow trigger automatic compaction. The inherited `thresholdRatio`, `retainRatio`/`retainTokens`, summarizer target, retry, overflow, and exact `modelPolicies` settings remain available.

## Summary DAG

Each `compaction/summary` becomes visible in the index only when its matching replacement checkpoint commits. A node is `leaf` when it replaces raw surface messages and `condensed` when its shadowed surface contains earlier summary checkpoints. Parent links are derived from cited checkpoint events; each node separately retains raw message seqs introduced in its own replacement, so expansion recovers both parent history and newer messages.

The index is rebuilt from `Session.events` after resume or HMR. It is therefore durable through the canonical Session persistence backends without maintaining a second raw transcript database.

## Configuration

| Key | Default | Meaning |
|---|---:|---|
| `thresholdRatio` | `0.8` | Fraction of the routed model context window that triggers automatic compaction. |
| `retainRatio` | `0.16` | Recent surface budget retained verbatim; mutually exclusive with `retainTokens`. |
| `retainTokens` | unset | Absolute recent surface budget retained verbatim. |
| `summarizationProvider` / `summarizationModel` | empty | Optional summary route; otherwise the routed conversation target is used. |
| `maxTokens` | `8192` | Upper bound for summary generation; the selected model cap and remaining context window can reduce it. |
| `compactionRetries` | `1` | Additional pressure compaction attempts. |
| `maxOverflowRetries` | `1` | Context-overflow recovery retry cap. |
| `modelPolicies` | `[]` | Exact provider/model policy overrides. |
| `auto` | `true` | Enable automatic pressure and overflow compaction. |
| `maxSearchResults` | `20` | Maximum summary hits returned by the history consumer. |
| `maxExpansionDepth` | `3` | Maximum DAG levels returned by expansion. |
| `maxExpansionTokens` | `4000` | Maximum estimated expansion tokens. |

## Model Experience

### Automatic conversation compaction

#### What the model sees

The model receives one `compaction/summary` checkpoint and the retained fresh surface. DAG metadata and raw source messages remain outside the prompt until a Consumer retrieves them.

#### Token effect

Automatic compaction replaces older surface nodes with one smaller checkpoint. The DAG projection itself contributes no request tokens.

#### KV Cache effect

Surface replacement invalidates provider cache reuse from the first replaced history node. Rebuilding or querying the in-memory DAG does not change the request prefix.

## Known Limitations and Deferred Work

- **Provider selection is exclusive** — the plugin cannot coexist with `compaction-basic` because both implement `ctx.compaction`; compositions select one provider.
- **The current index is live-session scoped** — persisted sessions are indexed when loaded into `ctx.sessions`; cross-session historical search remains the responsibility of `dsh-session-query`.
- **Summary content is model-generated** — the raw event log and source event sequence references remain lossless, but a summary can omit details; load the history Consumer for bounded source recovery.
- **Search is an in-memory term scan** — it is intentionally small and dependency-free for the first provider. A persistent FTS projection can replace the scan without changing the service contract.

# @deepseek-ai/dsh-context-reset

English | [中文](README.zh.md)

Whole-surface context-reset service (`ctx.contextReset`). A reset shadows every current surface node with one durable checkpoint marker, so the next model request starts from a fresh context while the retained log stays append-only and searchable. The plugin owns the `reset/checkpoint` log-only anchor event and the replacement `user/message` marker; the surface fold in [`dsh-session`](../../core/session/README.md) validates both at append and replay. The [context reset Agent Note](../../../.agents/notes/implemented/feature/2026-09-08-context-reset.md) owns the boundary and display decisions.

## Service contract

| Call | Result |
|---|---|
| `resetNow(agent, signal)` | Wait out a running agent, claim the idle maintenance phase, append one `reset/checkpoint` anchor plus one whole-surface replacement marker, flush, and return the shadowed seqs. |
| `resetNow` on an empty surface | `null` — nothing is appended or flushed. |
| `resetNow(agent, signal, sourceCommandId)` | Correlate the marker's provenance with the initiating manual command. |

The transaction is one atomic pair of appends; no lock bracket is needed. `sourceEventSeqs` cites the anchor seq first (the display checkpoint's cut, the `compaction/start` shape) and then every shadowed surface node densely. Expected failures are classified as `ContextResetError`:

| Code | Meaning |
|---|---|
| `busy` | The agent had active work when the idle maintenance claim was attempted. |
| `cancelled` | The agent-side maintenance signal aborted the operation. |
| `commit` | The marker append was rejected by the surface fold; the conversation is unchanged. |
| `persistence` | The marker landed but the durability flush failed. |

Aborted requests preserve their exact abort reason. The operation is held on the owning context's lifecycle, so teardown drains an in-flight reset before disposal settles.

## Composition

```yaml
- id: context-reset
  name: '@deepseek-ai/dsh-context-reset'
```

The shipped `dsh` base mounts it beside the command adapter. Consumers resolve it through `ctx.contextReset`; the cordis-free `./checkpoint` leaf (`resetCheckpointSource`, `isResetCheckpointSource`, `resetCheckpointContent`) names the marker for client and wire programs without the host Context merge.

## Model Experience

### Fresh context on demand

#### What the model sees

One `user/message` marker with verbatim text: prior history was removed from its context, the log stays searchable, and the conversation continues from the messages that follow. The durable pair is the `reset/checkpoint` anchor plus the `surfaceOp: {op: 'replace'}` marker. The retained runtime-context snapshot is shadowed with the surface, so the next step republishes a complete snapshot through the ordinary context-snapshot state machine.

#### Token effect

Later requests carry only post-reset surface messages plus the one marker; every earlier token leaves the request regardless of automatic pressure.

#### KV Cache effect

The whole-surface replacement invalidates reuse from the first shadowed history token.

## Known Limitations and Deferred Work

- **Idle-only** — a reset claims the idle maintenance phase; a running agent is waited out, not interrupted.
- **Whole surface only** — partial resets stay the compaction seam's territory; this service never selects a range.
- **No snapshot carry-over** — reset does not emit its own summary; a fresh context is the point.

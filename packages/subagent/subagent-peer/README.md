# @deepseek-ai/dsh-subagent-peer

English | [中文](README.zh.md)

The peer provider runs each subagent as a fresh delegated session on one paired Harniverse instance over the instance-pairing channel. It is the pairing-channel alternative to the ACP backend: the child lives in another deployment with its own model, tools, sessions, and governance, and the only thing that crosses the boundary is the delegation prompt and its settled reply.

## Start and ownership

`start(request)` validates the prompt (text blocks only, non-empty, within the host's prompt bound), resolves the configured paired target, then performs the single `peer/delegate` Remote call — it both submits the prompt and awaits its first settlement — before it fulfills. Fulfillment therefore means the remote turn has settled (or outlived its budget): the returned run's `result` is already terminal, `dispose()` has no remaining local work, and a transport or pre-publication cancellation failure rejects only `start`.

The returned run id IS the peer session id. Unlike ACP's child-process-scoped session ids, a peer session id is unique across the pairing and stays continuable: the parent model can pass it as the `peer` tool's `session` argument with the same target. Continuation through the subagent seam itself is rejected — this provider has no `prepareContinuable` capability, so the ordinary continuable invocation path fails loud; mount the tool row with `backgroundMode: 'one-shot'`, exactly like the ACP backend.

A turn still running past the settlement budget resolves with `stopReason: 'error'` and a diagnostic naming the peer session for continuation. Local cancellation cannot reach another deployment's in-flight work: a pre-publication abort rejects `start` while the abandoned remote turn keeps running and consumes its own budget.

## Capabilities and context

The provider advertises no start-time capabilities (`outputSchema`, `maxDepth`, `toolFilter`, `persona` all `false`): this deployment cannot enforce anything about another deployment's composition, so the service rejects a request needing any of them before a wire call. It reports `inheritsParentContext: false`: the remote session starts fresh, and nothing parent-derived crosses the pairing channel — not even a working directory, because the remote workspace belongs to the remote's own configuration.

Every delegated turn consumes the pairing's own governance: the accepting side's surface gates, turn budget, and (for artifact traffic) byte budget apply unchanged, and refusals arrive as closed peer reasons (`BUDGET_EXCEEDED`, `SURFACE_NARROWED`, …) flattened into the start rejection.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `providerName` | `peer` | Registry name on `ctx.subagents`. |
| `peerTarget` | required | The paired instance every run delegates to: its exact instance id or exact display name in this home's pairing-target store. Resolved per run, so a target paired after boot is picked up without a reload. |
| `dshHome` | resolved home | Harness home holding the pairing target store and the signing identity. |
| `settleTimeoutMs` | `120000` | Settlement budget per delegated turn; clamped into `[1000, 900000]` (the accepting host's ceiling). |

```yaml
- id: subagent-peer
  name: '@deepseek-ai/dsh-subagent-peer'
  config:
    providerName: peer
    peerTarget: build-workstation
    dshHome: !!js process.env.DSH_HOME

- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: peer
    toolName: subagent
    maxDepth: 'provider-managed'
    backgroundMode: 'one-shot'
```

## Stop-reason mapping

| Peer `endReason` | Harness |
|---|---|
| `completed` (or absent on a settled turn) | `completed` |
| `refusal` | `refusal` |
| `max-tokens` | `max-tokens` |
| `aborted` | `aborted` |
| `error` or unknown | `error` (unknown reasons carry the raw value as diagnostic) |
| turn still `running` at the budget | `error` with a continuation diagnostic naming the peer session |

## Model experience

The parent model calls the ordinary `subagent` tool; the peer transport is invisible. The result renders the remote reply as the child's final output and publishes the peer session id. Token cost on the parent is the prompt plus the settled reply — the remote's own tool traffic never enters the parent's context. Delivering or fetching files stays on the `peer` tool (`attachFiles`/`fetchFiles`): the subagent tool's prompt is text-only, and remote-produced artifacts are addressed through the read-only handle blocks the remote's reply already names.

## Known Limitations and Deferred Work

- One-shot only: no continuable Activation epochs through the subagent seam — the continuation manager materializes local child sessions, which a remote deployment cannot host. Continuation stays on the `peer` tool with the published peer session id.
- No cancellation propagation: local disposal abandons the wait only; the remote turn runs to completion and consumes its own budget. A remote-abort Remote would need its own wire decision.
- Text-only prompts: the delegation wire carries text; image or other content blocks reject before any wire call.
- No artifact bridging: files cross the pairing through the `peer` tool's upload/download facilities, not through this provider.

## Process boundary

The wire driver is [`dsh-peer-client`](../../peer/peer-client/README.md): Grant-backed transport, request proofs, and target selection all live there, and the target store (`peer-targets.json`) stays owned by the initiating home. The pairing channel is the real trust boundary — identity keys, surface gates, and budget enforcement on the accepting side — and same-process subagent values are not defensively cloned.

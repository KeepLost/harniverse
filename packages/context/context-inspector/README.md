# @deepseek-ai/dsh-context-inspector

English | [中文](README.zh.md)

Read-only audit manifest of an agent's next model request surface. The service reuses the exact assembly primitives the agent loop does — `systemPrompt.assemble` + `renderPrompt`, the session surface fold (`deriveMessages`' per-node derivation), and the shared token meter — so its output is a projection of the real request, not a reimplementation. Its companion test pins the strongest form of that claim: a manifest captured in the same step as an outgoing request equals that request's system text and ordered messages.

## Contract

`ctx.contextInspector.manifest(agent, signal?)` returns:

- ordered `segments` — one system segment (rendered prompt) plus one per surface node in conversation order, each carrying role/kind, a 160-character text preview, an estimated token count, the deriving log `seq`, and (for summary checkpoints) the `shadowedSeqs` the checkpoint replaced — the log-correlation handle for auditing compaction impact;
- `tools` — names the next request discovers;
- `totalTokens` — the meter's estimate for the assembled surface.

The call mutates nothing and wakes nobody; it is safe on idle and running agents alike.

## Composition

```yaml
- name: '@deepseek-ai/dsh-context-inspector'
```

The base composition mounts it. Presentation consumers (Web audit drawer, CLI dump) ride the same service and remain follow-up work.

## Model Experience

### Audit manifest

#### What the model sees

Nothing. The inspector is host-side and read-only; no session event, prompt section, or tool is introduced. The manifest it produces corresponds one-to-one with the `system` + `messages` a real `llm.stream` call carries.

#### Token effect

None at request time. Building a manifest costs one assembly and one measurement pass.

#### KV Cache effect

None; no request input changes.

## Known Limitations and Deferred Work

- **No presentation consumers yet** — the service landed with its equivalence test; the Web audit drawer and CLI dump are the next train.
- **Preview truncation** — segments carry a bounded preview; full fidelity stays in the session log the seqs point at.
- **Idle projection** — the manifest describes the *next* request surface; an in-flight request's exact envelope is observable at its own boundary.

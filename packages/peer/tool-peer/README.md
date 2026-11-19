# @deepseek-ai/dsh-tool-peer

English | [中文](README.zh.md)

The model-facing `peer` tool: run one prompt on a paired Harniverse instance and return the settled reply, or continue an existing delegated session. It owns the model-facing schema, target resolution, budgeting, and result rendering; every protocol concern — request proofs, Grant transport, direct or SSH dialing — lives in [`@deepseek-ai/dsh-peer-client`](../peer-client/README.md), so the pairing channel hardens without touching what the model sees.

## Tool surface

Registers one tool (name configurable, default `peer`) plus a usage-policy prompt section restricting it to user-named paired instances. Arguments: `target` (display name or exact instance id; an id wins over an ambiguous name), `prompt` (at most 32768 characters, matching the accepting host's bound), optional `session` (an existing delegated session id to continue), and optional `timeoutMs` (settlement budget, default 120000, clamped into 1000–900000).

A call resolves the target from `peer-targets.json` under the configured home, signs a timestamp-windowed request proof, and delivers the prompt through `peer/delegate` (fresh session) or `peer/followup` (continuation). The structured output carries `sessionId`, `state`, and the settled `reply`; the rendered text always names the session id so the model can continue the conversation. A turn still running past the budget returns `state: 'running'` with continuation guidance instead of blocking the turn. A settled turn whose end reason is not `completed`, and every closed peer reason (`SESSION_NOT_FOUND`, `TRANSPORT_FAILED`, …), become tool errors naming the reason. Oversized replies truncate at the configured ceiling (default 50000 characters) with a notice.

## Configuration

None beyond the tool row: `toolName`, `dshHome`, `defaultTimeoutMs`, and `maxResultChars` are ordinary plugin `Config` entries validated by the Loader. Reachability of paired targets is the pairing boundary itself — the tool dials exactly the targets the home's owner paired, and the accepting instance's surface fields still gate what each peer may do there.

## Events

None; the tool registers no Session events of its own. Delegated turns live in the accepting instance's session corpus with `origin: 'peer'`.

## Verification

`tests/peer-tool.spec.ts` covers the target-resolution matrix (id precedence, ambiguous and unknown names, inactive records), budget clamping at both bounds, the running/settled/error renderings, truncation, schema-level argument validation, and fiber disposal. `tests/loader-composition.spec.ts` boots the plugin through the real Loader against a scripted pairing target and asserts the model-visible result text. Assembled behavior is pinned by the ACP snapshot scenarios through [the acp-agent example](../../../examples/acp-agent/README.md), whose composition includes this tool.

## Model Experience

### Delegating to a paired instance

#### What the model sees

One `peer` tool with `target`, `prompt`, and optional `session`/`timeoutMs` parameters; the result names the delegated `sessionId` and carries the peer instance's reply text verbatim (truncated past the ceiling). A turn still running past the budget reports `running` with continuation guidance; when the deployment composes [`@deepseek-ai/dsh-peer-outbox`](../peer-outbox/README.md), the turn is also tracked there and its settled reply later arrives as one queued user message in the calling session, so the model can keep working and address it when it lands.

#### Token effect

The tool description and parameters are part of the tool catalog on the initiating side; each call's prompt and reply enter the local log once, as one tool call. The prompt itself is delivered to — and accounted in — the delegated session on the accepting instance, not duplicated into any local session.

#### KV Cache effect

A `peer` call never extends or evokes a local cache prefix on the accepting instance: the delegated session carries its own prefix there. On the initiating side the tool call is an ordinary tool row in the local conversation.

## Known Limitations and Deferred Work

- Without the outbox service in the composition, settlement stays synchronous within the budget and a running turn returns manual re-check guidance; the ledger never queues prompts, and a target unreachable during settlement fails the watch after one immediate re-probe.
- An aborted parent step does not cancel an in-flight peer call; the per-call transport timeout bounds the wait, and live-channel cancellation is deferred with the sessioned channel.

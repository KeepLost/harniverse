# Agent Note: A version-neutral ACP client core and the step-driver seam behind ACP mode

Status: implemented

English | [中文](2026-11-27-acp-client-core-and-acp-mode.zh.md)

> Revised the same day by [ACP sign-in on demand, a durable external-session binding, and what the agent reports](../feature/2026-11-27-acp-sign-in-session-binding-and-agent-state.md): the client completes sign-in when the agent first demands it, and ACP mode records the external session and reattaches to it on reopen. Where this note says otherwise, it describes the first release.

## Problem

Harniverse could speak the Agent Client Protocol only as a server that automation clients drive, and as a one-shot subagent backend whose protocol code was fused into the subagent contract. Both sat on SDK 0.25.1. Nothing let a person open a session whose main agent is an external one — Claude Code, Codex, Gemini CLI, Antigravity — with Harniverse as the frontend, and the subagent backend could not be reused for that: its process, handshake, permission policy, and teardown lived beside the `SubagentResult` mapping in one module.

The agent factory made it worse: it constructed one concrete driver class, whose lifecycle shell and whose model turn were the same object, so a second way of running a turn had no seam to attach to without a second copy of the shell or a special case in the factory.

## Decision

The protocol moves into one library, and "what happens inside a step" becomes a registered contribution.

[`@deepseek-ai/dsh-acp-client`](../../../../packages/acp/acp-client/README.md) owns the client side of ACP for every consumer: the agent definition, the stdio transport over the subprocess seam, the handshake, authentication, sessions, turn routing, permission answering, and the teardown ladder. Its API is version-neutral. One `AcpUpdate` vocabulary covers protocol v1 and v2, which differ only in a small `ProtocolShape`; v1 reports turn completion through the prompt response and therefore has its `running` and `idle` states synthesized, so a consumer cannot tell the versions apart. A consumer supplies the spawn function, the permission answerer, and the working directory, and owns every durable event it derives. [`@deepseek-ai/dsh-subagent-acp`](../../../../packages/subagent/subagent-acp/README.md) is now a thin consumer of it, with its behavior and tests unchanged.

The library speaks JSON-RPC itself over the SDK's ndJSON framing. The SDK's own client app validates every `session/update` against its schema and drops a variant it does not know, which would silently lose whatever a newer agent reports; the core reads every update with its own forward-compatible parser instead, so an unknown variant passes through as `other` and never throws.

The driver seam splits the agent machine from the step. [`@deepseek-ai/dsh-agent`](../../../../packages/core/agent/README.md)'s `AgentMachine` owns what every driver shares — the inbox, the phase machine, cancellation, maintenance, and the turn scaffolding that claims input, asks `agent/pre-step`, appends the entered messages, and closes each step and turn. A `StepDriver` owns one step: `prepare` between the claim and the pre-step decision, `run` for the admitted step. The factory constructs the machine and seals the driver its scope chain contributes, once, before publication; `ctx.agents.registerDriver()` is effect-scoped and scope-layered, so a preset row contributes a driver the same way it contributes a tool. [`@deepseek-ai/dsh-agent-loop`](../../../../packages/core/agent-loop/README.md) keeps the lifecycle owner and supplies the default driver, the model loop, whose step code moved without change. No other package changed behavior.

[`@deepseek-ai/dsh-agent-acp`](../../../../packages/acp/agent-acp/README.md) is the second driver: one step is one segment of an external agent's turn. The segment rule comes from the session log's own contract and from the conversation view: one `assistant/message` per step, every `tool/result` in the step of its `tool/call`. Speech that follows a tool call opens the next step and waits for the pending calls to report. The preset is a template a person copies, not a shipped roster entry: an external agent is something a person installs, and the shipped roster is what the settings and picker snapshots enumerate.

## Alternatives considered

**Keep the protocol in `subagent-acp` and import it from the ACP driver.** The subagent contract (`SubagentRun`, the stop-reason flattening, the `onError` sink) would then be the API a session driver depends on, and the driver would own a second copy of the turn it needs. The library keeps the subagent package a consumer and makes the process, handshake, and teardown one implementation.

**Let the driver replace the model stream through `llm/stream` or `agent/request`.** The model loop would still execute the tool calls the external agent already executed, through tools it never registered, and the permission requests arrive mid-turn from outside the tools pipeline. The seam belongs below the turn, not inside its request.

**A second `Agent` implementation for ACP mode.** The shell the model loop runs — wake latching, cancel convergence, maintenance, disposal quiescence — is intricate and heavily tested; a second copy would drift. The machine is extracted once and both drivers run on it.

**Compose the whole turn through a `TurnDriver` and leave the model loop's turn intact.** The ACP driver would then duplicate the turn scaffolding (claim, pre-step, entered messages, recovery of pending tool results) as a clone. Splitting at the step keeps the scaffolding in one place.

**The SDK's client app for the wire.** It drops update variants outside its schema, so a newer agent's output would be lost silently; it also offers no way to read `session/update` raw. The JSON-RPC peer is small and fully under this repository's tests.

**Ship the ACP preset in the roster.** It would advertise a mode that fails for anyone without an external agent installed, and it would change the settings and picker snapshots. The template keeps the mode an explicit opt-in.

## Consequences

Any conforming ACP agent is one definition away, on v1 or v2, with one teardown and one permission path; a new consumer of the protocol writes no protocol code. The step seam is general: another engine is a registered driver and a preset row, not a factory change.

The cost is a wider `dsh-agent` surface (the machine and the registry) and one SDK version split: the automation server and its snapshot kit stay on 0.25.1 until they are ported to the SDK's 2.x agent app, which is a separate change. ACP mode forwards only person-written text, drops the agent's non-text output, and does not resume the external session across a restart; each is listed in the owning README.

Required verification: the client core's tests cover every branch against a scripted in-memory agent and a real-process teardown ladder; the machine and registry are covered in `dsh-agent`'s suite and by the unchanged `dsh-agent-loop` suite; the ACP driver is covered through the real factory against a scripted agent in a real child process; and a Loader smoke boots a copied preset template end to end.

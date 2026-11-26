# @deepseek-ai/dsh-acp-client

English | [中文](README.zh.md)

The version-neutral Agent Client Protocol (ACP) client core. Any conforming agent is one `AcpAgentDefinition`; `connectAcpAgent` starts it over the [`dsh-subprocess`](../../subprocess/subprocess/README.md) seam, negotiates the protocol, completes its authentication, and returns a connection whose sessions stream normalized updates. The library owns the protocol and the process; a consumer owns what it derives from the facts it receives: [`subagent/subagent-acp`](../../subagent/subagent-acp/README.md) collects one answer, and [`acp/agent-acp`](../agent-acp/README.md) writes a session log.

## Connect

```text
const connection = await connectAcpAgent({
  definition: { command: 'agent', args: ['acp'], env: {}, protocol: 1 },
  cwd: '/absolute/workspace',
  spawn: spec => ctx.subprocess.spawn(spec),
  permission: policyAnswerer('reject'),
  signal,
})
```

`connectAcpAgent` spawns the agent, sends `initialize`, completes the authentication the agent still needs, and resolves with the live connection. Every failure, a cancelled setup included, rejects with an `AcpError` after the process it started is reaped; `AcpError.kind` names where the failure originated (`spawn`, `handshake`, `auth`, `unsupported`, `protocol`, or `transport`).

| `AcpConnectOptions` | Default | Meaning |
|---|---|---|
| `definition` | required | The agent: `command`, `args`, explicit `env`, the requested `protocol`, and an optional pinned `profile`. |
| `cwd` | required | Absolute working directory of the process and of every session it opens. |
| `spawn` | required | The subprocess seam's spawn function; the agent rides the seam's credential scrub and tree-scoped teardown. |
| `permission` | decline every request | The answerer for the agent's permission requests. |
| `profiles` | none | Agent profiles, in precedence order. |
| `clientInfo` | `harniverse` 1.0.0 | The identity this client reports at the handshake. |
| `disposeEofGraceMs` | `6000` | Window after stdin EOF before the teardown escalates. |
| `disposeGraceMs` | `3000` | POSIX grace between SIGTERM and SIGKILL; Windows force-terminates directly. |
| `signal` | none | Cancels the handshake, the authentication, or the v2-to-v1 fallback. |

The client advertises no optional client capability: it provides no filesystem, terminal, or elicitation to the agent, so the agent self-serves in its own process. A request for such a capability is answered with `Method not found`.

## Protocol versions

`definition.protocol` selects the version the handshake requests. `1`, the default, speaks the stable protocol. `2` requests the Preview protocol and starts a fresh v1 child when the agent answers that it speaks v1 only. An agent that speaks neither version fails the handshake. Both versions map onto the same updates; v1 reports the end of a turn through the `session/prompt` response, so the v1 binding synthesizes the `running` and `idle` states that a v2 agent reports itself.

## Sessions and turns

A connection hosts any number of sessions. `newSession()` opens one in the connection's working directory; `resumeSession()`, `listSessions()`, and `closeSession()` are available only when the agent advertised them and otherwise reject with an `AcpError` of kind `unsupported`. A v2 agent owes all three without advertising them.

`session.prompt(blocks, { signal })` starts one turn and returns its `updates` and its `end`. A session runs one turn at a time: a second prompt while a turn is active rejects. Aborting `signal` ends the turn on this client's side at once, as `cancelled`, and sends `session/cancel`; the next prompt waits until the agent is quiet, so a cancelled turn's late updates never reach the one that follows. When the agent process exits, the active turn rejects with a transport error and later work refuses.

## Updates

Every `session/update` arrives as one `AcpUpdate`, in arrival order. A variant this client does not interpret, or a known variant whose fields do not match its contract, arrives as `other` and is never thrown.

| `kind` | Carries |
|---|---|
| `message-chunk`, `thought-chunk` | One streamed content block. |
| `message`, `thought` | A whole-message upsert (v2). |
| `tool-call` | A patch on one tool call: an absent field leaves it unchanged, `null` clears it. |
| `plan` | The agent's plan entries. |
| `usage` | Context-window accounting the agent reported. |
| `session-info` | The session title and update time the agent reported. |
| `notice` | A notice for the person. |
| `state` | Foreground work `running`, `idle`, `requires_action`, or `unknown`, with the stop reason once idle. |
| `other` | Any other variant, passed through. |

## Permission requests

The agent's `session/request_permission` reaches the connection's answerer as one `AcpPermissionRequest` with the agent's options; the answer selects one option or withholds consent. An answerer that throws withholds consent. `policyAnswerer('allow' | 'reject')` supplies the two fixed policies; a connection named without an answerer declines every request.

## Agent profiles

Agent-specific behavior is a profile: an id, the `agentInfo.name` values it applies to, and at most one request rewrite. `connectAcpAgent` pins the profile `definition.profile` names before the handshake, or selects the first supplied profile whose `agents` lists the name the agent reported. Without a profile the protocol path consults none.

## Teardown

`dispose()` ends every active turn with a transport error, closes the connection, and runs the teardown ladder over the seam's public verbs: stdin EOF, the EOF grace, then `terminate()` (SIGTERM, the spawn grace, SIGKILL) and the subprocess owner's whole-tree exit proof. It is idempotent. `disposeAcpChild(child, eofGraceMs)` is the same ladder for a handle a consumer spawned itself.

## Model Experience

Indirectly, through the consumers that derive model-visible facts from normalized updates: [`acp/agent-acp`](../agent-acp/README.md) writes an external agent's output as session events, and [`subagent/subagent-acp`](../../subagent/subagent-acp/README.md) returns one answer to a tool result.

#### KV Cache effect

This library registers no harness model context. It decides only what crosses the wire to an external agent; the consumer that builds the prompt owns every token and its reuse.

## Known Limitations and Deferred Work

- **Prompts are text** — `AcpPromptBlock` carries `text` only; image, audio, and embedded-context prompts need the capability-gated shapes this client does not build.
- **One authentication flow** — the client completes the first agent-driven method the agent advertises and refuses an agent that offers only terminal sign-in; reproducing the agent invocation in an interactive terminal is deferred.
- **No external session memory** — nothing records an agent session id across connections; a consumer that needs to reattach stores the id itself and calls `resumeSession`.
- **Only stdio** — the Streamable HTTP and WebSocket transports are drafts in the protocol and have no binding here.

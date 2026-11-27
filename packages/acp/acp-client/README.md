# @deepseek-ai/dsh-acp-client

English | [中文](README.zh.md)

The version-neutral Agent Client Protocol (ACP) client core. Any conforming agent is one `AcpAgentDefinition`; `connectAcpAgent` starts it over the [`dsh-subprocess`](../../subprocess/subprocess/README.md) seam, negotiates the protocol, and returns a connection whose sessions stream normalized updates. Sign-in completes when the agent first demands it. The library owns the protocol and the process; a consumer owns what it derives from the facts it receives: [`subagent/subagent-acp`](../../subagent/subagent-acp/README.md) collects one answer, and [`acp/agent-acp`](../agent-acp/README.md) writes a session log.

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

`connectAcpAgent` spawns the agent, sends `initialize`, and resolves with the live connection. Every failure, a cancelled setup included, rejects with an `AcpError` after the process it started is reaped; `AcpError.kind` names where the failure originated (`spawn`, `handshake`, `auth`, `unsupported`, `protocol`, or `transport`).

| `AcpConnectOptions` | Default | Meaning |
|---|---|---|
| `definition` | required | The agent: `command`, `args`, explicit `env`, the requested `protocol`, an optional pinned `profile`, and the optional `authMethod` a sign-in completes. |
| `cwd` | required | Absolute working directory of the process and of every session it opens. |
| `spawn` | required | The subprocess seam's spawn function; the agent rides the seam's credential scrub and tree-scoped teardown. |
| `permission` | decline every request | The answerer for the agent's permission requests. |
| `questions` | decline every question | The answerer for the agent's questions. |
| `signIn` | none | What to do for the person while the agent waits for its sign-in: show the addresses it prints, or ask for a terminal sign-in. |
| `profiles` | none | Agent profiles, in precedence order. |
| `clientInfo` | `harniverse` 1.0.0 | The identity this client reports at the handshake. |
| `disposeEofGraceMs` | `6000` | Window after stdin EOF before the teardown escalates. |
| `disposeGraceMs` | `3000` | POSIX grace between SIGTERM and SIGKILL; Windows force-terminates directly. |
| `signal` | none | Cancels the handshake or the v2-to-v1 fallback. |

The client advertises an optional client capability only when the consumer provides it: form elicitation with `questions`, and terminal sign-in with `signIn.terminal`. It provides no filesystem or terminal to the agent, which self-serves in its own process; a request for such a capability is answered with `Method not found`.

## Protocol versions

`definition.protocol` selects the version the handshake requests. `1`, the default, speaks the stable protocol. `2` requests the Preview protocol and starts a fresh v1 child when the agent answers that it speaks v1 only. An agent that speaks neither version fails the handshake. Both versions map onto the same updates; v1 reports the end of a turn through the `session/prompt` response, so the v1 binding synthesizes the `running` and `idle` states that a v2 agent reports itself.

## Sessions and turns

A connection hosts any number of sessions. `newSession()` opens one in the connection's working directory; `resumeSession()`, `listSessions()`, and `closeSession()` are available only when the agent advertised them and otherwise reject with an `AcpError` of kind `unsupported`. A v2 agent owes all three without advertising them.

`session.prompt(blocks, { signal })` starts one turn and returns its `updates` and its `end`. A session runs one turn at a time: a second prompt while a turn is active rejects. Aborting `signal` ends the turn on this client's side at once, as `cancelled`, and sends `session/cancel`; the next prompt waits until the agent is quiet, so a cancelled turn's late updates never reach the one that follows. When the agent process exits, the active turn rejects with a transport error and later work refuses.

A session also carries what the agent offered for it: `modes`, `configOptions`, and `commands`, as last reported. `setMode(modeId)` switches the mode and `setConfigOption(configId, value)` sets one option; each reaches the agent, replaces what the session reports, and rejects when the agent refuses. A session that reported none can be switched nowhere.

## Updates

Every `session/update` arrives as one `AcpUpdate`, in arrival order. A variant this client does not interpret, or a known variant whose fields do not match its contract, arrives as `other` and is never thrown.

| `kind` | Carries |
|---|---|
| `message-chunk`, `thought-chunk` | One streamed content block. |
| `message`, `thought` | A whole-message upsert (v2). |
| `tool-call` | A patch on one tool call: an absent field leaves it unchanged, `null` clears it. |
| `plan` | The agent's plan entries, whole, and the plan's id when the agent keeps several. |
| `plan-removed` | The id of a plan the agent dropped. |
| `usage` | Context-window accounting the agent reported. |
| `session-info` | The session title and update time the agent reported. |
| `notice` | A notice for the person. |
| `mode` | The mode now in effect. |
| `config` | Every configuration option as it stands after a change. |
| `commands` | Every command the agent offers inside a prompt. |
| `state` | Foreground work `running`, `idle`, `requires_action`, or `unknown`, with the stop reason once idle. |
| `other` | Any other variant, passed through. |

## Permission requests

The agent's `session/request_permission` reaches the connection's answerer as one `AcpPermissionRequest` with the agent's options; the answer selects one option or withholds consent. An answerer that throws withholds consent. `policyAnswerer('allow' | 'reject')` supplies the two fixed policies; a connection named without an answerer declines every request.

## Questions

The agent's `elicitation/create` reaches the connection's `questions` answerer as one `AcpQuestionRequest`: the agent's message and one field per requested property — free text, a number, yes or no, or a choice of named values, several allowed where the agent allows it. The answer carries the fields by name, or declines; a field this client cannot express declines the whole request without asking. An answerer that throws cancels the request. A request that asks the person to open an address goes to `signIn.url` instead and is accepted when someone shows it, cancelled when nobody does.

## Sign-in

A connected agent is never asked to sign in until it refuses a request with `Authentication required`. The request that was refused — opening a session, resuming one, or a prompt — then waits while the method is completed, and is sent again: `authenticate` for a method the agent drives, or `signIn.terminal` for one a person completes by running the agent's own program once. Every request refused at the same moment joins the one sign-in in progress; a sign-in that fails or is cancelled is not kept, and the next refusal starts a fresh one. `connection.agent.authMethods` lists what the agent offers, with a terminal method's arguments and environment. While an agent-driven sign-in waits, every address the agent prints on its stderr reaches `signIn.url`, once each. Without a hook for the method the agent offers, the request rejects with an `AcpError` of kind `auth` that names the program to run.

## Agent profiles

Agent-specific behavior is a profile: an id, the `agentInfo.name` values it applies to, and at most one request rewrite. `connectAcpAgent` pins the profile `definition.profile` names before the handshake, or selects the first supplied profile whose `agents` lists the name the agent reported. Without a profile the protocol path consults none.

## Known agents

`KNOWN_AGENTS` is data about the agents the official ACP registry lists that this client was run against or probed: how each is launched over stdio (`command`, `args`), where it reads an API key (`credentialEnv`), how a person signs in, and the names it reports. `knownAgent(id)` finds one. The protocol path uses none of it; a consumer names one to fill in a definition.

## Teardown

`dispose()` ends every active turn with a transport error, closes the connection, and runs the teardown ladder over the seam's public verbs: stdin EOF, the EOF grace, then `terminate()` (SIGTERM, the spawn grace, SIGKILL) and the subprocess owner's whole-tree exit proof. It is idempotent. `disposeAcpChild(child, eofGraceMs)` is the same ladder for a handle a consumer spawned itself.

## Model Experience

Indirectly, through the consumers that derive model-visible facts from normalized updates: [`acp/agent-acp`](../agent-acp/README.md) writes an external agent's output as session events, and [`subagent/subagent-acp`](../../subagent/subagent-acp/README.md) returns one answer to a tool result.

#### KV Cache effect

This library registers no harness model context. It decides only what crosses the wire to an external agent; the consumer that builds the prompt owns every token and its reuse.

## Known Limitations and Deferred Work

- **Prompts are text** — `AcpPromptBlock` carries `text` only; image, audio, and embedded-context prompts need the capability-gated shapes this client does not build.
- **No external session memory** — nothing here records an agent session id across connections; a consumer that needs to reattach stores the id itself and calls `resumeSession`.
- **A document plan is not read** — a `plan_update` whose content is Markdown arrives as `other`.
- **Only stdio** — the Streamable HTTP and WebSocket transports are drafts in the protocol and have no binding here.
- **No profile is registered** — the four known agents needed no request rewrite when they were run; a profile is the place for one that does.

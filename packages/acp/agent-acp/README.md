# @deepseek-ai/dsh-agent-acp

English | [中文](README.zh.md)

ACP mode: an agent whose turns are turns of an external Agent Client Protocol (ACP) agent. The row contributes the step driver to every agent whose scope descends from its own, so a preset names ACP mode by composing this row and nothing else. Harniverse is then only the frontend: the external agent brings its own model, system prompt, tools, and skills, and the session log carries what it produced. The protocol, the process, and the teardown belong to [`acp/acp-client`](../acp-client/README.md).

## Preset template

[`preset/acp/`](preset/acp/agent.cordis.yml) is a template, not part of the shipped roster: an external agent is something you install yourself. Copy the directory to `${DSH_HOME:-$HOME/.dsh}/.agent-presets/acp/` and set `command` and `args` for the agent you have — Claude Code (`claude acp`), Codex (`codex-acp`), Gemini CLI (`gemini --experimental-acp`), Antigravity (`agy acp`), or any other conforming agent. Complete the agent's own sign-in once with its program, outside the harness.

The template carries no persona, tools, skills, MCP servers, or model route: everything a harness agent would bring is the external agent's own.

## What a turn writes

The [`dsh-agent`](../../core/agent/README.md) machine owns the turn and its steps; this driver owns what happens inside a step. One step is one segment of the external agent's turn: the streamed answer becomes `assistant/chunk` events and one `assistant/message`, attributed to `acp`. When the external agent reports a tool call, the segment's message carries the call, `tool/call` records it, and `tool/result` carries the text it reported — all in the step that made the call, so every result lands beside its call. Speech that follows a tool call opens the next step, and waits for every pending call to report first. An `end_turn` closes the turn as `completed`; `max_tokens` as `max-tokens`; a refusal, a failure, or an agent-side cancellation closes it as an error that carries the stop reason.

| External stop reason | Turn ending |
|---|---|
| `end_turn` | `completed` |
| `max_tokens` | `max-tokens` |
| `cancelled`, with the turn cancelled here | `aborted` |
| `refusal`, `max_turn_requests`, `error`, unknown | `error` (`ACP_TURN`) |
| A broken connection or a failed start | `error` (`ACP_TURN`); the next turn starts a fresh process |

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `command` | required | Executable that serves the external agent over stdio. |
| `args` | `[]` | Arguments passed to `command`. |
| `env` | `{}` | Environment variables added on top of the subprocess seam's scrubbed parent environment. |
| `cwd` | each session's workspace | Working directory of the external process and its session. A relative path resolves against the harness launch directory at load. |
| `protocol` | `1` | ACP version requested at the handshake: `1`, or `2` with a v1 fallback. |
| `permission` | `ask` | `ask` routes each permission request through the approval seam and fails closed without an answerer; `allow` takes the agent's first allow option; `reject` declines every request. |

```yaml
- id: agent-acp
  name: '@deepseek-ai/dsh-agent-acp'
  config:
    command: claude
    args: [acp]
    env: {}
    permission: ask
```

## Process lifetime

The external process starts at the first step and serves every later turn of that agent. It is reaped when the agent's scope unwinds, and a process that exits on its own is replaced by a fresh one at the next turn. Its stderr stays on the harness's own stderr. A session with no workspace and no configured `cwd` fails its first turn with `ACP_NO_CWD` instead of binding the agent to the server's launch directory.

The package has no default export. Cordis loader unwrapping would otherwise hide the named `inject` metadata; see [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md).

## Model Experience

### External-agent prompt

#### What the model sees

Only the text the person wrote, as the prompt of the external agent's turn. Context that harness plugins inject into the session log is not forwarded: the external agent owns its context. A step without person-written text sends the placeholder `(no text content)`.

#### Token effect

The external agent pays for its own context under its own account; nothing from this driver enters a harness model request.

#### KV Cache effect

Independent of every harness request cache. Reuse depends on the external agent's provider and on the text it received, which this driver passes through unchanged.

## Known Limitations and Deferred Work

- **The external session does not survive a restart** — nothing records the agent's session id, so a restarted harness opens a fresh external session while the harness transcript stays; durable resume needs a session event of its own.
- **Only person-written text is forwarded** — attachments and context injected by harness plugins stay in the harness log and never reach the external agent.
- **Tool results carry text only** — a call's `content` items contribute their text and nothing else; a call that reported none falls back to its title.
- **Images and audio from the agent are dropped** — only text and thought chunks are written; non-text output needs an attachment reference this driver cannot mint.
- **Plans, notices, usage, and session titles are not surfaced** — they arrive from the client core and are consumed without a durable record.
- **One external agent per preset** — choosing among several at session creation needs a preset copy per agent.

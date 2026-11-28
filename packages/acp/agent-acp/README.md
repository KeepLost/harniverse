# @deepseek-ai/dsh-agent-acp

English | [中文](README.zh.md)

ACP mode: an agent whose turns are turns of an external Agent Client Protocol (ACP) agent. The row contributes the step driver to every agent whose scope descends from its own, so a preset names ACP mode by composing this row and nothing else. Harniverse is then only the frontend: the external agent brings its own model, system prompt, tools, and skills, and the session log carries what it produced. The protocol, the process, the sign-in, and the teardown belong to [`acp/acp-client`](../acp-client/README.md).

## Preset template

[`preset/acp/`](preset/acp/agent.cordis.yml) is a template, not part of the shipped roster: an external agent is something you install yourself. Copy the directory to `${DSH_HOME:-$HOME/.dsh}/.agent-presets/acp/` and name the agent you have with `agent` — `claude-acp` (Claude Code), `codex-acp` (Codex), `gemini` (Gemini CLI), or `antigravity-acp` (Google Antigravity) — or, for any other conforming agent, with `command` and `args`. A known agent fills in the command the row leaves unset.

The template carries no persona, tools, skills, MCP servers, or model route: everything a harness agent would bring is the external agent's own.

## What a turn writes

The [`dsh-agent`](../../core/agent/README.md) machine owns the turn and its steps; this driver owns what happens inside a step. One step is one segment of the external agent's turn: the streamed answer becomes `assistant/chunk` events and one `assistant/message`, attributed to `acp`. When the external agent reports a tool call, the segment's message carries the call, `tool/call` records it, and `tool/result` carries what it reported — all in the step that made the call, so every result lands beside its call. Speech that follows a tool call opens the next step, and waits for every pending call to report first. An `end_turn` closes the turn as `completed`; `max_tokens` as `max-tokens`; a refusal, a failure, or an agent-side cancellation closes it as an error that carries the stop reason.

A step whose input no person wrote — context a harness plugin injected while no external turn was open — starts no external turn: it is logged and the step completes at once.

| Failure | Turn ending |
|---|---|
| A broken connection or a failed start | `error` (`ACP_TURN`); the next turn starts a fresh process |
| A sign-in nobody completes | `error` (`ACP_TURN`), naming the method or the program to run |
| A credential reference nobody stored | `error` (`ACP_CREDENTIAL`), naming the reference |
| A session with no workspace and no configured `cwd` | `error` (`ACP_NO_CWD`), rather than binding the agent to the server's launch directory |

## Images

The person's images travel with their text, in the order they wrote them: each one is read back from the attachment store and sent as an image block, which the agent takes only when its handshake admitted image prompts. An image the agent cannot take, that no store holds, or that the store cannot read back stays behind; the turn goes on and a notice in the transcript names the image and the reason. A generic file the person attached reaches the agent through the read-only path of its handle text, which the agent's own tools read.

An image the agent sends enters the log as an attachment: one it streams is stored and written after its text, and one a tool call reports takes its place in that call's result, so the conversation shows both. An image the store cannot keep — a type it does not store, bytes it cannot decode — becomes a text note saying so. A message interrupted before its turn ended keeps its text and none of its images.

This needs the attachment store ([`attachment/attachment-local`](../../attachment/attachment-local/README.md)) in the composition; without it every image stays behind or becomes a note.

## Sign-in

The agent is asked to sign in only when it refuses a request for that reason, so an agent that is signed in already is never asked. The method completed is the one `authMethod` names, else the first agent-driven method the agent advertises, else the first terminal one. A browser sign-in the agent drives itself runs inside the turn that needed it; each address the agent prints while it waits lands in the transcript as a notice. A terminal sign-in becomes a question that names the program to run once, in a terminal, and waits until the person says it is done; without a user-questions seam the turn fails and names the program instead.

## The external session

The first turn opens a session on the agent and records it in the session log as `acp/session`: the agent's session id, how it was launched, and the working directory. When the harness reopens the session, the next turn reattaches to that external session while the agent still holds it and advertises resume; the harness transcript stays either way. An agent that no longer holds the session gets a fresh one, and the transcript says so. A fork inherits its parent's events but none of its own, so it opens an external session of its own. `resume: false` opens a fresh external session at every harness start.

## Several agents in one preset

The row may name several agents under `agents`; a session then runs `default`, else the first entry, until the person picks another with `/acp-agent`. Switching reaps the running agent's process; the chosen agent's next message continues the external session it opened earlier in this same session while it still holds one, and opens a fresh one otherwise. A reopened session continues with the agent it last talked to. The person's switch is kept for the life of the harness process; a switch made after the last message of a session is not remembered across a restart.

## What the agent reports

| Report | Where it goes |
|---|---|
| Plan | The session's standing todo list (`todo/write`), the list the conversation shows; each report replaces it whole. |
| Plan kept as a document | A notice in the transcript carrying the document's whole text and the file it lives in when the agent named one; a document reported unchanged is shown once. |
| Title | The session title, until the person names the session themselves; the applied title is recorded as `acp/title`, so the agent's later titles still apply after the session was reopened. |
| Notice | A notice in the transcript; it starts no external turn. |
| Question | A question to the person through the user-questions seam, answered field by field; what was asked and answered is recorded as one completed `acp_question` call beside the agent's tool calls. Without the seam the question is declined. |
| Mode, options, commands | Kept for the `acp` commands, and replaced by every later report. |
| Context and cost | The log-only `agent/context` record of the [`dsh-agent`](../../core/agent/README.md) vocabulary: the tokens the agent holds in context, the window it budgets against, and the session cost so far. The token meter's occupancy ring reads it, and `/acp` prints it. A report that repeats the standing record writes nothing. |

## The acp commands

The row registers four commands for the sessions it drives. `/acp` shows the external agent, its session, the agents to pick from, its modes, its options, the commands it offers inside a prompt, and its context and cost once it reported them. `/acp-agent` lists the agents to pick from and marks the one in effect; `/acp-agent <name>` chooses the agent the next messages run on, which a running turn refuses. `/acp-mode <mode>` switches the session's mode. `/acp-option <option> <value>` sets one option — a model, an effort, a speed — by id or by name, with `true`/`false` for a boolean one; without a value it shows the option as it stands. A switch reaches the agent through `session/set_mode` or `session/set_config_option` and is refused when the agent does not offer it.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `agent` | none | A known agent — `claude-acp`, `codex-acp`, `gemini`, or `antigravity-acp` — whose command and arguments fill in what the row leaves unset. |
| `command` | a known agent's | Executable that serves the external agent over stdio. Required unless `agent` names a known one. |
| `args` | a known agent's, else `[]` | Arguments passed to `command`. |
| `env` | `{}` | Environment variables added on top of the subprocess seam's scrubbed parent environment. |
| `credentialEnv` | `{}` | Environment variable → credential reference. Each reference is resolved through the credentials service at every start and handed to the agent as that variable, so no key is written into the preset. |
| `agents` | none | Named agents this row can drive, each an object with the seven keys above. A session picks one with `/acp-agent`. Not together with a top-level `agent` or `command`. |
| `default` | the first entry of `agents` | The agent a session runs until the person picks another. |
| `cwd` | each session's workspace | Working directory of the external process and its session. A relative path resolves against the harness launch directory at load. |
| `protocol` | `1` | ACP version requested at the handshake: `1`, or `2` with a v1 fallback. |
| `authMethod` | the agent's first | Id of the sign-in method this row completes when the agent demands sign-in. |
| `resume` | `true` | Whether a reopened harness session reattaches to the external session its log records. |
| `permission` | `ask` | `ask` routes each permission request through the approval seam and fails closed without an answerer; `allow` takes the agent's first allow option; `reject` declines every request. |

```yaml
- id: agent-acp
  name: '@deepseek-ai/dsh-agent-acp'
  config:
    agent: claude-acp
    env: {}
    permission: ask
```

```yaml
- id: agent-acp
  name: '@deepseek-ai/dsh-agent-acp'
  config:
    agents:
      claude:
        agent: claude-acp
      codex:
        agent: codex-acp
        credentialEnv:
          OPENAI_API_KEY: OPENAI_API_KEY
    default: claude
    permission: ask
```

## Process lifetime

The external process starts at the first step and serves every later turn of that agent. It is reaped when the agent's scope unwinds, when the person switches to another agent, and a process that exits on its own is replaced by a fresh one at the next turn. Its stderr stays on the harness's own stderr; the addresses it prints during a sign-in are read from it on the way.

The package has no default export. Cordis loader unwrapping would otherwise hide the named `inject` metadata; see [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md).

## Model Experience

### External-agent prompt

#### What the model sees

The text and the images the person wrote, in their order, as the prompt of the external agent's turn. Context that harness plugins inject into the session log is not forwarded: the external agent owns its context. A person's message without text and without a forwarded image sends the placeholder `(no text content)`.

#### Token effect

The external agent pays for its own context under its own account; nothing from this driver enters a harness model request.

#### KV Cache effect

Independent of every harness request cache. Reuse depends on the external agent's provider and on the content it received, which this driver passes through unchanged.

## Known Limitations and Deferred Work

- **An agent's streamed images follow its text** — the text of a segment is one block, and the images it streamed come after it, whatever order they arrived in; images a tool call reported keep their place in that call's result.
- **Audio is not carried in either direction** — the harness stores no audio attachment, and the client sends no audio block.
- **A document plan is shown as its text** — the notice carries the document verbatim; it is not rendered as Markdown, and its checkboxes do not feed the todo list.
- **The agent's choice is kept for the harness process** — a switch made after the last message is not remembered across a restart, and the session-creation dialogs offer no agent picker; `/acp-agent` is the switch.
- **The `todos` list has one unit** — a composition that mounts the todo tool must leave this row's list out, and the other way round.
- **No attachment, filesystem, terminal, or MCP passthrough** — the client advertises none of these capabilities, so the agent reads and writes its own process's files.

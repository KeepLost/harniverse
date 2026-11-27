# Agent Note: ACP sign-in on demand, a durable external-session binding, and what the agent reports

Status: implemented

English | [中文](2026-11-27-acp-sign-in-session-binding-and-agent-state.zh.md)

## Problem

[ACP mode](../architecture/2026-11-27-acp-client-core-and-acp-mode.md) shipped on three assumptions: that the agent is signed in before the harness connects, that a harness session never reopens, and that the agent reports nothing but text and tool calls. Run against the agents people use, each failed.

The official registry's protocol matrix of 2026-11-26 covers 42 agents: 17 offer only a terminal sign-in, and 27 refuse `session/new` until a person signs in. The client completed one agent-driven method at the handshake and refused every other agent, so it either asked an agent that was already signed in or refused one that was not. The Claude Code adapter goes further: it answers `session/new` and refuses the first `session/prompt`, so a handshake-time authentication is the wrong moment for it altogether.

Nothing recorded the external agent's session id. A harness restart therefore opened a fresh external session under a transcript that still held the whole conversation, and the next question — "and the second one?" — reached an agent with no memory of the first. And the agent's plan, title, notices, questions, modes, and options arrived from the client core and were dropped: a question was answered `Method not found`, a plan never appeared, and a person could not switch the agent's model without leaving the harness.

## Decision

**Sign-in waits for the agent to demand it.** [`@deepseek-ai/dsh-acp-client`](../../../../packages/acp/acp-client/README.md) completes no authentication at the handshake. When the agent answers a request with `Authentication required` (`-32000`), that request — opening or resuming a session, or a prompt — waits while the method is completed and is then sent once more: `authenticate` for a method the agent drives, or a consumer's hook for a terminal method a person completes by running the agent's own program once. Requests refused at the same moment share one sign-in; a failed or cancelled one is not kept. Every address the agent prints on its stderr while it waits reaches the consumer, once each. The method is `authMethod` when the definition names one, else the first agent-driven one, else the first terminal one.

**The binding is a session event.** [`@deepseek-ai/dsh-agent-acp`](../../../../packages/acp/agent-acp/README.md) appends `acp/session` when a session opens on the agent: the agent's session id, how it was launched, and the working directory. A reopened session reattaches through `session/resume` or `session/load` while its own log holds a binding, the agent advertises resume, and the row launches the same agent in the same directory; an agent that no longer holds the session gets a fresh one and the transcript says so. "Its own log" is the session's suffix above `header.seedLength`, which is how a fork — a copy of its parent's events — is kept off its parent's external session.

**What the agent reports goes where the harness already shows it.** A plan becomes the session's standing todo list through `todo/write`; a title becomes the session title until the person names the session themselves; a notice becomes a notice message in the transcript; a question becomes a question through the user-questions seam and is recorded as one completed `acp_question` call; modes, options, and commands are kept for three commands — `/acp`, `/acp-mode`, `/acp-option` — that switch them through `session/set_mode` and `session/set_config_option`. A step whose input no person wrote, while no external turn is open, starts no external turn: it is logged and completes at once, which is also what keeps a notice or a sign-in address from becoming a prompt.

**The row knows the agents people name.** `KNOWN_AGENTS` carries how each of the four registry agents is launched, where it reads an API key, and how a person signs in; `agent: claude-acp` fills in a command the row leaves unset. A key goes through `credentialEnv` — environment variable → credential reference, resolved through the credentials service at every start — never into the preset file.

## Alternatives considered

**Complete the authentication at the handshake, as before.** It asks an agent that is already signed in, and for the Claude Code adapter it is also the wrong moment: the session opens and the first prompt is what gets refused. Completing on the first refusal serves both agents and keeps a signed-in agent from being asked at all.

**Ask only around `session/new`.** Codex refuses the session; the Claude Code adapter refuses the prompt instead. The retry wraps every request a turn depends on.

**Refuse a terminal-only agent until a terminal seam can run its program.** The web terminal runs discovered shells only, and a plugin that attaches to type into it demotes the browser to read-only. The harness asks the person to run the program the method names and to say when it is done, which works on every surface that can show a question and needs no new seam.

**Surface modes and options in the model picker.** The picker's catalog is built host-wide from the LLM adapters with no per-session contribution point, and it blocks on a served default model that ACP mode does not use. Three commands reach the same agent operations without touching the picker, and appear only on the sessions the preset drives.

**Forward the harness transcript as a preamble when the agent cannot resume.** It contradicts the mode's rule that only person-written text reaches the agent, and every agent probed here resumes. A fresh external session is opened and announced instead; the preamble stays a decision for the owner.

**Compose the todo tool for the plan list.** The tool registers a `todo_write` tool and queues a continuation message when a turn stops with unfinished todos, which in ACP mode would become a prompt. The driver installs the same `todos` fold on its own, under the key the conversation already reads.

## Consequences

An agent is asked to sign in exactly when it asks to be, through its own browser flow or through a program the person runs; a reopened session continues the external agent's context; and the agent's plan, title, notices, questions, and switches are visible and switchable from the harness.

`acp/session` is an additive session event under the additive-only policy: `SESSION_FORMAT_VERSION` stays `0`, and the persistence catalog and the session-contract digest were regenerated for it. A reader that meets the event without knowing it refuses the log, as it does for every required event it does not know. The digest baseline's additive drift is this one event.

The run against the real adapters found one defect the scripted agent could not: a stream the agent leaves behind can fail more than once — one write past its death is one `error` event — and a listener registered for the first only left the second unobserved, which ends the process. The transport now keeps its listeners for the life of the stream.

Left as found, each in the owning README: attachments are not forwarded; the agent's images and audio are dropped; usage is not surfaced; a title the agent reports after a reopen is not applied while an earlier one already was; one external agent per preset. The content gaps and the single-agent limit are closed in [ACP content passage and several agents](2026-11-28-acp-content-passage-and-several-agents.md).

## Required verification

The client core is covered branch by branch against an in-memory scripted agent — the refusal-and-retry path for sessions and prompts, the pinned method, terminal hooks, the address watch, option and mode reports and switches, question parsing and answering — and by the recorded handshake and session-setup answers of the real Claude Code and Codex adapters, replayed through the real binding. The driver is covered through the real factory against a scripted agent in a real child process: the binding event, a reopen over the JSONL persistence that reattaches, the fresh-session fallback and its notice, `resume: false`, another agent's binding, a fork, a plugin-only step, the plan list, the title, the notice, questions answered and declined, the three commands, a credential resolved and missing, and a known agent's launch. A Loader smoke boots the copied template end to end.

The real adapters were run through the plugin on 2026-11-27: the Claude Code adapter over a relay answered one turn, surfaced a notice it published, and — after the harness was disposed and the session reopened — answered a question about its own earlier reply, which proves the reattachment restored its context. The Codex adapter rode the same path through its `api-key` method and opened a session; its relay's Responses route answered 502, so no model reply was had from it. Both run on demand through `DSH_ACP_REAL=claude` or `codex` in `packages/acp/agent-acp/tests/real-agents.e2e.ts`, under a scratch HOME, and stay skipped otherwise.

# Agent Note: ACP content passage — images, context accounting, document plans, titles across a reopen — and several agents in one preset

Status: implemented

English | [中文](2026-11-28-acp-content-passage-and-several-agents.zh.md)]

## Problem

[ACP mode](2026-11-27-acp-sign-in-session-binding-and-agent-state.md) passed text and nothing else between the person and the external agent, and bound one preset to one agent. A screenshot the person attached never reached the agent; an image a tool of the agent read was dropped from the transcript; the agent's context accounting arrived from the client core and was discarded; a plan the agent kept as a document was not shown; a title the agent reported after the session was reopened was not applied; and choosing between two agents meant two preset copies.

## Decision

**Images pass through the attachment seam in both directions.** [`@deepseek-ai/dsh-agent-acp`](../../../../packages/acp/agent-acp/README.md) reads each image of a person's message back from `ctx.attachments` and sends it as an image block after the text, in the order written; the client core sends an image block only to an agent whose handshake admitted image prompts, and refuses the turn otherwise before anything is sent. The driver keeps that refusal from happening: an agent that takes no images, a composition without a store, or a stored image that cannot be read back leaves the image behind, and a notice names it and the reason while the turn goes on. An image the agent sends is stored through the same seam before it is written — one it streamed as a block after its text, one a tool call reported inside that call's result — so the conversation renders it from the log like any attachment; an image the store cannot keep becomes a text note saying why. Every image is read or stored before the content is assembled, so the assembly itself is synchronous and a segment interrupted before its turn ended keeps its text and none of its images.

**Context accounting is a record of the agent vocabulary.** ACP's `usage_update` is not a model call's token count: it says how many tokens the agent holds in context, how large its window is, and what the session cost so far. Putting it on `assistant/message.usage` would bill it as tokens. [`@deepseek-ai/dsh-agent`](../../../../packages/core/agent/README.md) therefore declares the log-only `agent/context` record — `used`, optional `size`, optional `cost` — which a step driver that keeps its own context writes and the model loop never does. The token meter's `contextPressure` fold reads it as a usage sample of its own kind: `used` anchors the numerator and `size` the denominator, so the composer's occupancy ring shows an external agent's real fill. The driver writes one record per distinct report, with whole numbers in range only.

**A document plan is shown as its text.** A `plan_update` whose plan is Markdown has no entry list to fold into the todo list; the client core normalizes it as `plan-document`, and the driver shows it as a notice carrying the whole text and the file it lives in, once per distinct text. Its removal leaves the todo list alone, since it never fed it.

**The applied title is recorded beside the rename.** The title service stores every accepted title the same way, so a driver that remembered its own last title in memory lost that memory on reopen and then took the standing title for the person's. The driver now appends the log-only `acp/title` right after the rename that applied a title; a standing title is the person's own exactly when it is neither the last one recorded nor absent.

**Several agents share one preset.** `agents` names the agents a row can drive, each with the launch fields the single form takes; `default` names the one a session starts on. `/acp-agent` lists them and switches the agent the next messages run on; a running turn refuses the switch, and a different agent takes a process of its own. The binding record already names the launch that made it, so the next message reattaches to the external session the chosen agent opened earlier in the same session while it still holds one, and opens a fresh one otherwise. The selection is not a new record: a reopened session continues with the agent its latest own binding names, which is the one it last talked to.

## Alternatives considered

**Map `usage_update` onto `TokenUsage`.** The StatsLine and the session totals would show context tokens as billed input, and the per-call cache fields have no source. A record that says what the agent said, read by the one display whose fact it is, keeps billing and occupancy apart.

**Let agent-acp own a private `acp/usage` event and have the token meter read it.** The meter would learn one optional plugin's event. The record describes any step driver that keeps its own context, so it belongs to the vocabulary the driver seam already declares.

**Derive todo entries from a document's checkboxes.** It is a guess about one Markdown convention, and it puts one fact in two homes. The text is shown whole, and the todo list stays the entry list's.

**Give the title service an API for a plugin-supplied title.** It widens a core service for one caller and needs a provider slot the service holds for one generator at a time. A record the driver owns, read only by the driver, answers the one question it has: whose title is standing.

**Register a session-title provider whose `generate` returns the agent's title.** The service calls a provider on its own cadence, from the person's messages, not when an agent reports. A provider that returns whatever it last heard is that record with more machinery.

**Choose the agent at session creation, in the creation dialogs.** It needs a per-preset contribution point in the session-creation UI that does not exist. A command on the driven session reaches the same choice with no client change; the dialogs remain a follow-up.

**Keep the selection in a new log-only event.** The latest binding of the session's own log already says which agent it last talked to, and that is the selection a reopened session should continue with.

## Consequences

An image reaches the agent that takes images, comes back from the agent's tools into the conversation, and is named for the person when it cannot travel; the composer's ring shows an external agent's context fill and `/acp` prints it with the session cost; a document plan and the agent's later titles are visible; and one preset can carry every agent a person alternates between.

Three records were added under the additive-only policy — `agent/context` in the agent vocabulary, `acp/title` beside `acp/session` — and the persistence catalog and the session-contract digest were regenerated for them. `SESSION_FORMAT_VERSION` stays `0`. A reader that meets them without knowing them refuses the log, as it does for every required event it does not know.

The token meter's `contextPressure` unit moved to `stateVersion` 5, so a persisted projection cache written before folds again once.

An agent's streamed images follow its text whatever order they arrived in, audio is carried in neither direction, a document plan is not rendered as Markdown, and the selection of an agent lives for the harness process. Each is in the owning README.

## Required verification

The client core covers the image capability gate, the document plan, and the typed cost against its in-memory agent. The driver covers, through the real factory against a scripted agent in a real child process with the local attachment store mounted: an image forwarded as the stored bytes, the three ways one stays behind and the notice for each, an image the store cannot read back, streamed and tool-reported images stored and assembled from the chunks they cite, the notes for an image the store cannot keep, an interrupted segment, one context record per distinct report with out-of-range counts dropped, the `/acp` line, a document plan shown once and its removal, a person's rename kept before and after the agent's first title, a reopened session taking the agent's later title, the default agent, a switch, a reattachment to the agent it returns to, the continuation after a reopen, the refused switch during a turn, and the launch errors of the named form. A keyless Loader composition copies the shipped preset with the attachment store mounted and drives one turn in which the person's image reaches the agent and the agent's tool-reported image enters the log. The token meter covers the fold's four paths. Changed source files are at 100% coverage.

No real adapter was run for this batch: none is installed where the work was done, and the adapters' image and accounting behavior on the wire is known here only from the protocol schema. `DSH_ACP_REAL` remains the way to run them.

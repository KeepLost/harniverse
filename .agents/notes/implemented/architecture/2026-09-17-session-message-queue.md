# Agent Note: The session message queue — durable topics, forced archival, and wake-on-deliver fan-out

Status: implemented

English | [中文](2026-09-17-session-message-queue.zh.md)

- Date: 2026-09-17
- Scope: `@deepseek-ai/dsh-queue` (+`/tool`), `@deepseek-ai/dsh-client-ui-queue`, `dsh-client-ui-governor` (panel rename + tab ring)
- PR: 6307ab410842837fa1c23a0f0f7adede0f45affc (backfilled after the feature PR landed)

## Problem

Sessions needed an event-stream seam with Kafka semantics: durable append-only topics with dense per-topic offsets, a per-message lifecycle that force-archives past its deadline and never delivers archived data to any subscriber, a subscription relation that dissolves silently when either side disappears, and delivery that injects into the subscribed session's model-visible context — waking idle sessions without disturbing running ones.

## Decision

- **Delivery rides the two existing agent-input verbs**: `agent.followup(envelope)` for idle sessions (the wake the scheduler already uses) and `agent.inject(envelope)` for running ones (claimed at the next step boundary, i.e. after the blocking command). The envelope is a plugin-source `user/message` (`plugin: 'queue'`, carrying `topic`/`offset`), so it projects as a context-injection row, replays from the log alone, and costs zero session-core changes. One message per injection by design.
- **Storage**: the `queue` storage domain with four tables — topics (id-keyed, plus a unique-name index whose recreation mints a fresh id), messages (`topicId#offset` keys, live/archived state), and the subscription relation (`sessionId#topicId`). All writes await the domain's write chain: reads inside one serialized task see the writes that precede them.
- **Offsets and bounds**: dense per-topic offsets under a serialized publish chain; payload ≤256 KiB, ≤10 000 live per topic (full topic rejects), ≤10 000 archived per topic (sweeper prunes oldest first).
- **Session states**: archived subscribers keep their relation dormant — no delivery, no wake, watermark advances (missed stays missed, even after unarchiving); `subscribe` on an archived session rejects. Session deletion dissolves relation rows within one sweeper interval (no host event exists on the deletion path yet).
- **Tools** (`dsh-queue/tool`, standard-preset row `tool-queue`): `queue-topic` list/inspect/delete (inspect reads the relation by topic or by session, `current` = caller), `queue-history` (cursor-free past-tense read), `queue-subscription` (calling session only), `queue-publish`.
- **Panel**: `ui-governor` renamed to 会话看板/Panel with an in-page tab ring over the new `governor.center.tab` slot (hidden with a single contribution); `ui-queue` contributes the 消息队列 tab with the topic table, per-topic history, dormant-badged subscriptions, and capability-gated controls, polling the `queue` Remote namespace.

## Alternatives considered

- A new `queue/message` session event type: rejected — the catalog regeneration and request-preparation changes buy nothing the plugin-source `user/message` does not already carry, and the context-injection projection renders it for free.
- A pull (`consume`) verb and per-agent cursors: rejected by specification — subscriptions are push; history browsing is the only cursor-free read.
- A deletion event on the workspace seam for immediate cascade: deferred — no such event exists today; the sweeper resolves within one interval and the note records the ceiling.

## Consequences

- Delivery is at-most-once: the cursor advances in the same batch as the injection; a crash between the append and the cursor write can duplicate an injection.
- One broker per host process: distribution means N session/panel consumers over one durable log, not clustering.
- Any future bottom-anchored panel tab follows the `governor.center.tab` slot seam, not another center view.

## Testing

- Service suite (31 tests) at per-file 100%: offsets, wake/idle/inject arms, archived dormancy, both cascade directions, TTL sweep and archive pruning, ceilings, cold-resume delivery, maintenance retry.
- Tool suite (6) and panel suites (18 + governor rework) at per-file 100%; `test:gui` 4993 green; e2e replay green.

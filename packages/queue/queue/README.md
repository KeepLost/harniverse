# @deepseek-ai/dsh-queue

English | [中文](README.zh.md)

The session message queue (`ctx.queue`): Kafka-style durable topics with dense per-topic offsets, time-based forced archival (an expired or archived message is never delivered, even to a subscriber that lagged behind), a silent bidirectional subscription relation model (deleting either side dissolves the relation immediately — no notification), and wake-on-deliver fan-out. An idle subscribed session wakes and processes a delivered message; a running one receives it after the blocking command at its next model request. Single host process = the broker; distribution means any number of session and panel consumers over the same durable log.

## Remote surface

The `queue` Typert Remote namespace mounts through `dsh-api-remotes`: `topicList`/`messages`/`subscriptions`/`stats` under `harniverse.observe`; `topicCreate`/`topicDelete`/`publish`/`subscribe`/`unsubscribe` under `harniverse.operate`.

## Service contract

- **Topics**: unique name; publishing creates one implicitly with the deployment TTL. A recreated name is a fresh topic (new id, offsets from zero, no subscription resurrection).
- **Messages**: per-topic dense offsets; payload bounded (default 256 KiB); live ceiling per topic (default 10 000, full topic rejects the publish); `expiresAt = publishedAt + (message ttl ?? topic ttl ?? default 24 h)`.
- **Delivery**: publish commits, then fan-out appends a plugin-source `user/message` (`plugin: 'queue'`, carrying `topic`/`offset`) to every subscriber — idle sessions wake through `agent.followup`, running sessions take it as injected context at the next step boundary. At-most-once: the subscription cursor advances with the delivery in the same batch. A message already past its deadline at delivery time is never delivered, but the watermark still advances (missed stays missed).
- **Session states**: active and idle-not-archived deliver (idle wakes); archived keeps the relation dormant — no delivery, no wake, watermark advances; unarchiving resumes delivery for new messages only. `subscribe` on an archived session rejects.
- **Relation model**: deleting a topic or a session dissolves its subscription rows silently (session-side within one sweep interval — no host event exists on the deletion path).
- **Tools** (`dsh-queue/tool`, preset-scoped): `queue-topic` (list / inspect by-topic-or-by-session / delete), `queue-history` (past-tense, cursor-free), `queue-subscription` (subscribe/unsubscribe — calling session only), `queue-publish`.

## Model Experience

### Queue delivery

#### What the model sees
A delivered message arrives as a user-role context injection labelled `queue`: an envelope line naming the topic, offset, publisher, and expiry, then the payload verbatim.

#### Token effect
One delivered message costs its envelope (about 30 tokens) plus the payload. There is no polling verb — an agent that needs history calls `queue-history` explicitly.

#### KV Cache effect
Deliveries append at the log tail, so cache reuse matches ordinary appended turns. Bulk publishes to a running session coalesce at the next step boundary and cost one prefix extension.

## Known Limitations and Deferred Work
- Delivery is at-most-once by design (cursor advances with the delivery batch); a crash between the event append and the cursor write can duplicate an injection, and a crash before it can drop one.
- One message = one injection; high-rate topics do not coalesce deliveries into a batched digest. Upgrade trigger: a subscribed session sustaining multi-message-per-second turns.
- Session-deletion cascade resolves within one sweep interval (no host-side deletion event exists to hook today).
- No cross-process broker: the queue is as durable as the host's storage domain.

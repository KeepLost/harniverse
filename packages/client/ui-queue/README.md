# @deepseek-ai/dsh-client-ui-queue

English | [中文](README.zh.md)

Message-queue panel tab, browser half: registers the 消息队列 tab into the panel (会话看板) center view through the `governor.center.tab` slot. The tab lists topics with live/archived counts, subscriber totals, and offset bounds; one topic opens its message history (live plus forced-archived, dimmed) with expiry clocks, the subscription relation with dormant badges for archived subscribers, and publish / subscribe / unsubscribe controls gated by the queue Remote's capabilities. Data arrives through the generated `queue` Remote (`ctx.remote.queue`) polled at the sampling cadence — the same HTTP API surface scripts and the model tools use. The node half registers no host behavior; the host service lives in `@deepseek-ai/dsh-queue`.

## Composition

- Declares no slots of its own; contributes one `governor.center.tab` entry (id `queue`, ordered after the built-in resources tab).
- `inject`: `slots`, `locale`, `remote`, `remote.queue`.

## Model Experience

The tab is presentation-only: it sends no model-visible input and reads nothing from any session log. Model-visible behavior (delivery injection) belongs to the `dsh-queue` service and its tools.

## Known Limitations and Deferred Work
- Message history is capped to the first page (100 rows) per refresh; pagination and offset-range queries ride the same Remote verbs when needed.
- The publish form validates payload JSON client-side only; the service ceiling still rejects oversized payloads.

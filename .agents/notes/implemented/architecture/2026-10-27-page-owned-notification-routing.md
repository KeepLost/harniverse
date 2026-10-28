# Agent Note: Page-owned browser notification routing

Status: implemented

English | [中文](2026-10-27-page-owned-notification-routing.zh.md)

## Problem

Every browser page connected to one Harniverse instance opened its own all-session `events.mux` subscription and independently evaluated every session event for alerting, with only two guards: a same-browser `BroadcastChannel` arbitration (one presenting tab per browser) and per-page settings gates. With multiple browsers — or the same browser on several machines — against one instance, every page rang for every session's occurrences: notifications crossed page and machine boundaries that no client-side mechanism can arbitrate across, because pages of different browsers share no channel.

## Decision

Notification detection and arbitration move to the host; pages declare presence. The owner's rule: **the page that currently has a session open receives that session's notifications; a session no page has open is not delivered** (an explicit owner decision — background sessions without an open page stay silent).

- **Presence binding.** `ConnectionController` mints one stable `page` token per page load and rides it on every mux open (URL query `page`, validated with the existing `since` cursor rules on both the WebSocket and SSE carriers). The host binds the token to each live mux stream of that page; the binding dies with the stream, and a reconnect re-binds the same token, so presence survives reconnects with no heartbeat.
- **Adoption.** The unary `events.adopt({page, sessionIds})` is an idempotent whole-set replacement the sessions runtime fires whenever the page's current session changes (best-effort: a lost call only means silence until the next change). Per session the declarers are ordered; the most recent declarer owns delivery, and closing the owner's last live stream falls back to the previous declarer.
- **Central detection.** One `NotifyDetector` fold in the API proxy consumes the live sources — durable `turn/end` reasons, requested approvals and questions (once per rpcId until resolved, so the per-stream mux replay never rings), background-job terminal edges, the `goal` projection's blocked entry, and live agent errors — and hands each occurrence to the delivery sink. Detection mirrors the retired client watcher's contract exactly (aborted/max-tokens turns and killed jobs stay silent).
- **Delivery.** The sink pushes one `session/notify` frame (kind, dedupe `sourceKey`, and the question payload for local plan-review classification) onto the owner page's live mux streams only, each still passing its own session-visibility fence (subagent sessions reach only addressed streams). No owner or no live owner stream: dropped.
- **Client consumption.** `ui-sound` keeps its supplementary mux subscription but folds only `session/notify` frames; channel classification (subagent origin) and question-kind refinement stay local through the sessions list. The host loop and the `BroadcastChannel` cross-tab machinery are deleted — single-owner delivery subsumes both.

Adoption grants no capability beyond frame routing (`harniverse.observe`, a read effect): a page can only receive occurrences for sessions its own streams can already see.

## Consequences

- A session no adopting page still serves is silent by design: background sessions ring nowhere until some page opens them (owner-accepted tradeoff; the raw event stream still flows, so a future ambient surface can adopt without protocol change).
- `events.adopt` joins the required client face (`harniverse.observe`, effect `read`): the connection/runtime test doubles gained a stub — the same cost every new unary domain pays.
- Detection authority moves fully server-side; a stale client cannot opt out or ring for a session its page never adopted, and ui-sound's consumer is protocol-coupled to `session/notify` rather than the raw event vocabulary.
- Pages that never send a `page` token (non-browser remotes, scripts) keep today's behavior: they receive no notify frames at all.
- Adoption survives reconnects (the token re-binds on each mux reopen) but not a full page reload; the fresh token starts with no adoptions until the runtime re-declares on the next current change.

## Verification

`notify-detector.spec.ts` pins every fold rule; `api-proxy-notify.spec.ts` pins owner-only delivery, most-recent-declarer arbitration, stream-close fallback, the no-adoption drop (while raw events still flow), and whole-set replacement through a real proxy; the WebSocket and SSE carrier tests pin the `page` query on both carriers; the runtime tests pin adoption-on-current-change and silence without a token; the rewritten `ui-sound` suites pin the notify-frame consumer at full per-file coverage.

## Alternatives considered

**Keep client-side detection and add cross-browser arbitration.** Pages of different browsers share no channel that does not route through the host anyway; moving only arbitration would leave every page evaluating every event while the host answers "who may ring" — strictly more machinery than detecting once where the events originate.

**Deliver to every page and let clients filter by adoption.** Every page would keep receiving (and decrypting/classifying) occurrences for sessions it never opened, and a compromised or stale client could not be silenced server-side; routing at the delivery point enforces the owner's rule by construction.

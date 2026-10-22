# Agent Note: Viewing a subagent session must stream its live events

Status: implemented

English | [中文](2026-10-22-subagent-view-live-mux-stream.zh.md)

## Problem

Opening a subagent's session from the catalog rendered one history snapshot and then never updated, while the child kept running and the parent view streamed normally. A second failure hid behind the first: even a subagent stream that had been authorized went silent again after any connection regeneration, because no client cursor carried it into the new mux generation.

## Decision

The mux visibility rule is unchanged: a session with `origin: 'subagent'` streams only to principals that addressed it. What was wrong was the authorization point — only `subagents.prompt` registered the address, so a view-only open (`subagents.history`, the read plane every catalog click drives) never authorized anything and the mux filtered out every child event.

`subagents.history` now performs the same registration on its success path: once `catalogChild` verified the durable direct-parent address and the parent check passed, the principal's `addressedMuxAuthorizations` gains the child and every live mux queue of the same principal subscribes the child with full replay (`subscribeWithReplay(session, true)`), exactly the prompt-side dance. A view open is the read-side twin of a prompt: both prove the same durable address, and the authorization set was designed to accept exactly that proof.

On the client, `Session.syncCursor()` no longer excludes addressed sessions: an open subagent window offers its contiguous tail to `muxSince()`, so a reconnecting mux generation carries the child in `since`, the host's bootstrap replays the gap after that cursor, and the authorized child view keeps streaming across connection drops. The host-side bootstrap already read `since` for any visible session — the designed path was simply never fed from the client.

## Alternatives considered

**Authorize on `subagents.list` (the catalog fetch).** Rejected: the catalog proves the parent, not any particular child address; authorizing a whole catalog would stream every sibling a principal merely listed.

**Keep the client cursor exclusion and re-pull history on reconnect.** Rejected: an open addressed session is not in a loading/error state at reconnect, so nothing retriggers `subagents.history`; without a cursor the frozen-view bug returns after every connection drop.

## Consequences

- Clicking a healthy catalog child now renders a live session view: replay baseline (`session/subscribed`), then streaming events.
- A prompt-side authorized child and a view-side authorized child behave identically across reconnects.
- Authorization remains in-memory per principal and host process; a host restart drops it, which is correct because the host restart also stopped every child.
- `addressedMuxAuthorizations` still grows monotonically per principal within one host process — disposal removes per-mux membership, not the durable-address proof; bounded by the catalogs a principal can address.

## Testing

- `packages/host/apiproxy` — `api-proxy-subagents.spec.ts` gains the view-side twin of the prompt authorization case: open the mux first, call `subagents.history` with the same principal, and assert the `session/subscribed` baseline, the replayed event, and the live pushed event arrive on the stream.
- `packages/client/runtime` — the pinned cursor expectation flips: an addressed, open window now publishes its tail (`publishes its contiguous cursor for ordinary and addressed windows alike`), opened through the subagent history route.

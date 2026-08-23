# Agent Note: /api response encoding

Status: implemented

English | [中文](2026-08-23-api-response-encoding.zh.md)

## Problem

Every `/api` reply left the Host as verbatim JSON. Static assets negotiated Brotli and gzip, but the RPC carrier did not, so the largest transfer in the product paid full size on the network. A cold history page is dominated by settled `assistant/chunk` events: on a real 20,701-event page the reply was 3,655 KiB, and on the artifact a reader actually opened it reached 4,161 KiB.

Local measurement hid this completely. Over loopback that page rendered in about 1.8 s, while the same click over a real link took a reader 10 s, and an older session exceeded 30 s — long enough for the unary history timeout to surface as `The user aborted a request`. The bytes, not the backend read, were the remaining cost: the persistence read was 206-386 ms and wire serialization plus client schema validation under 0.14 s.

## Decision

The Host HTTP bridge negotiates `content-encoding` for buffered `/api` replies. Brotli answers a request offering `br`, gzip answers `gzip`, and anything else is sent verbatim. `content-length` always describes the bytes written, and every buffered reply declares `vary: accept-encoding` even when it is sent verbatim, so a shared cache cannot serve an encoded body to a client that never offered the encoding.

The bridge, not the Fetch handler, owns this. The handler stays transport-agnostic, so the in-process carrier that Electron and the test fixtures drive through `toFetchHandler` pays nothing for a transformation that only a network hop needs.

Three bounds keep the encoder from becoming its own bottleneck. Replies under 1 KiB stay verbatim, because below roughly one MTU the encoded body plus its header overhead saves no round trip. Encoding runs on the zlib thread pool rather than synchronously, because the Host answers every other request on the same event loop. Brotli quality is pinned below its default: on the measured page the default costs about 60 ms for a few percent more ratio, which moves latency from the network onto the Host.

Only `application/json` is buffered, and everything else streams through untouched. An allowlist rather than a streaming denylist: event streams must reach the browser frame by frame, the session-log ZIP export streams under its own capacity gate, and a future streaming content type must not have to be remembered here to stay correct. A token offered with `q=0` counts as refused, so a client that asks for no Brotli receives none. An upstream `vary` is preserved rather than replaced.

## Alternatives considered

**Compress inside the Fetch handler.** Rejected because it would encode for the in-process carrier too, where the bytes never cross a socket, and would put a transport concern in a transport-agnostic seam.

**Reduce the payload by dropping settled chunks from the wire.** Not chosen here, and recorded as rejected in [compaction-first session history](2026-08-22-compaction-first-session-history.md): plugin Definitions would receive a different Event window than persistence holds, and raw seq continuity would change. Encoding removes about nine tenths of the bytes without changing what any consumer observes.

**Brotli at its default quality.** Rejected on measurement: it converts network time into Host CPU time on exactly the request that is already the slowest, and the Host serializes other RPCs behind it.

**Synchronous encoding.** Rejected because concurrent per-session requests already queue behind history work on the event loop; `commands/list` and `session.models` were measured tracking the history request almost exactly despite returning about 1 KiB each.

## Consequences

A cold history page transfers roughly a tenth of its former size: 4,161 KiB became 385 KiB and 2,274 KiB became 213 KiB on the reader's own artifacts, measured in the browser under real Grant authentication. The reader-visible improvement scales with how slow the link is, which is why it was invisible in the loopback lane and decisive in the reader's own measurement.

The Host spends CPU it did not spend before, bounded by the pinned quality and moved off the event loop. A buffered reply materializes its body plus one encoded copy, bounded by whatever produced it; `maxRequestBodyBytes` bounds requests only and never bounded responses. Buffering is therefore an allowlist on `application/json` rather than an exemption for the one streaming type known at the time: the session-log ZIP export streams under a 64 KiB capacity gate specifically so the Host never holds a whole archive, and a denylist silently converted it into an all-or-nothing response that also re-compressed already-DEFLATEd entries. Any future streaming content type is now safe by default.

This does not reduce the Host CPU that a chunk-heavy page costs to serialize or the client CPU to parse and fold it. Those remain proportional to event count, so a page carrying about 20,000 settled deltas is still the most expensive click in the product.

## Verification

`packages/client/connection/tests/http-bridge.host.spec.ts` drives real replies through the bridge and decodes what the socket received. It pins Brotli and gzip selection, a verbatim body for `identity` and for an absent header, `vary` on every buffered reply, `content-length` matching the encoded bytes, the small-reply floor, `q=0` refusal, a preserved upstream `vary`, and both an event stream and an `application/zip` archive arriving chunk by chunk with neither encoding nor `content-length`.

Each assertion was mutation-verified against the defect it exists to catch: disabling the encoder reproduces the pre-fix behavior and fails; reporting the unencoded length fails; dropping `vary` fails; ignoring the `q` parameter fails; and replacing the allowlist with the original streaming denylist fails the archive case, which is how that defect was found.

Real-artifact measurement used the reader's own logs through the real browser app under `authentication: 'grant'`, completing device enrollment, owner approval, and signed challenge exchange rather than loopback bypass, and confirmed `content-encoding: br` with the sizes above.

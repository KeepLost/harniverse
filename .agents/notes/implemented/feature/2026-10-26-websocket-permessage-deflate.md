# Agent Note: permessage-deflate on the WebSocket event downlinks

Status: implemented

English | [中文](2026-10-26-websocket-permessage-deflate.zh.md)

## Problem

The connection plugin's two WebSocket downlinks (`/api/events.mux`, `/api/events.host`) and the remote-host bridge pumped every event frame uncompressed: session events, terminal output, and long assistant turns cross the wire as plain JSON text, so a chatty session pays full bandwidth on every frame. The wave-5 survey recorded official's WebSocket permessage-deflate (row 18) as a cheap absorb candidate, to be verified against our listener when the webserver was touched next.

## Decision

Enable `permessage-deflate` on the downlink pair behind a connection config key (owner decision 2026-10-26):

- `client-connection.websocketCompression: 'deflate' | 'none'`, default `'deflate'` — official's default. `'none'` accepts the same upgrades without the extension.
- With `'deflate'`, the `WebSocketServer` negotiates the extension offering `zlibDeflateOptions: { level: 1 }` — official's setting: asynchronous compression that stays cheap relative to frame JSON serialization, and a deflated write's completion still counts as peer activity.
- The Host compresses only its own outbound frames whose JSON text reaches 1,024 characters (official's threshold); shorter frames stay uncompressed because the per-message zlib header would outweigh them, and uplink frames compress at the peer's discretion. The threshold applies at all three send sites: the mux/host frame pump, the control-frame writer, and the remote-host bridge.

The wave-5 row-9 rider was verified while touching this surface: our browser cookie names already carry the scheme (`__Host-dsh_auth` on HTTPS with the `Secure` attribute, `dsh_auth` on HTTP), and sessions are opaque server-held values rather than signed audiences. A legacy-name cookie from an HTTP deployment cannot replay onto an HTTPS deployment because a different Host process holds a disjoint in-memory session registry, and one listener serves exactly one protocol, so an intra-deployment mixed-scheme host cannot occur.

## Alternatives considered

**Always-on without a config key.** Compression costs CPU on both ends for already-compressed payloads (base64 imagery rides the HTTP routes, not these sockets, but operator choice remains official's shape); the key keeps deployments with a local reverse proxy doing transport compression able to opt out.

**A lower threshold.** Official measured 1,024 characters as the crossover where deflate wins; following it avoids re-deriving the curve.

## Consequences

- Event streams negotiate compression when the browser offers it; browsers do by default, so the bandwidth win lands without client changes.
- Verification: four host-spec cases — extension negotiation on both downlinks when enabled, no negotiation when disabled, a large frame delivered intact through the compressed stream, and a bridged remote frame past the threshold — plus the full downlink suite (48 tests) and typecheck.

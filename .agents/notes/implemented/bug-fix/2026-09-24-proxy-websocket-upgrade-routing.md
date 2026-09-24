# Agent Note: The proxy dispatcher refused every WebSocket upgrade, including loopback CDP

Status: implemented

English | [中文](2026-09-24-proxy-websocket-upgrade-routing.zh.md)

## Problem

Node's global `WebSocket` resolves its transport through the same global-dispatcher symbol the [proxy policy](../../../../packages/util/http-proxy/README.md) installs, so an installed corporate proxy reached upgrades too. The dispatcher rejected any dispatch carrying `options.upgrade` before it classified the URL — on the theory that upgrades "never arrive from `fetch`" — so with `HTTP_PROXY` exported the browser panel's loopback CDP connection (`ws://127.0.0.1:<port>/devtools/browser/…`, made by [cdp.ts](../../../../packages/api/browser-controller/src/cdp.ts)) was refused outright. The panel broke exactly in the posture the proxy existed for: a corporate network where clearing the environment is not an option.

## Decision

Upgrade dispatches are classified by the same `proxyForUrl` answer as every other request before any upgrade-specific handling, and each classification serves the upgrade natively:

- **Bypassed, loopback, or policy-less with a displaced dispatcher** — the upgrade is delegated to the dispatcher the policy displaced, preserving Node's own direct transport when one exists.
- **Direct with no displaced dispatcher** — a native `http:`/`https:` upgrade request with `Connection: Upgrade` and `Upgrade: websocket` added; early frames the response may have already written are preserved by prepending them to the socket.
- **Proxied `ws:`/`wss:`** — one `CONNECT` tunnel to the origin, then the upgrade handshake inside it; `wss:` adds origin TLS with the origin's server name and normal certificate verification. Proxy credentials travel only on the CONNECT line, never to the origin.

Node's `WebSocket` passes header objects where `fetch` passes flat `[name, value, …]` arrays and `http:`/`https:` origins where the URL reads `ws:`/`wss:`; the transport normalizes both shapes. `onUpgrade` stays optional so existing HTTP-only handlers are unaffected, and the handler receives the upgraded socket with ownership transferred to the caller. Handshake failures, non-101 responses, aborts, and policy disposal close the pending sockets; disposal waits for in-flight handshakes to settle.

## Alternatives considered

Rejecting upgrades but exempting loopback first would have fixed CDP alone, leaving proxied `wss:` targets unreachable and the classification split across two code paths. Advising affected deployments to clear `HTTP_PROXY`/`HTTPS_PROXY` abandons the corporate egress the policy exists to serve. Adding an `undici` dependency for its proxy support contradicts the package's native, no-dependency contract and would strand the launcher's early install.

## Consequences

The proxy policy now covers Node's `WebSocket` with the same URL classification, bypass merging, and diagnostics-without-values rules as `fetch`, at the cost of one more transport arm (CONNECT-plus-TLS for `wss:`) and its handshake lifecycle. Upgraded sockets are per-connection and unpooled like every other hop; the "upgrade requests are refused on proxied routes" limitation is gone from the README.

## Testing

[install.spec.ts](../../../../packages/util/http-proxy/tests/install.spec.ts) drives a real HTTP upgrade server and a fake CONNECT proxy: loopback upgrades stay direct under an installed policy, proxied `ws:` tunnels through CONNECT to a 101, `wss:` verifies origin certificates over the tunnel, bypass lists hold, proxy auth reaches only the proxy, refusal and abort clean up their sockets, and the pre-fix dispatcher was reproduced failing both WebSocket cases before the fix landed.

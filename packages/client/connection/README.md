# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

Wire consumer layer: the client plugin's apply mounts `ctx.connection` (shared api client + current-page loopback state + observable generation-scoped `hostDescription` + single-consumer stream-loop starter); the export face carries the wire contract types, the `AbstractApiClient` abstraction, and the loop's sink/config types. Each successful readiness handshake publishes the exact `host.describe` value before `onConnected`; generation loss and explicit stop clear it, so native-capability consumers never retain a disconnected answer. The browser carrier uses HTTP POST for unary and respond operations and opens one downlink-only WebSocket each for `events.mux` and `events.host`; the in-process carrier satisfies the same two-stream abstraction. The Host half owns the single `/api` route and its Fetch bridge; a registered Typert interceptor claims its Remote endpoints before the API Proxy fallback. Loopback hostname classification stays package-internal: the `/api` Host fence and WebSocket upgrades use it directly, while other client plugins consume the derived `ctx.connection.isLoopback` state. The node half authenticates every network request, carries the accepted principal through HTTP and WebSocket dispatch, and checks each legacy or Typert endpoint's required capability before selecting a handler. Unknown endpoints and missing policy metadata are denied. Authentication bypass remains loopback-only and carries all capabilities. The platform carriers and ConnectionController loop are package-internal; apply selects and drives them. The downlink boundary is documented in the [WebSocket downlink carrier Agent Note](../../../.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md).

`hostDescription.bootId` identifies one API Proxy process lifetime. It stays stable across connection generations served by the same Host and changes after restart, so consumers can fence cached process-local state without treating a reconnect as a restart.

## /api browser-trust fence

The node half guards every entry under `/api` before bridging or upgrading (`src/api-request-trust.ts`). Every request, browser-marked or not, must present a `Host` that is loopback or matches a canonical `trustedHosts` authority; attached Origin and Fetch Metadata must describe a same-origin request unless the exact Origin is in `trustedOrigins`. Host trust remains mandatory for an explicit cross-origin Origin. This remains a DNS-rebinding and confused-deputy defense rather than authentication. The independent authentication Provider then verifies a short Access Token or browser session, and rejected HTTP or WebSocket admission never reaches RPC dispatch. A non-loopback listener requires direct TLS certificate and key configuration, while loopback may remain plain HTTP; HTTPS browser sessions use a Secure `__Host-` cookie and auth responses are not cacheable. Non-loopback compositions still declare the names they serve through derived LAN literals or `--trusted-host`; the Web profile prints effective trust policy and non-secret accepted/rejected connection markers. Decision records: [the api browser-trust boundary](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md) and [public-key Grant authentication](../../../.agents/notes/implemented/architecture/2026-08-17-public-key-grant-authentication.md) Agent Notes.

## `/api` WebSocket downlinks

`/api/events.mux` and `/api/events.host` each accept a WebSocket upgrade and send only the corresponding `ServerRequest` text messages to the browser; the client sends no application data over these sockets. Before each generation, `ConnectionController` samples the runtime's current per-Session contiguous cursors and the browser encodes a non-empty map in the mux URL's `since` query; the Host validates it before upgrade. If either socket ends, the current connection generation fails and rebuilds both streams from a fresh cursor sample; readiness still requires both sockets to be open and the `host.describe` HTTP call to succeed. Host teardown terminates both sockets, aborts their sources, and waits for source cleanup before returning. Ordinary network GETs to these paths return 426 with no SSE fallback; `toFetchHandler`'s SSE codec serves only the isomorphic in-process carrier.

## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The browser WebSocket inbox is not independently byte-bounded** — Host stream queues have a frame-count limit and reconnect from durable cursors, but one very large frame or a browser callback that permanently falls behind can still retain significant Client memory.
- **The `/api` bridge buffers each request body in memory** — `maxRequestBodyBytes` (default 160 MiB, sized for the default 100 MiB aggregate image limit after base64 expansion plus envelope headroom) is therefore also the per-request resident bound; a streaming body path would be needed to lower it without shrinking the image limits.

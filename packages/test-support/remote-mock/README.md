# `@deepseek-ai/dsh-remote-mock`

English | [中文](README.zh.md)

A programmable Connection-carrier mock for web-client unit tests: a real `AbstractApiClient` wire surface whose unary dispatch is keyed by the `RpcMethodMap`, hand-pumped SSE downlinks, a bypass authentication double, and a mount helper that boots the real `dsh-client-connection` plugin over them.

The carrier speaks the same JSON envelope, envelope echo verification, and `UNARY_VALUE_SCHEMAS` value parsing as the production transport, so a test that passes against the mock exercises the real client request/response path — only the network is replaced. Program handlers with `mock.on(method, handler)`; unprogrammed methods fail loud over an HTTP 500, and a thrown `RemoteMockRpcError` settles onto the `internal` RpcResult branch. Mux and host streams are driven by pushing frames into `mock.muxDownlink` / `mock.hostDownlink`, each opened downlink recording its `since` resumption cursor.

## Mount helper

`mountRemoteConnection(ctx)` provides `clientAuthentication` (the bypass double) and a `connectionCarrier` override, then applies the connection plugin unchanged, returning the mock, the double, and the mounted `ctx.connection` handle. Tests that need the full generation handshake drive `handle.start(...)` over the same mock carrier.

## Model Experience

None, as this carrier double substitutes the web transport without invoking a real model.

#### KV Cache effect

None; requests terminate inside the test process and never reach a provider cache.

## Known Limitations and Deferred Work

- **The two hand-written per-case fakes remain** — `packages/client/connection/tests/fake-api.client.ts` and `packages/client/runtime/tests/fake-api.client.ts` predate this package and serve fixture-shaped suites with deferred timing; converging them onto this carrier is deferred until those suites migrate.
- **No capability enforcement** — the mock does not evaluate `RPC_METHOD_CAPABILITIES`; authorization-denial paths need the in-process handler injection instead.

# @deepseek-ai/dsh-host-webserver

English | [中文](README.zh.md)

Web HTTP/HTTPS and upgrade-route registration plugin (default-exported `WebServer`, config `{host, port, compression?, compressionLevel?, compressionThresholdBytes?, tlsCertPath?, tlsKeyPath?}`): a Node server that listens on activation and provides `ctx.webServer`. `register(route)` adds a named `exact`/`prefix` request route; `registerUpgrade(route)` adds an upgrade route for an exact pathname. A duplicate path within either table throws because route patterns are a composition-level contract and a collision is a misconfiguration; both methods return a disposer that removes the registration. `registerFallback(handler)` registers the one handler for requests that match no named route. A second registration throws; the SPA dist server [`dsh-host-frontend-static`](../frontend-static/README.md) is the shipped owner, and the server returns 404 while none is registered. `tapIndex(transform)` adds an index.html transform, and `applyIndexTaps(html)` runs a body through the registered transforms in order; the fallback handler calls it on every index response. `port` reads the listening port, `host` reads the configured bind host, and `protocol` reports `http:` or `https:`. HTTP match order is fixed: exact over the whole table, then longest prefix, then the fallback handler. Upgrades match exactly and unmatched connections are closed; registration order carries no request-facing semantics.

`compression: 'gzip'` wraps socket-backed HTTP and HTTPS responses without changing route APIs: authentication, routing, and handler response ownership are untouched, and only the outgoing encoding changes. The client must prefer gzip and the media type must be compressible; known response lengths below `compressionThresholdBytes` stay identity, while unknown-length streams are eligible immediately. `compressionLevel` controls DEFLATE effort. Existing content encodings (including the pre-compressed static assets and the `/api` bridge's negotiated replies), `Cache-Control: no-transform`, range responses, and SSE stay unmodified. The shipped Web bundle enables level 1 with a 1024-byte threshold; other compositions default to `compression: 'none'`. Responses without a backing socket carry identity bytes.

The package knows no harness concepts and serves no files: the `/api` bridge and downlink WebSockets are routes owned by the connection plugin, plugin bundles and the HMR event stream are routes owned by the modules/hmr plugins, and dist serving belongs to the fallback owner. The upgrade handler owns the protocol handshake and connection contents; the webserver only delivers the raw socket and request. `host` accepts only `127.0.0.1` and `0.0.0.0`; an all-interfaces listener requires both TLS paths, while loopback may remain HTTP. The two TLS paths must be configured together and are read before listen. This server serves browsers only; Electron loads dist over `file://` and carries fetch over an IPC bridge. This package never prints; the URL line belongs to the shell.

A listen failure (EADDRINUSE…) throws out of activation and rejects Loader composition with the bind diagnostic; the failed candidate fiber is disposed. An HTTP request whose handling throws is answered 400 — or the socket destroyed when headers are already out — and logged as a warning; it never exits the process. A client that aborts while sending its request body ends quietly because no response remains to receive an error. An upgrade-handler exception or upgraded-socket transport error is logged as a warning and destroys its socket. Disposal starts `close()` and `closeAllConnections()`, destroys every tracked upgraded socket, and returns only after the HTTP server and those sockets have closed.

## Model Experience

None, as the package is a Web carrier between the browser and the HTTP/upgrade routes other plugins register; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **TLS policy is certificate-file based** — the server has no automatic certificate issuance, client-certificate authentication, or trusted-proxy protocol; deployments terminate TLS here with configured files or keep this listener on loopback behind their own proxy.
- **Socket options are fixed** — config selects the bind host and port, while backlog and other socket settings remain internal until a deployment needs them.

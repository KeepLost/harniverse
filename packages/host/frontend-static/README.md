# `@deepseek-ai/dsh-host-frontend-static`

English | [中文](README.zh.md)

SPA dist server for the Web shell: a function plugin (config `{distIndex, indexPaths?}`) that claims the [webserver](../webserver/README.md)'s single fallback seat and serves the built frontend directory through explicit page entries. The dist root, configured index file, and exact `indexPaths` render `index.html` with HTTP 200; an absent file or undeclared pathname returns an empty 404, traversal outside the dist root returns 403, unknown extensions ship as `application/octet-stream`, and non-GET/HEAD without a matching named route returns 405. Every index response runs through the webserver's registered index taps (`applyIndexTaps`), which is how the boot manifest reaches the page. `distIndex` and `indexPaths` are assembly facts: [`dsh-web-app`](../../bundle/web-app/README.md) resolves the frontend package's index and declares `/auth/manage`; a deployment does not infer page routes from arbitrary misses.

The fallback seat is single-owner (a second claim throws) and effect-scoped: disposing the plugin's fiber releases the seat, after which the unclaimed webserver answers 404.

## Model Experience

None, as the package serves browser assets; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The starter MIME table is minimal** — it covers the Vite-emitted asset set plus the shipped PWA manifest; other extensions fall back to `application/octet-stream` until an asset class actually ships.
- **Pathname routing is explicit** — a new History API pathname returns 404 until its composing application adds the exact `indexPaths` entry and real-composition coverage.

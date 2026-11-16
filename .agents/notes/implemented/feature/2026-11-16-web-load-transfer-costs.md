# Agent Note: Web load-path transfer costs — compressed, rev-cached plugin bundles and a content-addressed wallpaper route

Status: implemented

English | [中文](2026-11-16-web-load-transfer-costs.zh.md)

## Problem

A page open after login painted the shell quickly but left plugin-provided visuals — icon buttons, the settings surface, the wallpaper backdrop — arriving seconds to tens of seconds later, scaling with network speed. Two wire costs dominated:

1. `GET /plugins/<id>/client.js` served every registered bundle **raw** (`cache-control: no-cache`, no `content-encoding` path, no validators). Fifty-nine bundles totalling 6.24 MB crossed the wire uncompressed on **every** load — `no-cache` without an `ETag` cannot revalidate, so nothing was reusable — while Brotli over the same bytes measures 1.24 MB (5.0×). The bootstrap aggregates and the shell chunks were already compressed and immutable, which is exactly why the login gate itself felt fast and only the plugin layer lagged.
2. Wallpaper bytes (up to 8 MiB each) traveled as base64 inside the `skinLibrary/readWallpaper` RPC — no HTTP caching, so every reload refetched the full payload even though every wallpaper has a content address that pins its exact bytes.

## Decision

- **Compress and rev-cache the plugin bundles** (`@deepseek-ai/dsh-client-modules`). The route now resolves the table record, reads the bundle once into an `EncodedArtifact` (`plain` + async-filled `br`/`gzip`, the same off-main-thread `fillEncoding` the bootstrap aggregates use), and serves Brotli-preferred responses with `vary: accept-encoding`. A request whose `?rev=` matches the composed row is content-addressed by definition (the rev is the bundle's sha1 content hash), so it answers `private, max-age=31536000, immutable`; a missing or stale rev — a manual fetch, an HMR rebuild mid-flight — stays `no-cache` and nothing stale is pinned. Artifacts are retained per `id\0rev` in a FIFO-bounded map (96 entries), so HMR generations churn without unbounded growth. Source maps keep their `no-cache` JSON path.
- **Move wallpaper downloads to `GET /skins/wallpapers/<sha256>`** (`@deepseek-ai/dsh-host-skin-library`), behind the same Connection trust fence and `harniverse.observe` admission as the plugin-bundle route. The store grew `readWallpaperBytes` (same hash-and-signature verification); the route serves the verified bytes with `private, max-age=31536000, immutable` — a replaced wallpaper gets a new hash and therefore a new URL. The `readWallpaper` Remote and the `WallpaperContent` type are deleted: the route is the only download surface, and `ui-skin` now fetches a `Blob` directly (its `WallpaperUrlCache` lost the base64 decode step). The wallpaper hash setting lives in the page-authority settings store, so serving bytes from the page authority also stops a selected remote machine from blanking a locally-chosen backdrop.

## Alternatives considered

- **Compression middleware only** (`compression` on the webserver): leaves the `no-cache` refetch in place — repeat visits would still move 6.24 MB — and does not cover the `/plugins` route's handshake. Rejected as half the fix.
- **`ETag` revalidation instead of immutable caching**: converts repeat loads to 304 round-trips (59 requests) instead of zero. The rev already in the URL makes immutable the strictly better contract.
- **Browser-side Cache API for wallpapers**: `caches` requires a secure context; harniverse is routinely served over plain HTTP on LAN addresses, where the feature would silently vanish. The server route works everywhere the page loads.
- **Keeping `readWallpaper` as a fallback Remote**: no consumer remained, and a dead RPC that can ship multi-megabyte base64 payloads is exactly the unused public surface the package rules retire.

## Consequences

- Repeat page loads move ~0 bytes for the plugin layer (immutable cache hits); first loads move ~1.24 MB instead of 6.24 MB. Wallpaper reloads are cache hits; first paints fetch the raw image once.
- HMR keeps working: a rebuild changes the rev, the graph row URL changes with it, and old-rev requests degrade to `no-cache` rather than pinning stale bytes.
- Compositions that expose the webserver without the Connection service (none ship today) register the index-tap bootstrap but not the wallpaper route; the `ui-skin` fetch then sees a 404 and renders no wallpaper, the same degradation a missing library had before.
- The skin-library Remote surface shrinks to five methods; the typert contract, `api-remotes` type re-export, and both package READMEs move with it.

## Testing

- `packages/client/modules/tests/node-half.client.spec.ts`: bundle brotli/gzip/identity arms, rev-matched immutable vs stale/missing `no-cache`, HEAD without body, compression-failure plain fallback, unknown-resource 404.
- `packages/host/skin-library/tests/loader-composition.spec.ts` boots a real composition (webserver + connection stand-in) and asserts the route over HTTP: bytes, mime, immutable header, HEAD, 404 for malformed/missing/trailing addresses, 405, Connection-gated 403, plus 404 after removal.
- `packages/client/ui-skin` specs drive the controller through a stubbed `fetch` (blob, 404, rejected transport) and the reference-counted URL lifecycle unchanged.
- Real-browser coverage: the existing `skin.e2e.ts` wallpaper scenario (upload → paint → reload → paint) exercises the new route end to end.

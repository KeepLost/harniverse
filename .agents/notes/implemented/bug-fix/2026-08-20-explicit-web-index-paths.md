# Agent Note: Explicit Web index paths and 404 static misses

Status: implemented

English | [中文](2026-08-20-explicit-web-index-paths.zh.md)

## Problem

An unconditional SPA fallback makes every unmatched GET or HEAD request look successful. Broken links and missing JavaScript, stylesheets, source maps, manifests, or API-like paths then receive the HTML shell with status 200, so browsers, caches, and monitoring cannot distinguish a declared page entry from an absent resource.

Harniverse also has one pathname-based browser entry: an authenticated owner opens `/auth/manage`. Returning 404 for every path except `/` and `/index.html` would fix static misses by breaking that management surface.

## Decision

`dsh-host-frontend-static` renders `index.html` only for the dist root, the configured index file, and exact `Config.indexPaths` entries. `dsh-web-app` owns the current route composition and declares `/auth/manage`; the generic static plugin does not know authentication paths.

Existing files are served normally. `ENOENT`, `EISDIR`, and `ENOTDIR` produce an empty 404; other filesystem failures reach the Webserver request-failure handler. A missing index produces the same 404 for every declared page entry. GET and HEAD retain matching status semantics.

## Alternatives considered

- **Return the shell for every extensionless path.** Unknown ordinary and API-like paths would still appear successful, and extension syntax does not declare a browser route.
- **Use `Accept: text/html`.** Representation preference does not authorize a pathname as a page entry; bots and invalid browser requests can send the same header.
- **Hardcode `/auth/manage` in `frontend-static`.** That would make a generic Host plugin own a Harniverse authentication composition decision.

## Consequences

Missing assets and undeclared paths expose correct HTTP state. Every new History API pathname must be added by its composing application with real-composition coverage instead of inheriting a broad fallback.

## Verification

The frontend-static Loader composition covers declared index paths, GET/HEAD parity, missing assets, ordinary and API-like misses, a missing index, traversal, unsupported methods, compression, immutable caching, and fallback disposal. The web-app composition separately proves that `/auth/manage` renders the shell while a missing asset returns 404.

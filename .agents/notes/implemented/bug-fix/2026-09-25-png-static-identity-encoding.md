# Agent Note: Serve PNG assets without transport recompression

Status: implemented

English | [中文](2026-09-25-png-static-identity-encoding.zh.md)

## Problem

The full Harniverse artwork is a 777,299-byte PNG requested during authentication bootstrap. Computing both gzip and default-quality Brotli synchronously blocks other Host requests, including critical startup traffic. One local measurement spent about 2.48 seconds producing a 763,496-byte Brotli representation, a reduction of only about 1.8%. Non-hashed asset requests repeat that work.

## Decision

The [static frontend plugin](../../../../packages/host/frontend-static/README.md) serves `.png` files as their existing bytes regardless of offered transport encodings. It does not compute gzip or Brotli representations for PNGs. GET and HEAD retain the raw content length, `image/png`, and the existing pathname-based immutable-cache policy.

## Alternatives considered

**Increase the startup timeout:** Rejected because it conceals avoidable Host blocking while leaving users waiting for the same work.

**Cache or asynchronously recompress PNGs:** Rejected because it retains computation and representation storage for a small measured size reduction. Serving the already-compressed file removes that work without changing the approved artwork.

## Consequences

PNG transfers give up the small additional compression gain and avoid synchronous recompression on every uncached request. Other static asset types retain their encoding policy. The [explicit page-routing decision](2026-08-20-explicit-web-index-paths.md) and [API response encoding decision](../architecture/2026-08-23-api-response-encoding.md) remain independently applicable; neither is superseded by this asset-type rule.

## Verification

The real-Loader HTTP tests cover PNG GET/HEAD responses with Brotli, gzip, and identity preferences at both ordinary and hashed paths, including bytes, MIME, length, absent content encoding, and caching. The existing built-browser bootstrap test retains its five-second bound while deferred plugin delivery is held, and authenticated browser checks verify the original artwork loads correctly.

# Agent Note: Host-header authority audit — fence semantics pinned

Status: implemented

English | [中文](2026-09-06-host-header-authority-audit.zh.md)

## Problem

Upstream added Host-header validation to its web entry. Before absorbing the decision, this audit had to establish where Harniverse reads the `Host` header, what authority (if any) it derives from it, and whether any path lets a client-controlled `Host` value widen trust. The risk under audit: DNS rebinding and request-smuggling style attacks where a forged `Host` names a deployment-declared authority and thereby skips authentication or gains a privileged decision.

## Decision

No product code changed: the audit found the fence already correct, and one pinning test was added. Findings, each verified against source:

- The only authority-relevant `Host` read is `isTrustedApiRequest` (`packages/client/connection/src/api-request-trust.ts`), enforced at every browser-facing entry: the `/api` route and both WebSocket upgrade paths (`src/index.ts`), the browser-auth routes (`src/browser-auth-routes.ts`), and the RPC host (`src/rpc-host.ts`). The webserver itself never reads `Host` beyond transport-level concerns (accept-encoding, content-type, idempotency-key).
- The fence is fail-closed and deny-only: a request passes only when its `Host` is loopback (any spelling) or matches a deployment-declared `trustedHosts` entry (exact `host:port`, or any port on a port-less entry, through WHATWG normalization). An absent, malformed, or undeclared `Host` is refused with 403 before authentication runs.
- A passing fence grants nothing: authentication (`authenticateIncoming`) runs after the fence on every path, and the loopback authentication bypass is keyed to the listener bind (`src/index.ts`: bypass is refused unless the listener itself is bound to `127.0.0.1`, a socket-level property no header can forge), not to the `Host` header. No code path derives authority from `Host` or `X-Forwarded-Host`; the repository contains no forwarded-header reads at all.
- The pinning test added here (`node-half.host.spec.ts`, "holds a declared trustedHosts entry at the fence: a forged Host authenticates nothing") locks the separation: a raw client claiming a declared authority's `Host` with no credentials still receives 401, while the pre-existing tests pin the order (valid credentials + untrusted Host → 403 first; loopback Host + no credentials → 401).

## Alternatives considered

**Port upstream's Host-validation implementation verbatim.** Rejected: upstream's check defends the same rebinding class that `isTrustedApiRequest` already refuses, with stricter WHATWG-normalized matching and explicit config-boundary asserts on `trustedHosts` entries (`assertTrustedAuthority` refuses paths, credentials, whitespace padding, dangling colons, and non-canonical spellings that would silently broaden a grant).

**Derive trust from the peer address instead of headers.** Unnecessary: the listener-bind rule already ties the authentication bypass to a loopback socket, and the fence treats headers as deny-only, so no additive defense is missing.

## Consequences

The upstream Host-header validation decision is closed as already-absorbed-by-equivalent-design: Harniverse keeps `isTrustedApiRequest` as the single fence, and the audit trail (this note plus the pinned test) documents why no further change is needed. The added test passed on first run — it pins an existing property rather than fixing a defect, consistent with an audit deliverable. Evidence: full `node-half.host.spec.ts` suite 32/32 green; the twelve pre-existing fence cases in `api-request-trust.host.spec.ts` remain unchanged and green.

# Agent Note: Shared browser authentication lifecycle and read-only status

Status: implemented

English | [中文](2026-09-08-browser-authentication-lifecycle.zh.md)

## Problem

An admitted event WebSocket can continue delivering model chunks after the browser Cookie ceases to admit new HTTP requests. Treating HTTP 401 as an ordinary transport exception leaves the page apparently connected while sends fail. A renewal timer alone cannot coordinate foreground requests, wake-up races, cancellation, and credential replacement. A status renderer must not become the owner of authentication work.

## Decision

The [client authentication capability](../../../../packages/client/authentication/README.md) owns one renewal runtime per page. Its Cordis Service Definition and Provider adopt the exact instance created by the lightweight authentication entry. The shell passes it through a static module closure, not Loader configuration, because configuration evaluation is for data rather than live class instances. Admission still precedes protected plugin loading. The bootstrap authentication Provider, module-system adoption entry, and app-shell assembly are explicit kernel infrastructure; business composition remains Host-authored.

Connection routes protected HTTP and status-less carrier recovery through that capability. Only a Host pre-dispatch 401 carrying `x-dsh-authentication: required` authorizes one retry; 403, uncertain writes, network exceptions, and one-shot request streams never acquire automatic replay. Existing expected-principal checks remain in force. Concurrent recovery shares one exchange, caller cancellation leaves other waiters intact, and late failures cannot retract a newer credential. Stop drains an exchange before logout may clear its Cookie. Definitive authentication failure publishes a refresh instruction instead of reloading the page.

Transport liveness remains owned by Connection. Its health observable derives a stable primitive from the active transport state and authentication snapshot; an open downlink does not override refresh-required authentication. The [status plugin](../../../../packages/client/ui-connection-status/README.md) occupies the sidebar-owned `sidebar.header.status` root slot, using declaration injection and framework-bound observable hooks. Expanded placement is between the wordmark and toggle; the collapsed rail puts the read-only icon below the combined logo/toggle. Hover or focus explains the state, including a manual refresh instruction. The icon owns no network operation or renewal timer.

The documents the gate renders — the pairing page and `/auth/manage` — carry their own styling, because they paint before any plugin bundle is fetched. The shell owns two sheets for them: `document.css` (the design tokens plus the document reset, imported by the app entry and the gate alike) and `auth.css` (everything only these documents draw). Neither derives a colour scheme: ui-theme's index tap already resolved the durable preference onto the body attribute the token sheets key their dark set on, and it transforms every document the frontend serves, `/auth/manage` included. A gate that re-derived the scheme from the OS would silently downgrade a stored `dark` preference on every boot passing through it, an authentication-bypassed one included.

This partially extends the [public-key Grant decision](2026-08-17-public-key-grant-authentication.md), whose enrollment, authority, revocation, and credential bounds remain authoritative. The [WebSocket carrier decision](2026-08-04-websocket-downlink-carrier.md) remains unchanged: HTTP upstream and two downlink-only event sockets share one application protocol.

## Alternatives considered

**Refresh automatically on every 401.** This destroys page-local work and conceals whether authentication is recoverable or authorization has been revoked. Refresh is an explicit user instruction only after automatic recovery cannot continue.

**Let the indicator run renewal.** Conditional rendering, sidebar collapse, and plugin reload would then alter authentication lifetime or create duplicate renewal chains. The indicator consumes service state only.

**Move every operation to a full-duplex WebSocket.** This expands the change into request correlation, cancellation, and uncertain-write recovery without removing the need for one authentication owner.

**Retry every failed request.** A timeout or connection loss does not prove that a mutation was never executed. The Host's pre-dispatch refusal is the narrowly defined replay authority.

## Consequences

Authentication recovery is shared by foreground requests and connection maintenance without extending credential lifetime or weakening Host admission. The added capability and renderer are independently owned; hiding the renderer cannot stop renewal. Observations contain no credential material. Cookie changes outside a page remain observable only at a request or connection check, and page-local coalescing does not introduce cross-tab leader election or an offline send queue.

Unit tests exercise renewal, shared recovery, cancellation, terminal refusal, late responses, safe upload retry, ownership disposal, and read-only rendering. The authenticated Chromium composition removes a live Cookie, verifies a refused send is accepted exactly once without navigation, then revokes the Grant and verifies the refresh tooltip and preserved draft. This demonstrates the recovery defect independently from the still-unidentified trigger of the original user's Cookie failure.

# Agent Note: Business admission never rate-limits unknown credentials

Status: implemented

English | [中文](2026-10-26-restart-admission-lockout.zh.md)

## Problem

An operator's server was hard-rebooted after an unrelated memory exhaustion. After the restart, paired devices kept receiving `invalid-credential`, then `rate-limited`, and no browser could get in; restarting again repeated the lockout.

The incident reproduced with the real `dsh web` composition: two paired devices with five open tabs, the Host killed with SIGKILL and relaunched on the same home. Within ten seconds the tabs' reconnects presented ten unknown browser-session Cookies on the `http-api` channel from `127.0.0.1`, reaching the default `authFailureLimit` of 10. The provider then blocked that channel and peer for `authFailureBlockMs` (5 minutes). Every tab had already signed a fresh exchange and held a valid Cookie, but the block was checked before the credential, so 207 valid requests were refused until the block lapsed about 5 minutes 20 seconds after the restart. Every device behind one address shares that bucket, and each restart repeats it.

Three defects combined:

- Admission counted unknown browser sessions and Access Tokens as guessing. Both live in process memory, so a restart makes every value the previous process issued unknown at once; reconnect traffic from four tabs alone exceeds the limit. Both are 256-bit server-issued secrets, so counting them protects nothing. The counter dates from the [inbound network authentication note](../../archived/feature/2026-08-16-inbound-network-authentication.md), when credentials were operator-entered named tokens; the public-key Grant redesign removed every guessable secret from the admission path but kept the counter.
- The block was consulted before verification, so a valid credential was refused together with the invalid ones.
- `/auth/status` reported a rate-limited check as `200` with `authenticated: false`, so the page took it for a dead Cookie and signed another exchange, and the status icon showed only a reconnecting state.

## Decision

`LocalAuthentication.authenticate()` counts no failures and applies no block. An unknown, malformed, or expired browser session or Access Token is always `invalid-credential`; a valid one is admitted whatever its peer presented before.

The failure limiter (`authFailureLimit`, `authFailureWindowMs`, `authFailureBlockMs`, `maxAuthFailureKeys`) covers only the two operations that verify a guessable input: invalid browser-login proofs, keyed `browser-login:<peer>`, and invalid invitation redemptions, keyed `invitation-redeem:<peer>`. Config keys and defaults are unchanged; their documentation names that scope.

`/auth/status` answers a `rate-limited` admission decision with `429`, `Retry-After`, and `no-store`, as the connection Consumer's other routes do. The local provider no longer produces that decision for admission, but the Service Definition still permits it, so the status route must not translate it into "not authenticated". The browser's `check()` raises on a non-OK status instead of starting an exchange.

## Alternatives considered

**Verify first, then consult the block.** A valid credential would be admitted, but invalid ones would still change from 401 to 429 during the block. That gains no security, because a 256-bit value cannot be guessed either way, and the counter would remain an alarm that every restart trips.

**Raise the default limit.** Reconnect traffic scales with open tabs and with devices behind one address, so a legitimate deployment can reach any fixed threshold, while unguessable values need no threshold.

**Persist browser sessions across restarts.** Rejected for the original note's reasons: it adds another secret-bearing durable format, and a signed re-exchange already restores admission within seconds.

**Key the limiter on a forwarded client address.** Trusted-proxy handling remains out of scope, and per-client buckets would not remove the false positive.

## Consequences

- A Host restart costs each tab one signed exchange; every tab of every device behind one address recovers within seconds.
- Guessing against business admission gains nothing. Access Token secrets and browser sessions carry 256 random bits each, and an unknown value is rejected from process memory without a registry read, so unlimited invalid admissions add no cost beyond the access record each request already writes.
- Browser-login proofs, ECDSA P-256 signatures over single-use challenges, and invitation tokens keep their per-peer limiter. Reconnect traffic never reaches that limiter, so a restart cannot trip it.
- An operator who raised `authFailureLimit` as a stopgap for this incident should remove the override after upgrading; it now only weakens login and redemption limiting.

## Testing

- `packages/auth/authentication-local/tests/runtime.spec.ts`: with `authFailureLimit: 2`, one peer presents twelve unknown bearer and session values across all three channels, and each is `invalid-credential`; a freshly exchanged browser session and Access Token from the same peer are then admitted. Before the change the third value was already `rate-limited`. The test replaces the one that pinned bearer lockout.
- `packages/auth/authentication-local/tests/failure-containment.spec.ts`: the window-lapse and key-table-bound tests drive invalid browser-login proofs.
- `packages/client/connection/tests/browser-auth-routes.host.spec.ts`: `/auth/status` answers a rate-limited decision with `429`, `Retry-After: 3`, and `no-store`.
- `apps/web/tests/authentication-restart.e2e.ts`: the authenticated Web composition with `authFailureLimit: 2` pairs two Chromium devices with two tabs each, tears the Host down, and relaunches it on the same home and port. Every tab returns to "Connected; authentication is valid", and the access log after the restart holds more `invalid-credential` records than the limit and no `rate-limited` record. Before the change the same run refused 64 requests as `rate-limited`, and no tab recovered within 45 seconds.

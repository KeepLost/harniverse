# Agent Note: web_fetch follows redirects within a bounded, per-hop-validated budget

Status: implemented

English | [中文](2026-10-24-web-fetch-redirect-following.zh.md)

## Problem

Since the [safe web defaults](../architecture/2026-08-30-agent-profile-capability-defaults.md), the local HTTP fetch provider has rejected every redirect: `maxRedirects` was fixed at zero, any 3xx response raised `WEB_REDIRECT_BLOCKED`, and the error message did not name the target URL. Real pages depend on redirects constantly — `http`→`https` upgrades, `www` canonicalization, domain migrations, short-link services — so the model received an unactionable error where a normal fetch should have landed. The official upstream has carried a bounded same-origin following design since our fork baseline; the fixed denial was a Harniverse-only tightening that traded real capability for security the transport checks already provide.

## Decision

Follow redirects within a bounded budget, cross-origin included. Every hop re-runs the complete validation a direct request gets: the `Location` header resolves against the responding URL, `validateFetchUrl` re-checks URL hygiene (scheme, credentials, length), and `requestOnce` re-runs literal-scope checks, DNS-answer validation, and public-address pinning. Cross-origin targets are followed because the request is anonymous — no cookies, credentials, or session exist to forward (the [web packages rule](../../../packages/web/AGENTS.md) rejects redirects on credential-bearing provider requests, which this is not), and the SSRF defense lives in the per-hop address checks regardless of origin. `maxRedirects` defaults to `5` (the upstream precedent), is configurable, and `0` follows nothing; exceeding the budget raises `WEB_REDIRECT_BLOCKED`, a redirect without a usable `Location` raises `WEB_PROVIDER_ERROR`, and every throw cancels the response body first so no socket leaks. The fetched result reports the final URL actually served, so citations cannot misattribute the content's origin.

This deliberately departs from the upstream same-origin restriction: upstream's cross-origin error message names the target and invites a manual retry, so the same model reaches the same target through the same tool and the same per-hop checks one turn later — the restriction buys no defense in an agent context, only an extra tool call. Recorded as a Harniverse downstream decision.

## Alternatives considered

**Keep the fixed denial.** Preserves the status quo at the continuing cost described in the Problem; no invariant requires it.

**Adopt the upstream same-origin policy verbatim.** Would still break `www` canonicalization, short links, and domain migrations, and the manual-retry escape hatch shows the restriction adds no protection here.

**Follow without a hop budget.** A redirect loop would consume requests until timeout; the budget bounds cost deterministically.

## Consequences

- `web_fetch` lands on real pages within the default five hops; longer chains fail with a clear budget error instead of an unactionable denial.
- Operators can restore no-following by configuring `maxRedirects: 0` — a valid setting, not an error.
- The provider's loop skeleton stays aligned with upstream `followAndRead`; only the `isSameOrigin` check is absent, keeping future upstream syncs small.
- Every security invariant is retained: per-hop URL hygiene, public-address and DNS validation, IP pinning, byte/character/time caps, and anonymous requests.
- The [capability defaults note](../architecture/2026-08-30-agent-profile-capability-defaults.md) statement "`maxRedirects` is fixed at zero" is superseded by this note; the rest of that note stands.

## Testing

`packages/web/web-fetch-http/tests/fetch-http.spec.ts` covers: following a same-origin redirect with a relative `Location`; following a cross-origin redirect and reporting the final URL; budget enforcement (the sixth hop is rejected, target untouched); `maxRedirects: 0` contacting no target for every 3xx status; a redirect without `Location` as `WEB_PROVIDER_ERROR`; a redirect to a literal private address rejected by `WEB_BLOCKED_URL` before transport; body cancellation on every redirect error path; and construction accepting `0`/`5`/`7` while rejecting fractional and negative caps. `packages/web/tool-web/tests/integration.spec.ts` proves the tool follows a cross-origin redirect end-to-end and renders `Fetched <final-url> (HTTP 200)`. Package suites: 187 tests green.

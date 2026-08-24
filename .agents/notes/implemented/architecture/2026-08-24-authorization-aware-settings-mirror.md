# Agent Note: Authorization-aware Settings mirror and principal-fenced unary transport

Status: implemented

English | [中文](2026-08-24-authorization-aware-settings-mirror.zh.md)

## Problem

Browser Settings consumers need the same Host description: the exposed namespaces, redacted layered values, schemas, revisions, writability, and local-document availability. Independent `settings.describe` calls duplicated that configuration-bearing response and gave each consumer a different pending-read, invalidation, failure, and stale-settlement policy. A registration, capability assembly, adapter, credential, or Profile topology change could therefore leave one surface current while another retained an older namespace set.

Authentication can also change while a unary request is crossing the wire. A browser Cookie may resolve to a different Grant revision by settlement time, and a reconnect may establish a new principal before an old response arrives. Client-only freshness counters cannot prevent the Host from dispatching a mutation under a principal different from the one that initiated it, while accepting an old settings or credential response can disclose one principal's authorized configuration state inside another principal's page. Model discovery is part of this boundary because its draft may carry an API key and ask the Host to probe a caller-selected endpoint.

## Decision

`dsh-client-ui-settings` owns one `SettingsDescribeMirror` for the authenticated connection and exposes it through `ctx.settingsScope.describe()`. Every namespace scope and full Settings surface derives from that shared Host response instead of issuing another description read. The mirror is a cache of an already authorized answer, not an authorization authority: the Host still selects exposed namespaces, redacts secret-role fields, reports writability, and enforces every read and write.

The transport projects each admitted principal to `AuthenticationPrincipalIdentity`: either `{ kind: 'bypass' }` or `{ kind: 'grant', grantId, grantRevision }`. Grant name, capabilities, expiry, browser-session material, and access credentials do not enter this identity. Grant id plus revision identifies the exact authorization generation; bypass is the explicit loopback-only admission identity established by the [public-key Grant authentication decision](2026-08-17-public-key-grant-authentication.md).

## Shared mirror and write folding

The mirror claims one pending `settings.describe` before it can publish `loading`. Every overlapping load or invalidation marks one rerun and joins the pending promise; settlement performs at most that one rerun before releasing the slot. This bounds concurrent reads without losing freshness requested while a read was in flight. An ordinary failure before the first success returns the mirror to `idle`; a later failure retains the last good view and records the diagnostic.

`settings/document-updated` and `settings/exposure-changed` refresh the mirror. The Host emits the exposure event when Settings registrations or descriptions change, including Profile-owned settings topology, and when capability assembly or LLM adapter topology changes. Models Settings separately rejoins credentials and provider-directory state on credential, adapter, and exposure invalidations. Authentication identity changes do not wait for those events: the connection source synchronously retracts the old identity and the mirror immediately clears its view and error, advances its principal and read generations, marks a pending read for rerun, and starts a new read only after another identity is available.

Namespace writes remain serialized per scope and carry the latest known namespace revision as `expectedRevision`. A successful `settings.mutate` returns a Host-redacted namespace view; the scope folds that view into the shared mirror, advances the read generation, and requests one rerun when a description is already pending. Earlier queued write settlements only advance the private revision used by the next queued operation; the latest write publishes. A failed or rejected latest write reloads the authoritative description. The fold never reconstructs a whole user section from redacted data, so path-addressed edits do not erase secret fields the browser cannot read.

## Principal-fenced unary transport

Every unary Host response carries the admitted `AuthenticationPrincipalIdentity`. Both event streams begin with the same identity before business frames. A connection generation becomes usable only after `host.describe`, the mux stream, and the Host stream agree on one identity; disagreement fails the generation. Later unary settlements must match both the identity captured at launch and the currently published connection identity.

If an old unary call settles after a newer principal has already been published, the client rejects that stale settlement without retracting the newer principal. A missing or mismatched identity on a settlement launched by the current principal synchronously retracts the current generation and enters the normal reconnect path. The Settings mirror adds its own principal-generation fence around reads, writes, and response folding, so even a fixture or direct consumer cannot publish an asynchronously settled value after the principal boundary moved.

Every unary method is classified as `read` or `mutate`. `AbstractApiClient` captures the current identity into `expectedPrincipal` for every mutating `ClientRequest`, and also adds it to every `ClientResponse` sent through `respond`. The Host compares that precondition with the principal admitted for the request before dispatching the business operation and returns `authentication-principal-mismatch` on disagreement. `llm.discoverModels` is deliberately classified as a mutation for this fence even though it does not persist state: it can carry a draft API key and cause a Host-side network probe. Reads omit `expectedPrincipal` because their response identity is validated before publication and they have no Host side effect to fence.

## Settings draft lifetime

Settings-derived stores clear synchronously when the mirror's principal generation changes. Namespace scopes drop values, base and user layers, revisions, and writability until the new authorized description settles. The Models Settings store also increments a public `principalGeneration`; the section keys its complete local-state subtree by that value, remounting editors and clearing provider drafts, typed credentials, endpoint probes, confirmations, and pending notices before the new principal's data can render. Old asynchronous callbacks test the same fence before changing UI state.

This clearing is intentionally stronger than ordinary refresh behavior. A transient read failure under one unchanged principal may retain its last good view, but an authentication change retains no Settings value or draft from the previous principal.

## Security boundaries

The browser mirror and its fences are defense in depth, not permission checks. API Proxy classifies `settings.describe`, Settings writes, credential operations, and secret-bearing discovery under `harniverse.administer`; the authenticated gateway denies callers lacking that capability. The explicit Settings exposure allowlist remains narrower than the Settings registry, and registering a namespace does not make it remotely readable or writable. These rules extend the [configuration-plane boundary](2026-07-30-config-plane-boundaries.md) rather than replacing it.

All Settings responses use `describe({ redactSecrets: true })` semantics. Secret values never ride the response; descriptors reveal only write-only secret paths and whether each is configured. A newly typed credential may ride only its intended outgoing credential, Settings, or discovery request, where the principal precondition is enforced before dispatch. The non-secret identity on envelopes is unsuitable as a capability claim, and client code never derives authorization from it.

## Alternatives considered

**Keep one description controller per Settings consumer.** Rejected because each controller would duplicate the same authorization-bearing payload and independently implement invalidation ordering, pending-read collapse, stale response fencing, and write convergence. A provider-owned mirror gives every consumer one answer and one lifecycle while namespace schemas and product policy remain domain-owned.

**Fence only in the browser.** Rejected because suppressing a stale UI settlement cannot stop a mutation from executing after the Cookie or browser session resolves to another principal. The Host must compare the initiating identity before business dispatch; browser generation checks remain necessary to prevent stale publication after that enforcement succeeds or a read settles.

**Abort every pending operation on authentication change.** Rejected as the sole mechanism because cancellation can race with Host dispatch and cannot prove that a response was produced for the current Grant revision. Identity comparison closes the race even when the carrier cannot cancel promptly; abort remains a lifecycle optimization rather than authority.

**Carry capabilities, Grant names, or credentials as the settlement identity.** Rejected because capabilities are authorization claims rather than stable identity, names are mutable display data, and credentials are secret and short-lived. Grant id plus revision names the exact durable authorization generation without exposing those fields; bypass needs only its explicit kind.

**Require `expectedPrincipal` on reads too.** Rejected because a changed read cannot mutate Host state, and every response already carries an identity that must match before its value is published. Pre-dispatch fencing is reserved for operations with Host effects, including secret-bearing endpoint discovery.

## Consequences

Settings consumers share one bounded read and converge successful writes immediately while preserving Host authority, explicit exposure, redaction, and revision conflicts. A burst of invalidations may coalesce intermediate revisions, but one rerun observes the latest Host state. The shared mirror also makes read failures common across Settings surfaces rather than allowing one surface to appear current by issuing a private retry.

Every unary carrier and stream handshake now carries non-secret principal identity metadata, and every new unary method must receive a correct read/mutate classification. Mutation authors gain a uniform pre-dispatch fence; misclassifying a Host effect as a read would omit it and is therefore a security-sensitive protocol error. Authentication changes deliberately discard unsaved Settings drafts, so a user may need to re-enter a provider endpoint or API key after reauthentication; preserving such drafts would cross a principal boundary.

Focused connection and API Proxy tests pin unary/stream identity agreement, current-principal mismatch invalidation, stale-settlement rejection without invalidating a newer principal, pre-dispatch mutation refusal, `respond`, and secret-bearing discovery. Settings mirror, integration, namespace-scope, Models, permission, and Agent Profile client tests pin one pending read plus one rerun, write folding and recovery, exposure invalidation, principal resets, synchronous draft remounting, and stale asynchronous settlement containment.

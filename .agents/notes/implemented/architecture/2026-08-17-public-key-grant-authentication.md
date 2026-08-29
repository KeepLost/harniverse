# Agent Note: Public-key Grant authentication and endpoint capabilities

Status: implemented

English | [中文](2026-08-17-public-key-grant-authentication.zh.md)

## Problem

Long-lived named bearer credentials admitted every caller as one logical user. HTTP authentication discarded the accepted identity before RPC dispatch, Typert Remote endpoints carried no authorization metadata, and a hardcoded legacy-method exception could be bypassed when an operation moved to Typert. Remote phones, temporary public computers, and automation also needed different persistence without placing one reusable bearer secret on every client.

## Decision

`dsh-authentication` carries an `AuthenticationPrincipal` through HTTP, legacy API Proxy, Typert Gateway, and WebSocket requests. Grant principals contain an exact Grant id and revision, expiry, and capabilities. The closed capabilities are `harniverse.observe`, `harniverse.operate`, `harniverse.administer`, and `harniverse.authorize`; profiles are management conveniences, never authorization inputs. `authorize` remains independent from administration, and `operate` includes agent execution whose selected preset may expose shell and filesystem effects.

Every network operation declares one capability. `RpcMethodMap` has a compiler-total legacy capability map. Typert decorators require capability options, the generator emits them, Loader and registry validation reject omission or unknown values, and strict or source-runtime Gateway claims expose the same policy to Connection. Connection resolves policy before handler selection; unknown, withdrawn, ambiguous, or unclassified endpoints are denied even on loopback. Explicit loopback bypass receives all known capabilities but does not bypass endpoint recognition.

Authentication uses the fixed `Enrollment -> Grant -> Access` lifecycle. Enrollment is a short pending public-key request and grants no API access. The local Provider bounds unexpired pending records globally and creation attempts per direct peer. Owner approval creates a durable P-256 Grant in `$DSH_HOME/auth/grants.json` and gives the browser a fresh bounded approval-receipt window, so approval near the pending deadline remains observable. A single-use challenge binds the instance id, Grant revision, purpose, nonce, issue time, and expiry; the client submits an IEEE-P1363 ECDSA/SHA-256 proof. Successful exchange produces a short process-memory Access Token or HttpOnly browser session. Access credentials cannot renew themselves, never exceed Grant capabilities, and disappear on process restart. Configuration caps Access and browser credentials at 15 minutes, challenges at 5 minutes, and pending or approved enrollment polling at 15 minutes.

Personal browsers retain a non-exportable WebCrypto private key in IndexedDB and renew their short session by signing another challenge, including after a reload with a still-valid Cookie. Renewal starts at half-life, bounds each signed exchange to ten seconds, retries transient failure with capped exponential backoff even after the previous Cookie expires, and wakes due work on focus, visible-tab restoration, or network recovery. A valid authenticated Cookie without a renewable personal-device key does not release the ordinary application. The lifecycle stays cancellable: logout aborts and drains an exchange already in flight before clearing any resulting Cookie. Temporary public-device keys stay in memory; their Grants exclude `authorize`, last at most 60 minutes, and use a 15-minute idle timeout. Issued credentials use the earlier configured, absolute-Grant, or idle-Grant deadline, so an open WebSocket cannot outlive temporary authority. API clients register a P-256 public key through local `dsh auth client add`; `GrantAccess` coalesces signed exchanges, invalidates in-flight publication on `clear()`, preserves `Request` semantics, and renews short credentials. An owner may issue a nonrenewable emergency token for at most 15 minutes with an explicit capability subset that excludes `authorize`.

`dsh-authentication-local` retains the sole per-home network-instance lease, mandatory privacy-minimal access log, bounded per-peer and per-Grant rate/capacity limits, atomic private-file writes, watch plus periodic reconciliation, and fail-closed behavior. Concurrent admissions are serialized as one event-loop cohort that shares a durable registry read and batched access-log operation while preserving one validation, decision, and JSONL record per request; accepted callers remain blocked until the cohort audit is durable. Exact Grant revocation clears matching challenges, Access Tokens, browser sessions, and WebSockets; socket admission also closes at principal expiry. Connection owns Cookie parsing and passes only the selected opaque browser-session value to the Provider. Unexpected RPC implementation failures are logged server-side and return stable generic messages. The browser Host/Origin/Fetch-Metadata trust fence remains independent, bypass remains loopback-only, and non-loopback Web serving still requires TLS.

Authenticated Web may start sealed with no Grants. The static shell can create an enrollment before browser plugins load; plugin bundles, plugin topology SSE, business HTTP, and event WebSockets require an authenticated principal with their declared capability. Local `dsh auth device approve <request-id> --profile owner` bootstraps the first active Grant and an owner remains required for the instance to be unsealed. Loss of the final active owner clears process credentials, rejects business admission, and closes event sockets until reconciliation observes a new active owner. An owner browser uses `/auth/manage` for later approvals, revocation, and emergency issuance. The standalone auth profile mounts no network Provider or WebServer.

The hard cut rejects `$DSH_HOME/auth/tokens.json`. It provides no migration, long-lived bearer compatibility, or recursive token-minting level. This decision fully supersedes the archived named-token [inbound network authentication decision](../../archived/feature/2026-08-16-inbound-network-authentication.md) while retaining its trust-fence, TLS, lease, access-log, and fail-closed requirements.

## Alternatives considered

**Durable bearer refresh tokens.** Rejected because possession alone would survive copying from a personal or public device. A durable server record plus private-key proof gives targeted revocation without storing a reusable renewal secret.

**Recursive token levels.** Rejected because credentials that mint equivalent credentials blur enrollment, approval, and use. The three fixed stages make each authority and lifetime explicit.

**Keep one privileged-method exception list.** Rejected because transport migration changes which dispatcher runs and can silently skip a legacy-only list. Required endpoint metadata and default denial place authorization before that choice.

**Introduce a dynamic authorization Service.** Rejected because current policy is deterministic principal claims plus one endpoint requirement. A second Service would add runtime topology without a current restriction or policy backend that needs it.

## Consequences

Remote compromise is bounded by a short credential and the durable Grant's capability and lifetime, but an active `operate` principal can still obtain code execution through shell-enabled presets. Public machines cannot be made trustworthy; memory-only keys and temporary Grants reduce persistence after departure.

All endpoint additions must classify their effect, and all Typert declarations must carry capability metadata. Future endpoint-, preset-, or workspace-specific restrictions extend Grant policy without changing the four effect classes. The assembled keyless Web test proves no plugin bundle loads before enrollment approval and signed exchange; focused tests pin challenge replay denial, exact revocation, expiry, capability denial, temporary limits, SDK renewal, audit rollback, and sealed startup.

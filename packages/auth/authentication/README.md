# dsh-authentication

English | [中文](README.zh.md)

Provider-neutral inbound authentication and authorization (`ctx.authentication`). An accepted HTTP or WebSocket attempt carries a principal with an exact Grant revision, expiry, and one or more capabilities: `harniverse.observe`, `harniverse.operate`, `harniverse.administer`, and `harniverse.authorize`. Network endpoints declare one required capability; missing metadata and insufficient principals are denied before dispatch.

The seam exposes public-key enrollment with stable overload decisions, single-use signed challenges, short Access Token and browser-session exchange, owner approval, Grant listing, and targeted revocation. `authentication/revoked` names exact Grant revisions so browser sessions, Access Tokens, and WebSockets tied to unrelated Grants remain active.

`authenticationPrincipalIdentity(principal)` projects only the stable, non-secret identity needed to bind transport generations: `{ kind: 'bypass' }` or `{ kind: 'grant', grantId, grantRevision }`. It never exposes the Grant name, capabilities, expiry, browser-session value, Access Token, or proof material.

## Credential lifecycle

Enrollment creates only a pending request. Owner approval creates a durable public-key Grant. A client proves possession by signing a challenge bound to the instance, Grant revision, purpose, nonce, and expiry. The Provider returns a short process-memory credential whose capabilities cannot exceed the Grant. Access Tokens cannot mint replacements; renewal requires another signed challenge.

## Model Experience

None, as authentication and endpoint authorization run before session or model operations.

#### KV Cache effect

None; principals, proofs, and credentials never enter model input.

## Known Limitations and Deferred Work

- Capability restrictions are effect classes; endpoint-, preset-, and workspace-specific restrictions are not defined.
- The seam does not own TLS; the shipped WebServer requires configured TLS for non-loopback listening.

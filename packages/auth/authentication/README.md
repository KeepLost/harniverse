# dsh-authentication

English | [中文](README.zh.md)

Provider-neutral inbound network authentication (`ctx.authentication`). Consumers submit normalized HTTP or WebSocket headers and receive either one accepted token revision or a stable rejection reason. Every accepted token belongs to the same logical Harness user; token names support management and audit records, not authorization, scopes, tenants, or session isolation.

`authentication/revoked` identifies token revisions invalidated by a committed registry change. Long-lived consumers close only connections admitted by those revisions; unrelated tokens remain active.

## Browser sessions

The seam verifies a token to create an opaque in-memory browser session and accepts its cookie on later requests. The provider owns session expiry and revocation; transport consumers own cookie attributes and the login/status/logout HTTP response format.

## Model Experience

None, as authentication admits external clients before they can invoke any session or model operation.

#### KV Cache effect

None; authentication material never enters model input.

## Known Limitations and Deferred Work

- The seam authenticates one logical user and intentionally defines no authorization or token scopes.
- The authentication seam does not own TLS; the shipped WebServer requires configured TLS for non-loopback listening.

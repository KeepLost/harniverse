# Agent Note: Process-wide inbound network authentication

Status: implemented

English | [中文](2026-08-16-inbound-network-authentication.zh.md)

## Problem

The Web surface can invoke agent tools and mutate host configuration, but loopback binding and the browser-trust fence establish reachability and confused-deputy defenses, not caller identity. A localhost process, LAN peer, or browser that reaches an accepted authority therefore needs one authentication decision covering HTTP and both WebSocket carriers without turning transport tokens into Harness users, tenants, or session boundaries.

## Decision

`dsh-authentication` defines one process-wide admission service. `dsh-authentication-local` stores named token digests under `$DSH_HOME`, acquires the sole network-instance lease before WebServer bind, creates bounded process-memory browser sessions, watches registry commits with periodic reconciliation, and writes privacy-minimal rotated JSONL access records. In authenticated mode, a watcher or registry-read failure rejects admission and closes current sessions and sockets until reconciliation succeeds; bypass does not depend on registry freshness. The Web composition selects authenticated mode by default; `--dangerously-skip-authentication` selects bypass mode but retains the lease, trust fence, and access records. Authenticated `--host 0.0.0.0` needs no bypass flag.

Every token represents the same logical Harness user. Names are non-secret management and audit labels; no token grants a scope, permission, tenant, or separate Harness session. Reset and delete publish the exact invalidated credential revision, so the connection consumer closes only matching browser sessions and WebSockets. Removing the final token seals a running process until `dsh auth token add <name>` restores admission, while an authenticated process with no initial token fails before listen.

The browser shell calls `/auth/status` and, when needed, `/auth/login` before it parses the boot manifest or constructs the module system. A successful login sets a process-memory-backed HttpOnly, SameSite=Strict cookie. Non-browser clients use Bearer tokens. Host, Origin, Fetch Metadata, media-type, and DNS-rebinding checks remain independent and run alongside authentication. TLS stays outside the Harness process, so remote plaintext transport is not a safe deployment for Bearer credentials.

This decision supersedes the unauthenticated all-interface assumption in the [explicit bind-address decision](2026-07-22-web-bind-address.md) and completes the authentication work deferred by the [browser-trust boundary](../architecture/2026-07-28-api-browser-trust-boundary.md).

## Alternatives considered

**One unnamed token.** Rejected because independent devices and automation need targeted rotation and deletion without disconnecting every other client; names provide that management identity without becoming authorization.

**Authenticate inside the generic WebServer.** Rejected because the carrier intentionally knows no Harness concepts. The authentication provider owns decisions and state, while connection consumers retain HTTP/WebSocket protocol handling and the existing request-trust fence.

**Persist browser sessions.** Rejected because restart invalidation is simple and safe, avoids another secret-bearing durable format, and the source token remains the recovery mechanism.

**Add authorization or per-token users.** Rejected because the product has one local logical user and shared runtime state. Treating token labels as principals would imply isolation the session, settings, plugin, and process layers do not provide.

## Consequences

All external HTTP API and WebSocket admission, localhost included, requires a valid credential unless bypass is explicit. Token values appear once on add/reset and never enter registries, logs, URLs, browser storage, or model input. Access-record failure turns an accepted admission into a rejection, while a committed token revocation still closes sessions and sockets when its secondary application record fails. The local provider adds owner-only files, watcher and lock lifecycle, rotation and session limits, and process-memory sessions; operators terminate TLS externally for untrusted networks.

Focused tests pin token management, permissions and rotation, lease mutual exclusion, sealed recovery, targeted registry events, targeted WebSocket closure, localhost 401 responses, cookie attributes, startup mode selection, and browser boot ordering. The assembled Web replay remains the product-level check for login before plugin startup.

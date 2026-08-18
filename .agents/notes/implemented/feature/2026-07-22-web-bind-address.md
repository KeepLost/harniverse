# Agent Note: Explicit web bind address

Status: implemented

English | [中文](2026-07-22-web-bind-address.zh.md)

## Problem

`dsh web` binds every network interface even when its browser runs on the same machine. Local use therefore exposes an unauthenticated development server without an explicit operator choice, while remote-container and LAN-browser use still needs a supported way to accept non-loopback connections.

The HTTP carrier also hides the bind address inside `startWebServer()`, so alternate shells cannot state their own network policy at the package boundary.

## Decision

`dsh web` binds `127.0.0.1` by default and accepts `--host 0.0.0.0` as the explicit all-interface mode only with paired TLS certificate and key paths. `--dangerously-skip-authentication` is restricted to loopback; the browser-trust fence, instance lease, and access records remain active there. All-interface mode prints HTTPS loopback and external IPv4 URLs. The [public-key Grant authentication decision](../architecture/2026-08-17-public-key-grant-authentication.md) owns this superseding security behavior.

`WebServer.Config.host` is required. The carrier passes that value to the selected Node HTTP or HTTPS server without supplying a fallback, leaving each shell responsible for choosing loopback or all interfaces within the schema's closed set.

## Alternatives considered

**Keep `0.0.0.0` as the default.** Rejected because ordinary same-machine use does not need network-wide reachability and should not acquire it implicitly.

**Use a boolean exposure flag instead of `--host`.** Rejected because `--host 0.0.0.0` names the resulting socket behavior directly and matches the underlying server option. TLS and authentication remain separate explicit controls rather than replacing the bind address.

**Default inside `startWebServer()`.** Rejected because the carrier has multiple possible shells and no basis for choosing their deployment policy. Requiring `host` makes the choice visible at every assembly call.

## Consequences

Local `dsh web` starts remain reachable at `http://127.0.0.1:3080`; a container or browser on another machine uses `dsh web --host 0.0.0.0 --tls-cert <path> --tls-key <path>` and enrolls a public-key device Grant. The CLI does not expose custom interface addresses or IPv6 modes. Provider and real-server tests pin loopback bypass, plaintext remote rejection, and direct HTTPS serving; the built Web smoke covers the assembled path.

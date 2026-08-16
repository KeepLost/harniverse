# Agent Note: Explicit web bind address

Status: implemented

English | [中文](2026-07-22-web-bind-address.zh.md)

## Problem

`dsh web` binds every network interface even when its browser runs on the same machine. Local use therefore exposes an unauthenticated development server without an explicit operator choice, while remote-container and LAN-browser use still needs a supported way to accept non-loopback connections.

The HTTP carrier also hides the bind address inside `startWebServer()`, so alternate shells cannot state their own network policy at the package boundary.

## Decision

`dsh web` binds `127.0.0.1` by default and accepts `--host 0.0.0.0` as the explicit all-interface mode under normal authenticated admission. `--dangerously-skip-authentication` selects bypass independently of the bind address; the browser-trust fence, instance lease, and access records remain active. All-interface mode keeps printing the loopback URL and, when available, the first external IPv4 URL. The [inbound authentication decision](2026-08-16-inbound-network-authentication.md) owns this superseding security behavior.

`WebServerOptions.host` is required. The HTTP carrier passes that value to `node:http` without supplying a fallback, leaving each shell responsible for its bind policy. Programmatic carrier consumers may select another hostname or address directly.

## Alternatives considered

**Keep `0.0.0.0` as the default.** Rejected because ordinary same-machine use does not need network-wide reachability and should not acquire it implicitly.

**Use a boolean exposure flag instead of `--host`.** Rejected because `--host 0.0.0.0` names the resulting socket behavior directly and matches the underlying server option. The supplemental acknowledgement names the independent absence of authentication rather than replacing the bind address.

**Default inside `startWebServer()`.** Rejected because the carrier has multiple possible shells and no basis for choosing their deployment policy. Requiring `host` makes the choice visible at every assembly call.

## Consequences

Local `dsh web` starts remain reachable at `http://127.0.0.1:3080`; a container or browser on another machine uses `dsh web --host 0.0.0.0` with a named token. Operators terminate TLS externally when the network is not trusted. The CLI does not expose custom interface addresses or IPv6 modes, while programmatic carrier consumers retain that flexibility. Provider tests pin authenticated and bypass mode selection independently from bind selection; the built Web smoke covers the assembled path.

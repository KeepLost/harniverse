# Agent Note: Explicit web bind address

Status: implemented

English | [中文](2026-07-22-web-bind-address.zh.md)

## Problem

`dsh web` binds every network interface even when its browser runs on the same machine. Local use therefore exposes an unauthenticated development server without an explicit operator choice, while remote-container and LAN-browser use still needs a supported way to accept non-loopback connections.

The HTTP carrier also hides the bind address inside `startWebServer()`, so alternate shells cannot state their own network policy at the package boundary.

## Decision

`dsh web` binds `127.0.0.1` by default. The CLI accepts `--host 0.0.0.0` as the explicit all-interface mode only when the same invocation includes `--dangerously-skip-authentication`; omitting that acknowledgement fails before the Web configuration activates. The acknowledgement changes no request policy: the browser-trust fence remains active and the carrier gains no authentication layer. All-interface mode keeps printing the loopback URL and, when available, the first external IPv4 URL.

`WebServerOptions.host` is required. The HTTP carrier passes that value to `node:http` without supplying a fallback, leaving each shell responsible for its bind policy. Programmatic carrier consumers may select another hostname or address directly.

## Alternatives considered

**Keep `0.0.0.0` as the default.** Rejected because ordinary same-machine use does not need network-wide reachability and should not acquire it implicitly.

**Use a boolean exposure flag instead of `--host`.** Rejected because `--host 0.0.0.0` names the resulting socket behavior directly and matches the underlying server option. The supplemental acknowledgement names the independent absence of authentication rather than replacing the bind address.

**Default inside `startWebServer()`.** Rejected because the carrier has multiple possible shells and no basis for choosing their deployment policy. Requiring `host` makes the choice visible at every assembly call.

## Consequences

Local `dsh web` starts remain reachable at `http://127.0.0.1:3080`; a container or browser on another machine requires `dsh web --host 0.0.0.0 --dangerously-skip-authentication`. Operators must supply network isolation or an authenticated ingress appropriate to their deployment. The CLI does not expose custom interface addresses or IPv6 modes, while programmatic carrier consumers retain that flexibility. Provider tests pin rejection without acknowledgement and publication with it; the built Web smoke boots the all-interface path and the default CLI path separately.

# Agent Note: web_fetch honors the operator's no_proxy destinations

Status: implemented

English | [中文](2026-10-15-web-fetch-no-proxy-destinations.zh.md)

## Problem

`web_fetch` ignored `no_proxy` for intranet destinations in two stacked ways. The bypass matcher (`bypassesProxy`) did not understand CIDR entries, so an operating-system-style `no_proxy=10.0.0.0/8,...` (which curl and Python requests honor) left every `10.x` literal routed through the proxy. And even where a bypass did match, `dsh-web-fetch-http` refused the destination anyway: `validateFetchUrl` rejected non-public address literals before any routing decision, and the direct arm's `assertPublicAddress` rejected every non-public DNS answer — so an operator could never admit their own intranet to the fetcher while a proxy was installed.

## Decision

**The operator's own bypass entries are the opt-in; CIDR entries match; the default-deny stands for everything un-named.** In `@deepseek-ai/dsh-http-proxy`: bypass entries now include IPv4 CIDR (`10.0.0.0/8`, `172.16.0.0/12`, `/32`, any port; malformed CIDR entries cover nothing), and a new pure `explicitlyBypasses` plus installed-policy read `operatorBypassed(url)` report whether an operator-written entry — not the loopback floor this package merges in, and not `*`, which names no destination — explicitly covers one URL. In `dsh-web-fetch-http`: the literal-IP scope check moved out of `validateFetchUrl` (which is shape-only again) into `assertLiteralScope(url, allowPrivate)`, and the provider passes `operatorBypassed(url)` through to it and to `assertPublicAddress`: a destination the operator named keeps the pinned direct path with its private addresses admitted, while everything un-named keeps the public-only default-deny, on both the literal and the resolved-DNS arms. The proxied arm is unchanged — a private literal with no operator entry is still refused before any hop, and a proxied fetch never resolves locally.

## Alternatives considered

**Allowing private addresses whenever any proxy policy is installed.** Rejected: an installed proxy says nothing about which intranet hosts the operator wants the model to reach; `no_proxy` is the list the operator actually wrote, per-destination.

**Honoring the loopback floor as an opt-in too.** Rejected: the floor entries (`localhost`, `127.0.0.1`, `::1`, `[::1]`) are merged by this package by design, so their presence carries no operator intent; only entries the operator wrote count (a non-floor spelling like `127.0.0.2` still does).

**CIDR for IPv6.** Deferred: rare in `no_proxy` lists and costly to parse; the entry simply covers nothing, as before.

## Consequences

With `HTTP_PROXY` set and `no_proxy=10.0.0.0/8,.corp.internal`, `web_fetch` now retrieves `http://10.1.2.3/…` over the pinned direct path and resolves `wiki.corp.internal` to its real private address, while public destinations keep tunneling and un-named private destinations keep failing closed with `WEB_BLOCKED_URL`. Every consumer of `bypassesProxy` (global dispatcher routing, WebSocket upgrades, web-fetch) now agrees with curl-style CIDR lists. `validateFetchUrl` no longer rejects private literals — callers depending on that behavior must call `assertLiteralScope`, as the provider does.

Verification: `policy.spec.ts` covers CIDR matching (range bounds, any-port, name/IPv6 non-match, malformed entries) and `explicitlyBypasses` (floor and `*` excluded, ports honored); `install.spec.ts` covers `operatorBypassed` under an installed policy; `fetch-http.spec.ts` covers the shape-only `validateFetchUrl` and the `assertLiteralScope` arms; `proxy.spec.ts` drives the provider end to end (named private literal fetched direct, un-named literal refused, named host resolved to a private address admitted).

# Agent Note: Anthropic ambient auth ranks the API key before the bearer token

Status: implemented

English | [中文](2026-10-01-anthropic-ambient-key-precedence.zh.md)

## Problem

An `anthropic` route naming no `apiKeyEnv` defers to pi-ai's ambient discovery, whose resolver reads `ANTHROPIC_AUTH_TOKEN` before `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` and sends it as `Authorization: Bearer`. An environment exporting both — common where Claude Code and other clients share one shell — authenticated harness requests with the bearer token while OpenCode and the official SDK send the key as `x-api-key`. A gateway that validates any bearer it receives (observed: `401 客户端认证失败` from a relay accepting the same environment's `x-api-key`) rejected every harness request, and the remote-host materialization pinned the same bearer form onto synchronized hosts.

Separately, a relay fallback path emitted Responses SSE events without blank-line separators; the OpenAI SDK joined the frames and threw `Unexpected non-whitespace character after JSON at position …`, which classified as the non-retryable `PI_AI_ERROR`.

## Decision

- `routeAuth` wraps the installed `anthropic` catalog resolver (`anthropicKeyFirst`): while `ANTHROPIC_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is set, `ANTHROPIC_AUTH_TOKEN` is invisible to it; alone, the bearer token still authenticates. pi-ai's own resolution, stored-credential path, and header construction are otherwise untouched.
- The materialization probe walks the provider's ambient names through the same `ambientNamesInPrecedence`, so host and synchronized remote pick the same credential.
- `classifyPiAiError` maps JSON-frame parse failures to `TRANSPORT`: the request was valid and the bytes were corrupted in transit, so the default retry policy retries it.

## Alternatives considered

- **Send both headers, as the Anthropic SDK does with both options** — rejected: the rejecting gateway validates the bearer regardless of `x-api-key`.
- **Tolerate unseparated SSE frames client-side** — rejected: it rewrites a provider stream to accommodate one upstream defect; retrying reaches the healthy path without owning a parser.

## Consequences

Claude-Code-style setups exporting only `ANTHROPIC_AUTH_TOKEN` keep bearer authentication; a deployment that needs the bearer token while a key is also exported names it explicitly (`apiKeyEnv: ANTHROPIC_AUTH_TOKEN`, `authMode: bearer`). Pinned by `tests/dynamic-config.spec.ts` (request headers and materialization) and `tests/convert.spec.ts` (classification).

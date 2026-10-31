# Agent Note: Harniverse product identity and centralized outbound attribution

Status: implemented

English | [中文](2026-10-31-harniverse-product-identity.zh.md)

## Problem

Outbound requests identified the product inconsistently. LLM traffic carried the upstream `deepseek-harness/1.0.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)` from `dsh-llm`'s `attribution.ts`, while web search providers, the DeepSeek web API, and `web-fetch-http` hand-copied a stale `deepseek-harness/0.0.1` constant (three spellings of the URL comment among them), the HTTP notification sender branded itself `harniverse-notification/1`, and the MCP client introduced itself as `dsh-mcp-client/0.0.1`. Every exit that set no `User-Agent` at all — speech transcription, SenseVoice model downloads, Brave/Kagi/Cloudflare/Tavily/Firecrawl, the Feishu and Telegram chat adapters, the SDK GrantAccess exchange, and chat-app's status probe — rode on Node fetch's implicit `user-agent: node`. Two pi-ai routes also lost the harness identity on the wire: the Codex route sets its own `User-Agent` after merging caller headers, and the Google SDK appends to the header. Separately, the default DeepSeek Search API configuration sent the triggering user's prompt (first 128 characters) as `ori_question` to the search endpoint on every search.

## Decision

- **One identity package.** `@deepseek-ai/dsh-identity` (`packages/util/identity`) owns the product identity: `APP_IDENTITY`, `userAgent()`, `attributionHeaders()`, and the new `clientIdentity()` projection for protocol client introductions. `dsh-llm`'s `attribution.ts` re-exports the contract, so adapter imports and the `dsh-llm/attribution` subpath are unchanged.
- **Consumers bundle the identity; only the Python runtime keeps a real dependency.** In the bundled library packages the identity is a `devDependencies` entry, so each package's lib build inlines the (tiny, dependency-free) module instead of importing it at runtime. A runtime-external import turned out to disturb the vendor loader: evaluating an extra non-plugin module inside a loader entry's import chain made the *next* entry's fiber skip `internal/config` interpolation, so the base patch's `root: !!js dshHomePath('sessions')` reached `JsonlSessionPersistence` as a raw expression object and failed config validation (`dsh web --host 0.0.0.0` in the built-bin smoke). `python/sdk-runtime` — which resolves packages through `node_modules`, not the bundler — keeps `@deepseek-ai/dsh-identity` as a real dependency, and the runtime-closure gate verifies it.
- **The product is `harniverse`.** The token changes from the upstream `deepseek-harness` to `harniverse`, rendered `harniverse/<version>` with no url comment: the downstream has no public repository home, and pointing at the upstream URL would misattribute. `AppIdentity.url` becomes optional; white-label deployments may still pass one.
- **The version has one granting source.** The identity reads its own package manifest, and `pnpm run release:dsh` grants that version to the entire dsh family (root included) in one step, so the User-Agent can never name a version the repository does not carry. This change releases as `1.0.0-rc.3`.
- **Every product-owned outbound HTTP exit sends the identity.** The five hand-written constants were replaced (`web-deepseek-api`, `web-search-exa`, `web-search-perplexity`, `web-fetch-http`'s `DEFAULT_USER_AGENT`, `notification-http`), the MCP `clientInfo` now comes from `clientIdentity()`, and the previously anonymous exits listed above now set the header explicitly. `web-fetch-http` keeps its `userAgent` config override. The notification protocol headers (`X-Harniverse-Event*`) are deduplication contracts and keep their names.
- **The pi-ai fetch hook pins the identity.** `llm-pi-ai` wraps the transport fetch with `enforceAttributionFetch`, re-setting `user-agent` at request time, after every library header decision. This repairs the Codex override and the Google append without a vendor patch.
- **`ori_question` defaults to off.** `web-deepseek-api`'s `sendOriginalQuestion` now defaults to `false`; the model-authored query travels alone unless the user opts in. Rationale: the raw prompt is user content, its recipient differs from the chat provider whenever a non-DeepSeek model is configured, and the reformulated query already carries the intent.

### Non-goals (deliberately unchanged)

Session and affinity identifiers (`session_id`, `x-client-request-id`, `prompt_cache_key`, OpenRouter affinity headers), SDK fingerprint headers (`X-Stainless-*`, `x-goog-api-client`, AWS `x-amz-user-agent`), provider admission headers on catalog routes (Codex `originator`, Copilot `Editor-Version`, Anthropic OAuth `x-app`), remote-host proxy forwarding, the headless-Chrome and Electron user agents, and subprocess traffic (pnpm, git) all keep their current behavior: each carries functional weight (prompt-cache affinity, provider access requirements, or protocol correctness), and removing it risks breaking providers for a privacy gain this decision does not require. `x-deepseek-harness-compact` keeps its name: it is a functional traffic marker, not identity.

## Verification

- `packages/util/identity/tests/identity.spec.ts` pins the identity facts, both `userAgent` renderings, the header map, and `clientIdentity`.
- `dsh-llm`'s attribution suite re-exports the contract unchanged and asserts the `harniverse` defaults.
- Wire-level assertions: the DeepSeek web API capture test now pins `user-agent`, and the exa/perplexity provider suites assert it on the wire; the notification-http suite expects the shared `userAgent()`; the pi-ai mock-server suite still proves attribution wins over profile headers, and new unit tests pin `enforceAttributionFetch` for both init headers and `Request` objects.
- The web-deepseek-api settings composition covers the new default (off), the explicit opt-in, and the switch back.
- `pnpm run release:dsh --no-commit 1.0.0-rc.3` moved the whole dsh family (root and all 330 manifests, the new package included) in one grant; the settings dialog golden follows.

## Alternatives considered

**Keep `deepseek-harness` as the token.** Rejected: harniverse is the product users run, its notification headers already say Harniverse, and an honest token is the point of attribution. The wire change is cosmetic to providers.

**Plumb a per-adapter identity instead of flipping the default.** Rejected: the white-label parameter stays available, but routing every adapter through an identity argument to change one constant adds plumbing this downstream does not need; flipping the default in the fork with a note is the smaller honest diff.

**A Cordis identity service with runtime config.** Rejected for now: the identity is static public facts; no current consumer needs configuration, and the standing attribution decision already rejected config-gated attribution. A service can be introduced when a real consumer appears.

**Enforce the header at the global undici dispatcher.** Rejected as the primary mechanism: it cannot see the `ws` package, `node:http` direct calls, AWS SDK traffic, or subprocesses, and it would centralize behavior invisibly to every package author. The fetch wrapper stays inside `llm-pi-ai`, where the requirement lives.

**Strip SDK fingerprint and session headers at the same time.** Rejected: each carries function (cache affinity, provider admission), removal is unverified against provider behavior, and mixing them into this change would make the blast radius unreviewable. They are recorded as non-goals instead.

## Consequences

- Providers and endpoints see `harniverse/1.0.0-rc.3` instead of four spellings of two products; deployments that keyed on `deepseek-harness/...` in gateway logs or the `harniverse-notification/1` sender value must update their matching.
- Traffic that previously blended in as generic `node` clients (search providers, chat adapters, model downloads, speech) now identifies the product honestly.
- `docs/config-catalog.md`, `docs/subsystems/llm-streaming.md`, the type-equivalence manifest, and the affected READMEs describe the new defaults and the identity owner.
- This note extends the 2026-06-21 mandatory-attribution decision from "LLM adapters" to "all product-owned outbound identity"; that note's User-Agent-only contract and its rejection of OpenRouter headers remain in force.

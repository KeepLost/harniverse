# dsh-identity

English | [中文](README.zh.md)

The **single source of the product identity** outbound requests carry. It owns the `harniverse` `User-Agent` token, the product version, and the MCP `clientInfo` projection — nothing else. Every LLM adapter, web tool, notification sender, chat adapter, and MCP client renders its identity from here, so no surface can drift into a hand-copied constant or a stale version again.

The version is read from this package's manifest and granted to the whole workspace family by the release process (`pnpm run release:dsh`), so the identity can never name a version the repository does not carry. See the [Agent Note](../../../.agents/notes/implemented/architecture/2026-10-31-harniverse-product-identity.md) for the scope and the deliberate non-goals (session ids, SDK fingerprint headers, and provider admission headers stay with their owning decisions).

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no state. Every field is a static public product fact — no secrets, local paths, session ids, prompt text, or per-user identifiers. White-label deployments pass their own `AppIdentity`; omission falls back to the harniverse default, and nothing can suppress attribution entirely.

## API

```ts
import { APP_IDENTITY, attributionHeaders, clientIdentity, userAgent } from '@deepseek-ai/dsh-identity'
```

| Export | Role |
|---|---|
| `APP_IDENTITY` | The product identity: `harniverse` plus the manifest version, with no url comment (the product has no public repository home). |
| `userAgent(identity?)` | Render the `User-Agent` value: `product/version`, plus ` (+url)` when the identity carries a home. |
| `attributionHeaders(identity?)` | The headers an outbound request must carry — currently `{ 'user-agent': … }` and nothing else. |
| `clientIdentity(identity?)` | Project the identity into a protocol client introduction such as MCP `initialize`'s `clientInfo` (`{ name, version }`). |

## Model effects

None. The identity never enters prompts, request bodies, token accounting, or session logs; LLM provider requests carry it as HTTP metadata only.

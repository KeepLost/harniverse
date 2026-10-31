/**
 * App-attribution vocabulary for provider requests. The implementation lives in
 * `@deepseek-ai/dsh-identity`, the single source of the product identity shared
 * by every outbound surface; this module re-exports that contract so existing
 * adapter imports and the `dsh-llm/attribution` subpath stay stable. See
 * `.agents/notes/implemented/architecture/2026-10-31-harniverse-product-identity.md`.
 * @module @deepseek-ai/dsh-llm/attribution
 */

export { APP_IDENTITY, attributionHeaders, clientIdentity, userAgent } from '@deepseek-ai/dsh-identity'
export type { AppIdentity } from '@deepseek-ai/dsh-identity'

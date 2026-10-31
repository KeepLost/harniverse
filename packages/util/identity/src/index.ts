/**
 * The single source of the product identity outbound requests carry: the
 * `harniverse` User-Agent token, the manifest-granted version, and the MCP
 * `clientInfo` projection. Every field is a static public product fact.
 * @module @deepseek-ai/dsh-identity
 */

import { createRequire } from 'node:module'

// The package's own manifest is the single source of the version so the
// User-Agent cannot drift from what is published (`./package.json` is an
// export of this package; the relative path resolves from both `src/` and
// the bundled `lib/`). The release process (`pnpm run release:dsh`) grants
// that version to the whole workspace family at once.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/**
 * Static public application identity carried on outbound requests.
 *
 * Every field is a public product fact, safe on every request: no secrets,
 * local paths, session ids, prompt text, or per-user identifiers belong here,
 * and nothing per-request may influence the values.
 */
export interface AppIdentity {
  /** `User-Agent` product token (lowercase, hyphenated). */
  product: string
  /** Product version; sourced from package metadata, never hand-copied. */
  version: string
  /** Repository home URL rendered as the `User-Agent` comment; omit when the product has no public home. */
  url?: string
}

/**
 * The product's own identity: the default every outbound surface sends.
 * Deployments that need a white-label identity pass their own
 * {@link AppIdentity} to {@link attributionHeaders} — omission falls back to
 * this default; nothing can suppress attribution entirely.
 */
export const APP_IDENTITY: AppIdentity = {
  product: 'harniverse',
  version,
}

/**
 * The standard `User-Agent` value: `product/version`, plus ` (+url)` when the
 * identity carries a repository home (RFC 9110 §10.1.5 product + comment
 * syntax).
 * @param identity - the identity to render; defaults to {@link APP_IDENTITY}.
 * @returns the ready-to-send header value.
 */
export function userAgent(identity: AppIdentity = APP_IDENTITY): string {
  return identity.url === undefined
    ? `${identity.product}/${identity.version}`
    : `${identity.product}/${identity.version} (+${identity.url})`
}

/**
 * Build the attribution headers an outbound request must carry. Header names
 * are lowercase (HTTP field names are case-insensitive on the wire).
 * @param identity - the identity to send; defaults to {@link APP_IDENTITY} — omission cannot suppress attribution.
 * @returns headers to merge into the request (currently just `user-agent`).
 */
export function attributionHeaders(
  identity: AppIdentity = APP_IDENTITY,
): Record<string, string> {
  return { 'user-agent': userAgent(identity) }
}

/**
 * Project the identity into a protocol client introduction, such as the MCP
 * `initialize` body's `clientInfo` field.
 * @param identity - the identity to send; defaults to {@link APP_IDENTITY}.
 * @returns the `{ name, version }` pair the protocol expects.
 */
export function clientIdentity(
  identity: AppIdentity = APP_IDENTITY,
): { name: string; version: string } {
  return { name: identity.product, version: identity.version }
}

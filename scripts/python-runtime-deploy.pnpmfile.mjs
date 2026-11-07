/**
 * Preserve workspace build approvals when pnpm deploy records local
 * dependencies as `file://` URLs. This hook lives in the workspace root's
 * scripts/ directory; relative `file:` approvals use that root.
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Translate local build identities without changing their approved or denied
 * status: default deploy stamps injected workspace dependencies into the
 * derived lockfile as absolute `file://` URLs, so the reviewed relative
 * `name@file:<path>` approval keys must carry the same identity.
 * @param {Record<string, unknown>} config - source workspace configuration.
 * @returns {Record<string, unknown>} deployment configuration with exact file
 *   URL approvals.
 */
function updateConfig(config) {
  if (config.allowBuilds === undefined) return config
  const allowBuilds = Object.fromEntries(Object.entries(config.allowBuilds).map(([key, value]) => {
    const marker = key.indexOf('@file:')
    if (marker < 0 || key.slice(marker + 6).startsWith('//')) return [key, value]
    const source = resolve(import.meta.dirname, '..', key.slice(marker + 6))
    return [`${key.slice(0, marker + 1)}${pathToFileURL(source).href}`, value]
  }))
  return { ...config, allowBuilds }
}

/** Pnpm configuration hooks scoped to Python runtime deployment. */
export const hooks = { updateConfig }

/** Complete resolved model/search sections, with schema-selected credential resolution only. */
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { RemoteHostsError } from './validation.ts'
import type { ActiveReverseMapping } from './types.ts'
import z from '@deepseek-ai/schemastery'

const NAMESPACES = ['llm-deepseek', 'llm-pi-ai', 'agent-default-model', 'model-profiles', 'model-routes', 'web',
  'web-search-deepseek', 'web-search-exa', 'web-search-perplexity', 'web-search-tavily', 'web-search-brave', 'web-search-kagi', 'web-firecrawl'] as const
interface SchemaNode { type?: string; meta?: { role?: string }; dict?: Record<string, SchemaNode>; inner?: SchemaNode; list?: SchemaNode[] }

function rewriteOrigin(value: JsonValue, mappings: readonly ActiveReverseMapping[]): JsonValue {
  if (typeof value === 'string') {
    for (const mapping of mappings) {
      const original = mapping.remoteOriginalOrigin
      if (value !== original && !value.startsWith(`${original}/`)) continue
      const origin = new URL(original)
      origin.hostname = '127.0.0.1'
      origin.port = String(mapping.remotePort)
      return `${origin.origin}${value.slice(original.length)}`
    }
    return value
  }
  if (Array.isArray(value)) return value.map(entry => rewriteOrigin(entry, mappings))
  if (typeof value === 'object' && value !== null) {
    const rewritten: Record<string, JsonValue> = {}
    for (const [key, entry] of Object.entries(value)) rewritten[key] = rewriteOrigin(entry, mappings)
    return rewritten
  }
  return value
}

function containsReference(node: SchemaNode, visited = new Set<SchemaNode>()): boolean {
  if (visited.has(node)) return false
  visited.add(node)
  return ['credential-ref', 'secret'].includes(node.meta?.role ?? '')
    || Object.values(node.dict ?? {}).some(child => containsReference(child, visited))
    || (node.inner !== undefined && containsReference(node.inner, visited))
    || (node.list ?? []).some(child => containsReference(child, visited))
}

function collect(node: SchemaNode, value: JsonValue | undefined, refs: Set<string>, inline: Record<string, string>): void {
  if (value === undefined || value === null) return
  if (node.meta?.role === 'secret') throw new RemoteHostsError('UNSUPPORTED_INLINE_SECRET')
  if (node.meta?.role === 'credential-ref') {
    if (typeof value !== 'string' || value.startsWith('DSH_REMOTE_HOST_')) throw new RemoteHostsError('INVALID_SYNC_REFERENCE')
    if (value !== '') refs.add(credentialRef(value))
    return
  }
  if (node.type === 'object' && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(node.dict ?? {})) {
      if (child.meta?.role === 'secret' && value[key] !== undefined) {
        const secret = value[key]
        const reference = value.apiKeyEnv
        if (key !== 'apiKey' || node.dict?.apiKeyEnv?.meta?.role !== 'credential-ref' || typeof reference !== 'string'
          || reference.startsWith('DSH_REMOTE_HOST_') || typeof secret !== 'string') throw new RemoteHostsError('UNSUPPORTED_INLINE_SECRET')
        if (secret) {
          const ref = credentialRef(reference)
          if (inline[ref] !== undefined && inline[ref] !== secret) throw new RemoteHostsError('CONFLICTING_INLINE_SECRET')
          inline[ref] = secret
        }
        delete value.apiKey
      } else collect(child, value[key], refs, inline)
    }
  } else if (node.type === 'dict' && typeof value === 'object' && !Array.isArray(value) && node.inner) {
    for (const entry of Object.values(value)) collect(node.inner, entry, refs, inline)
  } else if (node.type === 'array' && Array.isArray(value) && node.inner) {
    for (const entry of value) collect(node.inner, entry, refs, inline)
  } else if (node.type === 'intersect') {
    for (const child of node.list ?? []) collect(child, value, refs, inline)
  } else if (['union', 'transform', 'lazy'].includes(node.type ?? '')) {
    if (containsReference(node)) {
      // Ambiguous branch selection must not grant access to additional local secrets.
      throw new RemoteHostsError('UNSUPPORTED_SYNC_SCHEMA')
    }
  }
}

/** Build the secret-filtered remote settings and credential snapshot.
 * @param settings - local settings provider.
 * @param provider - local credential provider.
 * @param mappings - active reverse mappings used to rewrite origins.
 * @returns complete remote settings and credential maps.
 */
export async function buildSnapshot(
  settings: SettingsProvider,
  provider: CredentialProvider,
  mappings: readonly ActiveReverseMapping[] = [],
): Promise<{
  settings: Record<string, JsonValue>
  credentials: Record<string, string>
}> {
  const snapshot: Record<string, JsonValue> = {}
  const refs = new Set<string>()
  const inline: Record<string, string> = Object.create(null) as Record<string, string>
  for (const descriptor of settings.describe()) {
    if (!(NAMESPACES as readonly string[]).includes(descriptor.ns)) continue
    const value = rewriteOrigin(JSON.parse(JSON.stringify(descriptor.value)) as JsonValue, mappings)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RemoteHostsError('INVALID_SYNC_SETTINGS')
    snapshot[descriptor.ns] = value
    collect(new z(descriptor.schema as z) as SchemaNode, value, refs, inline)
  }
  const credentials: Record<string, string> = Object.create(null) as Record<string, string>
  for (const ref of refs) {
    const resolved = await provider.resolve(credentialRef(ref))
    if (resolved !== undefined) credentials[ref] = resolved.value
  }
  Object.assign(credentials, inline)
  return { settings: snapshot, credentials }
}

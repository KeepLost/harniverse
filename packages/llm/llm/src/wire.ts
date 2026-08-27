/** Small, context-free metadata helpers for provider-wire diagnostics. */

import type { LlmWireAttempt } from './types.ts'

const CONTEXT_KEYS = new Set(['messages', 'tools', 'system', 'input', 'contents', 'prompt'])
const SECRET_KEY = new RegExp(
  '(?:api[-_]?key|authorization|cookie|credential|password|secret|'
    + 'access[-_]?token|refresh[-_]?token|id[-_]?token|bearer)', 'iu')
const DIAGNOSTIC_HEADER = new RegExp(
  '^(?:content-type|content-length|date|retry-after|request-id|server|'
    + 'x-request-id|x-ratelimit-[\\w-]+|x-[\\w-]*request[-_]id)$', 'iu')

function canonicalJson(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const items = value.map(canonicalJson)
    return items.some(item => item === undefined) ? undefined : `[${items.join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries: string[] = []
    for (const key of Object.keys(value).sort()) {
      const item = canonicalJson((value as Record<string, unknown>)[key])
      if (item !== undefined) entries.push(`${JSON.stringify(key)}:${item}`)
    }
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

function sanitizedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizedJson)
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue
      const encoded = JSON.stringify(item)
      if (typeof encoded !== 'string') continue
      result[key] = sanitizedJson(item)
    }
    return result
  }
  return value
}

/**
 * Return request size and a deterministic, non-secret semantic fingerprint.
 * @param value - JSON payload whose serialized size and content are measured.
 * @returns the UTF-8 serialized byte count and canonical fingerprint.
 */
export function wireJsonFingerprint(value: unknown): { bytes: number; fingerprint: string } {
  const serialized = JSON.stringify(value)
  const text = typeof serialized === 'string' ? serialized : 'null'
  const canonical = canonicalJson(value) ?? 'null'
  const bytes = new TextEncoder().encode(text)
  const fingerprintBytes = new TextEncoder().encode(canonical)
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (const byte of fingerprintBytes) {
    first = Math.imul(first ^ byte, 0x01000193)
    second = Math.imul(second ^ byte, 0x85ebca6b)
  }
  return {
    bytes: bytes.byteLength,
    fingerprint: `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`,
  }
}

/**
 * Keep only non-context, JSON-safe top-level request parameters.
 * @param value - provider payload containing context and transport fields.
 * @returns a redacted parameter projection, or undefined when it is empty.
 */
export function wireRequestParameters(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (CONTEXT_KEYS.has(key) || SECRET_KEY.test(key)) continue
    const sanitized = sanitizedJson(item)
    const encoded = JSON.stringify(sanitized)
    if (typeof encoded !== 'string') continue
    result[key] = JSON.parse(encoded) as unknown
  }
  return Object.keys(result).length === 0 ? undefined : result
}

/**
 * Select response headers useful for diagnosis while dropping credential material.
 * @param headers - provider response headers.
 * @returns selected lowercase diagnostic headers, or undefined when none apply.
 */
export function wireDiagnosticHeaders(headers: Readonly<Record<string, string>>): Record<string, string> | undefined {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (DIAGNOSTIC_HEADER.test(key)) result[key.toLowerCase()] = value
  }
  return Object.keys(result).length === 0 ? undefined : result
}

/**
 * Build the request portion of a wire-attempt record.
 * @param value - provider payload to fingerprint and project.
 * @returns request size, fingerprint, and non-context parameters.
 */
export function wireRequestMetadata(value: unknown): LlmWireAttempt['request'] {
  const fingerprint = wireJsonFingerprint(value)
  const parameters = wireRequestParameters(value)
  return {
    ...fingerprint,
    ...parameters === undefined ? {} : { parameters },
  }
}

/**
 * Resource-result projection keeps binary payloads out of model history.
 *
 * @module @deepseek-ai/dsh-mcp-resources
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-tools'

/** Complete UTF-8 model-facing result ceiling, including attribution and notice. */
export const MAX_RESOURCE_TEXT_BYTES = 32_768

/**
 * Render resource JSON while retaining raw binary data only for programmatic callers.
 * @param server - configured server attribution.
 * @param value - canonical resource result.
 * @param maxBytes - complete rendered byte budget.
 * @returns attributed text with binary payload descriptions.
 */
export function renderResourceResult(server: string, value: JsonValue, maxBytes = MAX_RESOURCE_TEXT_BYTES): ContentBlock[] {
  const notice = '\n[Resource result truncated; narrow the request.]'
  if (!Number.isSafeInteger(maxBytes) || maxBytes < Buffer.byteLength(notice)) {
    throw new Error('MCP resource text budget cannot hold the truncation notice')
  }
  const rendered = JSON.stringify(value, (key, item: unknown) => {
    // Protocol metadata is for applications, not model instructions or resource content.
    if (key === '_meta') return undefined
    if (key === 'blob' && typeof item === 'string') {
      return `[binary resource: ${item.length} base64 characters; available to programmatic callers]`
    }
    return item
  })
  const text = `MCP server: ${server}\n${rendered}`
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return [{ type: 'text', text }]
  const prefix = new TextDecoder().decode(bytes.subarray(0, maxBytes - Buffer.byteLength(notice)), { stream: true })
  return [{ type: 'text', text: prefix + notice }]
}

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity of one context-reset checkpoint transaction. */
export type ResetId = Branded<'ResetId'>

/**
 * Brand an implementation-minted context-reset identity.
 * @param id - opaque transaction identity.
 * @returns the same string, branded; no validation is performed.
 */
export function ResetId(id: string): ResetId {
  return id as ResetId
}

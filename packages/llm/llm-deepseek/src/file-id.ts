/** DeepSeek Files API identifiers. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identifier returned by the DeepSeek Files API. */
export type DeepSeekFileId = Branded<'DeepSeekFileId'>

/** Brand a provider-returned file identifier after wire validation.
 * @param value - validated provider identifier.
 * @returns the branded file identifier.
 */
export function DeepSeekFileId(value: string): DeepSeekFileId {
  return value as DeepSeekFileId
}

/** Non-secret digest identifying one endpoint and API-key file namespace. */
export type DeepSeekFileScope = Branded<'DeepSeekFileScope'>

/** Brand a locally derived provider cache namespace.
 * @param value - non-secret scope digest.
 * @returns the branded scope.
 */
export function DeepSeekFileScope(value: string): DeepSeekFileScope {
  return value as DeepSeekFileScope
}

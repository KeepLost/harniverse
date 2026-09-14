/** Byte formatting on the governor dictionary's unit scale. */

import type { GovernorKey } from './locales.ts'

/** Translator shape {@link formatBytes} reads unit templates through. */
export type UnitTranslate = (key: GovernorKey, params: { value: string }) => string

/** Format a byte count into the dictionary's unit scale.
 * @param bytes - the non-negative byte count to format.
 * @param t - translator resolving the `units.*` templates.
 * @returns the localized byte string, e.g. `8.0 GiB`.
 */
export function formatBytes(bytes: number, t: UnitTranslate): string {
  if (bytes >= 1024 ** 3) return t('units.gib', { value: (bytes / 1024 ** 3).toFixed(1) })
  if (bytes >= 1024 ** 2) return t('units.mib', { value: (bytes / 1024 ** 2).toFixed(1) })
  if (bytes >= 1024) return t('units.kib', { value: (bytes / 1024 ** 1).toFixed(1) })
  return t('units.bytes', { value: String(bytes) })
}

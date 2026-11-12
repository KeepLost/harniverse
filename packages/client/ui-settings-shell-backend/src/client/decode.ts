/**
 * The `shell-registry` namespace narrowing: the host schema already validates
 * the wire section; this decoder only narrows it to the typed shape the
 * section renders, defaulting an absent default to the reserved
 * `platform-default`.
 */

/** One registered shell entry as the settings section renders it. */
export interface ShellRegistryEntryValue {
  /** Stable selector id. */
  id: string
  /** Executable path or PATH name. */
  path: string
  /** User-facing label; absent means the executable's basename. */
  label?: string
}

/** The resolved namespace section the section form renders. */
export interface ShellBackendSectionValue {
  /** Registry default: the reserved platform split, a builtin id, or one entry id. */
  default: string
  /** User-registered entries. */
  entries: readonly ShellRegistryEntryValue[]
}

/** The host plugin's settings namespace, as the gateway exposes it. */
export const SHELL_BACKEND_NS = 'shell-registry'

/**
 * Narrow one wire section to {@link ShellBackendSectionValue}.
 * @param section - schema-resolved section value from the settings mirror.
 * @returns the typed section, or undefined to keep the last accepted value.
 */
export function decodeShellBackendSection(section: unknown): ShellBackendSectionValue | undefined {
  if (typeof section !== 'object' || section === null) return undefined
  const record = section as Record<string, unknown>
  const def = record.default
  const rawEntries = record.entries
  const entries: ShellRegistryEntryValue[] = Array.isArray(rawEntries)
    ? rawEntries.flatMap((entry): ShellRegistryEntryValue[] => {
      if (typeof entry !== 'object' || entry === null) return []
      const { id, path, label } = entry as Record<string, unknown>
      if (typeof id !== 'string' || typeof path !== 'string') return []
      return [{
        id,
        path,
        ...(typeof label === 'string' && label.length > 0 ? { label } : {}),
      }]
    })
    : []
  if (def === undefined) return { default: 'platform-default', entries }
  return typeof def === 'string'
    ? { default: def, entries }
    : undefined
}

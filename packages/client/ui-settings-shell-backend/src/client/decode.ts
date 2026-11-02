/**
 * The `shell-backend` namespace narrowing: the host schema already validates
 * the wire section; this decoder only narrows it to the typed shape the
 * section renders, defaulting an absent backend to the composed
 * `platform-default`.
 */

/** One selectable shell family preference; mirrors the host plugin's union. */
export type ShellBackendPreferenceValue = 'platform-default' | 'git-bash'

/** The resolved namespace section the section form renders. */
export interface ShellBackendSectionValue {
  /** Stored preference; absent on the wire means the composed default `platform-default`. */
  backend: ShellBackendPreferenceValue
}

/** The host plugin's settings namespace, as the gateway exposes it. */
export const SHELL_BACKEND_NS = 'shell-backend'

const BACKENDS: readonly ShellBackendPreferenceValue[] = ['platform-default', 'git-bash']

/**
 * Narrow one wire section to {@link ShellBackendSectionValue}.
 * @param section - schema-resolved section value from the settings mirror.
 * @returns the typed section, or undefined to keep the last accepted value.
 */
export function decodeShellBackendSection(section: unknown): ShellBackendSectionValue | undefined {
  if (typeof section !== 'object' || section === null) return undefined
  const backend = (section as Record<string, unknown>).backend
  if (backend === undefined) return { backend: 'platform-default' }
  return BACKENDS.includes(backend as ShellBackendPreferenceValue)
    ? { backend: backend as ShellBackendPreferenceValue }
    : undefined
}

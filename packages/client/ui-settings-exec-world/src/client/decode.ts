/**
 * The `exec-world` namespace narrowing: the host schema already validates
 * the wire section; this decoder only narrows it to the typed shape the
 * section renders, defaulting an absent world to the composed `local`.
 */

/** One selectable execution world; mirrors the host plugin's union. */
export type ExecWorldPreferenceValue = 'local' | 'vm'

/** The resolved namespace section the section form renders. */
export interface ExecWorldSectionValue {
  /** Stored preference; absent on the wire means the composed default `local`. */
  world: ExecWorldPreferenceValue
}

/** The host plugin's settings namespace, as the gateway exposes it. */
export const EXEC_WORLD_NS = 'exec-world'

const WORLDS: readonly ExecWorldPreferenceValue[] = ['local', 'vm']

/**
 * Narrow one wire section to {@link ExecWorldSectionValue}.
 * @param section - schema-resolved section value from the settings mirror.
 * @returns the typed section, or undefined to keep the last accepted value.
 */
export function decodeExecWorldSection(section: unknown): ExecWorldSectionValue | undefined {
  if (typeof section !== 'object' || section === null) return undefined
  const world = (section as Record<string, unknown>).world
  if (world === undefined) return { world: 'local' }
  return WORLDS.includes(world as ExecWorldPreferenceValue)
    ? { world: world as ExecWorldPreferenceValue }
    : undefined
}

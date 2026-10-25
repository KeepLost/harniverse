/**
 * The `network-proxy` namespace narrowing: the host schema already validates
 * the wire section; this decoder only narrows it to the typed shape the
 * section renders, defaulting an absent mode to the composed `off`.
 */

/** One selectable outbound route mode; mirrors the host plugin's union. */
export type ProxyMode = 'off' | 'system' | 'manual'

/** The resolved namespace section the section form renders. */
export interface NetworkProxySectionValue {
  /** Selected route; absent on the wire means the composed default `off`. */
  mode: ProxyMode
  /** Manual proxy server URL; present only when configured. */
  url?: string
  /** Hostnames that bypass the manual proxy; present only when non-empty. */
  noProxy?: string[]
}

/** The host plugin's settings namespace, as the gateway exposes it. */
export const NETWORK_PROXY_NS = 'network-proxy'

const MODES: readonly ProxyMode[] = ['off', 'system', 'manual']

/**
 * Narrow one wire section to {@link NetworkProxySectionValue}.
 * @param section - schema-resolved section value from the settings mirror.
 * @returns the typed section, or undefined to keep the last accepted value.
 */
export function decodeNetworkProxySection(section: unknown): NetworkProxySectionValue | undefined {
  if (typeof section !== 'object' || section === null) return undefined
  const raw = section as Record<string, unknown>
  const mode = raw.mode === undefined ? 'off' : raw.mode
  if (!MODES.includes(mode as ProxyMode)) return undefined
  const url = raw.url
  if (url !== undefined && typeof url !== 'string') return undefined
  const noProxy = raw.noProxy
  const entries: string[] = []
  if (noProxy !== undefined) {
    if (!Array.isArray(noProxy)) return undefined
    for (const entry of noProxy as unknown[]) {
      if (typeof entry !== 'string') return undefined
      entries.push(entry)
    }
  }
  return { mode: mode as ProxyMode, ...(url === undefined ? {} : { url }), ...(noProxy === undefined ? {} : { noProxy: entries }) }
}

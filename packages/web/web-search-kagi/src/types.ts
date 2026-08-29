/** Wire types for Kagi's v1 search API. */

/** One direct Kagi result object. */
export interface KagiResult {
  url: string
  title?: string | null
  snippet?: string | null
  published?: string | null
}

/** Common Kagi wrapper variants, all intentionally provider-private. */
export interface KagiSearchEnvelope {
  data?: KagiResult[] | KagiSearchEnvelope
  results?: KagiResult[]
  items?: KagiResult[]
}

/** A Kagi response may be a direct result array or an envelope. */
export type KagiSearchResponse = KagiResult[] | KagiSearchEnvelope

/** Best-effort error fields returned by Kagi or a gateway. */
export interface KagiError {
  error?: string
  message?: string
  detail?: string
}

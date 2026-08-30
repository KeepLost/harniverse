/** Wire types for Tavily's search API. Types only; no runtime validation lives here. */

/** One result returned by Tavily. */
export interface TavilyResult {
  url: string
  title?: string | null
  content?: string | null
  raw_content?: string | null
  published_date?: string | null
  score?: number | null
}

/** Tavily's search response envelope. */
export interface TavilySearchResponse {
  results?: TavilyResult[]
}

/** Best-effort error fields used by Tavily and its gateways. */
export interface TavilyError {
  error?: string
  message?: string
  detail?: string
}

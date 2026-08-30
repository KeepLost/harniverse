/** Wire types for Brave Search's web endpoint. */

/** One entry under `web.results[]`. */
export interface BraveResult {
  url: string
  title?: string | null
  description?: string | null
  extra_snippets?: string[] | null
}

/** Brave's web result group. */
export interface BraveWebResults {
  results?: BraveResult[]
}

/** Brave Search response envelope. */
export interface BraveSearchResponse {
  web?: BraveWebResults
}

/** Best-effort API error fields. */
export interface BraveError {
  error?: string
  message?: string
  detail?: string
}

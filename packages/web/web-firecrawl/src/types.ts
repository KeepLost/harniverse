/** Wire types for Firecrawl v2 search and scrape APIs. */

/** Metadata attached to a Firecrawl search or scrape result. */
export interface FirecrawlMetadata {
  /** Final target URL after Firecrawl follows the target's redirects. */
  url?: string | null
  sourceURL?: string | null
  statusCode?: number | null
  title?: string | null
}

/** One Firecrawl search result. */
export interface FirecrawlSearchResult {
  title?: string | null
  description?: string | null
  url?: string | null
  content?: string | null
  markdown?: string | null
  metadata?: FirecrawlMetadata | null
}

/** Firecrawl search response; v2 exposes web results under `data.web`. */
export interface FirecrawlSearchResponse {
  success?: boolean
  results?: FirecrawlSearchResult[]
  data?: FirecrawlSearchResult[] | {
    results?: FirecrawlSearchResult[]
    web?: FirecrawlSearchResult[]
  }
}

/** Scrape payload carrying the target markdown and metadata. */
export interface FirecrawlScrapeData {
  markdown?: string | null
  content?: string | null
  url?: string | null
  metadata?: FirecrawlMetadata | null
}

/** Firecrawl scrape response envelope. */
export interface FirecrawlScrapeResponse {
  success?: boolean
  data?: FirecrawlScrapeData | null
  markdown?: string | null
  content?: string | null
  url?: string | null
  metadata?: FirecrawlMetadata | null
}

/** Best-effort Firecrawl error fields. */
export interface FirecrawlError {
  error?: string
  message?: string
  detail?: string
}

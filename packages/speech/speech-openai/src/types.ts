/** Shared helper types for the OpenAI-compatible cloud recognizer. */

/** Minimal fetch face so suites can substitute a scripted implementation. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

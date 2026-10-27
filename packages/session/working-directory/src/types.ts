/**
 * Pure-type outlet of the working-directory domain: durable change payload,
 * projection value, and plugin configuration.
 *
 * @module @deepseek-ai/dsh-working-directory/types
 */

/** Whole-value payload of one durable `working-directory/change` event. */
export interface WorkingDirectoryChange {
  /** Absolute directory used by subsequent directory-based operations. */
  readonly cwd: string
}

/** Recorded current directory for session observations, or `null` before the first change. */
export type WorkingDirectoryProjection = string | null

/** Deployment default for sessions without an original project directory. */
export interface Config {
  /** Absolute fallback directory; omitted values use the launch directory. */
  defaultDirectory?: string
}

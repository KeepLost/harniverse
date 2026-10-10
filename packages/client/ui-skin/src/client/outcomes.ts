/**
 * How the row verbs end: shapes shared by the runtime that produces them and
 * the rows that turn them into copy.
 * @module @deepseek-ai/dsh-client-ui-skin/outcomes
 */
import type { SkinDefinition, WallpaperRejectionReason } from '@deepseek-ai/dsh-api-remotes/client'

/** A plain success or failure of an operation with no payload. */
export type OperationOutcome = { status: 'ok' } | { status: 'failed'; message: string }

/** Why a wallpaper upload ended. */
export type WallpaperOutcome =
  | { status: 'ok'; hash: string }
  | { status: 'rejected'; reason: WallpaperRejectionReason }
  | { status: 'failed'; message: string }

/** Why a pack import ended. */
export type PackOutcome =
  | { status: 'imported' | 'replaced'; skin: SkinDefinition }
  | { status: 'rejected'; issues: readonly string[] }
  | { status: 'too-large' }
  | { status: 'failed'; message: string }

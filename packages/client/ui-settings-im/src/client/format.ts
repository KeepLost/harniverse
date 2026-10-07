/**
 * Pure presentation helpers: identity masking, local-time formatting, channel
 * tallies, bot status wording, and failure sentences.
 * @module @deepseek-ai/dsh-client-ui-settings-im/format
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatBotState, ChatBotView, ChatPlatformField } from '@deepseek-ai/dsh-api-remotes/client'
import type { NS } from './locales.ts'

/** The bound translator every component and helper of this package receives. */
export type ImTranslate = PropsLocale<typeof NS>['t']

/** One failed operation as the store and the components carry it. */
export interface OpError {
  /** Host business code, or a client-side code such as `pick-failed`. */
  code: string
  /** Host or runtime wording, shown only where no local sentence exists. */
  message: string
}

/** Visual weight of a bot state; the words always carry the meaning too. */
export type StatusTone = 'ok' | 'pending' | 'warn' | 'error' | 'off'

const MASK_HEAD = 8
const MASK_TAIL = 4

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * Mask the middle of a long platform id (`cli_aaf4••••dcdd`); an id short
 * enough to be read whole stays as is.
 * @param id - platform bot id.
 * @returns the id as displayed.
 */
export function maskIdentity(id: string): string {
  return id.length <= MASK_HEAD + MASK_TAIL ? id : `${id.slice(0, MASK_HEAD)}••••${id.slice(-MASK_TAIL)}`
}

/**
 * Local wall-clock time of an instant.
 * @param ms - epoch milliseconds.
 * @returns `HH:MM:SS`.
 */
export function formatClock(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Local date and minute of an instant.
 * @param ms - epoch milliseconds.
 * @returns `YYYY-MM-DD HH:mm`.
 */
export function formatStamp(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Format a remaining duration.
 * @param ms - remaining milliseconds; negative values read as zero.
 * @returns `mm:ss`, minutes unbounded.
 */
export function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`
}

/**
 * The bots of one platform, in snapshot order.
 * @param bots - every managed bot.
 * @param platform - platform id.
 * @returns the platform's bots.
 */
export function botsOf(bots: readonly ChatBotView[], platform: string): ChatBotView[] {
  return bots.filter(bot => bot.platform === platform)
}

/**
 * Online-versus-total count of one platform's bots.
 * @param bots - every managed bot.
 * @param platform - platform id.
 * @returns `online` of `total`.
 */
export function tally(bots: readonly ChatBotView[], platform: string): { online: number; total: number } {
  const own = botsOf(bots, platform)
  return { online: own.filter(bot => bot.state === 'online').length, total: own.length }
}

/**
 * Values the connect form submits: trimmed, blank optional fields dropped,
 * and an untouched choice field at its first option (what the select shows).
 * @param fields - the platform descriptor's fields.
 * @param typed - what the user has typed, by field key.
 * @returns the `addBot.values` payload.
 */
export function connectValues(fields: readonly ChatPlatformField[], typed: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of fields) {
    const value = (typed[field.key] ?? field.options?.[0]?.value ?? '').trim()
    if (value !== '') values[field.key] = value
  }
  return values
}

/**
 * Whether the connect form has everything the platform requires.
 * @param fields - the platform descriptor's fields.
 * @param typed - what the user has typed, by field key.
 * @returns true when every required field has a non-blank value.
 */
export function canConnect(fields: readonly ChatPlatformField[], typed: Record<string, string>): boolean {
  const values = connectValues(fields, typed)
  return fields.every(field => !field.required || field.key in values)
}

/**
 * Visual tone of a bot state.
 * @param state - host-reported state.
 * @returns the tone class family.
 */
export function statusTone(state: ChatBotState): StatusTone {
  switch (state) {
    case 'online': return 'ok'
    case 'starting': return 'pending'
    case 'reconnecting': return 'warn'
    case 'error': return 'error'
    case 'disabled': return 'off'
  }
}

/**
 * Status wording of a bot; an error carries the host message.
 * @param t - bound translator.
 * @param bot - the bot.
 * @returns the status sentence.
 */
export function statusText(t: ImTranslate, bot: ChatBotView): string {
  switch (bot.state) {
    case 'online': return t('status.online')
    case 'starting': return t('status.starting')
    case 'reconnecting': return t('status.reconnecting')
    case 'disabled': return t('status.disabled')
    case 'error': return bot.message === undefined || bot.message === ''
      ? t('status.error')
      : t('status.errorDetail', { message: bot.message })
  }
}

/**
 * Sentence for a failed operation.
 * @param t - bound translator.
 * @param error - the failure.
 * @returns localized text; unknown codes carry the host wording.
 */
export function errorText(t: ImTranslate, error: OpError): string {
  switch (error.code) {
    case 'invalid-credentials': return t('error.invalid-credentials')
    case 'unreachable': return t('error.unreachable')
    case 'duplicate-bot': return t('error.duplicate-bot')
    case 'not-found': return t('error.not-found')
    case 'bridge-unavailable': return t('error.bridge-unavailable')
    case 'invalid-input': return t('error.invalid-input', { message: error.message })
    case 'pick-failed': return t('workspace.pickFailed', { message: error.message })
    default: return t('error.generic', { message: error.message })
  }
}

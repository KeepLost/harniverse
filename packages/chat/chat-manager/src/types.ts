/**
 * Client-safe vocabulary of the chat-bot management Remote (`chatBots`): the
 * snapshot the Settings page renders, the mutation inputs, and the stable
 * failure codes it discriminates on. Types only — no runtime code, and no
 * secret value appears in any of them.
 * @module @deepseek-ai/dsh-chat-manager/types
 */

/**
 * One value a platform needs before it can mount a bot. Mirrors
 * `ChatPlatformField` of `@deepseek-ai/dsh-chat-adapter` field for field; a
 * type-equivalence test pins the two together so this module stays free of the
 * adapter package's runtime graph.
 */
export interface ChatPlatformField {
  /** Stable key: `token`, `appId`, `appSecret`, `baseUrl`, `domain`. */
  key: string
  /** Chinese product label. */
  label: string
  /** Secret fields are stored as credentials and never returned. */
  secret: boolean
  required: boolean
  placeholder?: string
  hint?: string
  /** Closed choice list; the UI renders a select. */
  options?: ReadonlyArray<{ value: string; label: string }>
}

/** Lifecycle state of one managed bot. */
export type ChatBotState = 'starting' | 'online' | 'reconnecting' | 'error' | 'disabled'

/** One connectable platform: the fields a user fills in to add a bot. */
export interface ChatPlatformView {
  platform: string
  /** Channel name shown in the UI, e.g. `Telegram`, `飞书`. */
  label: string
  fields: readonly ChatPlatformField[]
}

/** The model a bot's new owner sessions start on. */
export interface ChatBotModelView {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Defaults a bot applies to new sessions of its owners. */
export interface ChatBotSettingsView {
  /** Absolute workspace directory. */
  workspace?: string
  model?: ChatBotModelView
  /** Agent Preset id. */
  agentProfile?: string
}

/** Whether one secret field has a stored value, and the last four characters of a long one. */
export interface ChatBotSecretView {
  configured: boolean
  /** Last four characters of a secret of at least 16 characters, otherwise empty. */
  tail: string
}

/** One managed bot as the Settings page sees it. */
export interface ChatBotView {
  /** `bot_` followed by eight lowercase hexadecimal digits. */
  id: string
  platform: string
  alias: string
  identity: { botId: string; displayName: string }
  /** Non-secret field values, for example `appId`, `domain`, `baseUrl`. */
  values: Record<string, string>
  /** Secret fields by key: configured flag and tail only, never the secret. */
  secrets: Record<string, ChatBotSecretView>
  enabled: boolean
  state: ChatBotState
  /** Chinese explanation of `reconnecting` and `error`. */
  message?: string
  /** Last credential check in ms since the epoch. */
  checkedAt?: number
  settings: ChatBotSettingsView
  /** Registration time in ms since the epoch. */
  createdAt: number
}

/** One paired owner identity. */
export interface ChatOwnerView {
  /** `platform:userId`; the argument of `unpairOwner`. */
  key: string
  platform: string
  userId: string
  displayName?: string
  /** Pairing time in ms since the epoch; `0` for an owner that exists only in configuration. */
  pairedAt: number
}

/** State of the embedded chat bridge. */
export type ChatBridgeStatus = 'stopped' | 'starting' | 'running' | 'error'

/** Everything the Settings page renders, read in one call. */
export interface ChatBotsSnapshot {
  platforms: ChatPlatformView[]
  bots: ChatBotView[]
  /** Paired owners; empty while the bridge is not running. */
  owners: ChatOwnerView[]
  bridge: ChatBridgeStatus
  /** Chinese explanation of `bridge: 'error'`. */
  bridgeMessage?: string
}

/** Input of `addBot`. */
export interface AddChatBotInput {
  platform: string
  /** Display name; defaults to the bot's platform display name. */
  alias?: string
  /** Typed field values by field key, secrets included. */
  values: Record<string, string>
}

/** A settings change: a value replaces, `null` clears, an absent key keeps. */
export interface ChatBotSettingsPatch {
  /** Absolute path; existence is not required. */
  workspace?: string | null
  model?: ChatBotModelView | null
  agentProfile?: string | null
}

/** Input of `updateBot`. */
export interface UpdateChatBotInput {
  id: string
  alias?: string
  /** Mounts or unmounts only this bot's adapter. */
  enabled?: boolean
  settings?: ChatBotSettingsPatch
}

/** Input of the id-addressed calls `checkBot`, `retryBot`, and `removeBot`. */
export interface ChatBotIdInput {
  id: string
}

/** Outcome of `checkBot`; a platform failure is `ok: false`, never a thrown error. */
export interface CheckChatBotResult {
  ok: boolean
  /** Chinese explanation when `ok` is false. */
  message?: string
  checkedAt: number
}

/** A one-time owner pairing code and its absolute expiry. */
export interface ChatOwnerCode {
  /** Sent to a bot as `/pair <code>` in a private chat. */
  code: string
  /** Expiry in ms since the epoch. */
  expiresAt: number
}

/** Input of `unpairOwner`. */
export interface UnpairOwnerInput {
  /** A {@link ChatOwnerView.key}. */
  key: string
}

/** Stable reasons a `chatBots` call fails. */
export type ChatBotErrorCode =
  | 'invalid-input'
  | 'invalid-credentials'
  | 'unreachable'
  | 'duplicate-bot'
  | 'not-found'
  | 'bridge-unavailable'

/**
 * The failure every `chatBots` call reports. The carrier's error vocabulary is
 * closed, so the wire code is the registered `chat-bot-failed` and the
 * {@link ChatBotErrorCode} travels in `details.reason`; `message` is Chinese
 * and carries no secret.
 */
export interface ChatBotFailure {
  readonly code: 'chat-bot-failed'
  readonly message: string
  readonly details: { readonly reason: ChatBotErrorCode }
}

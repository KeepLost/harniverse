/**
 * The `ctx.chatBridge` service surface: adapter run state, owner pairing
 * management, and per-bot defaults for new owner sessions.
 * @module @deepseek-ai/dsh-chat-bridge/types
 */

/** Run state of one mounted adapter. */
export type AdapterRunState = 'running' | 'reconnecting' | 'credential-rejected' | 'conflict' | 'stopped'

/** An adapter's run state and, for every state but `running` and `stopped`, the sentence `/status` shows. */
export interface AdapterStatus {
  readonly state: AdapterRunState
  readonly message?: string
}

/** Defaults a bot applies to new sessions of owners. Members never read them. */
export interface ChatBotSettings {
  /** Absolute workspace directory for new sessions of owners. */
  workspace?: string
  /** Model for new sessions of owners. */
  model?: { provider: string; model: string; reasoningEffort?: string }
  /** Agent Preset id for new sessions of owners. */
  agentProfile?: string
}

/**
 * Settings of the bot `(platform, botId)`.
 * @returns the bot's settings, or undefined for none.
 */
export type BotSettingsProvider = (platform: string, botId: string) => ChatBotSettings | undefined

/** One owner identity. */
export interface OwnerView {
  /** `platform:userId`; the argument of {@link ChatBridgeService.unpairOwner}. */
  key: string
  platform: string
  userId: string
  /** Display name the owner had when redeeming a code. */
  displayName?: string
  /** Pairing time in ms since the epoch; `0` for an owner that exists only in the static configuration. */
  pairedAt: number
}

/** What a host plugin may read and manage on the running chat bridge. */
export interface ChatBridgeService {
  /**
   * Run state of one mounted adapter.
   * @param platform - platform id of the adapter.
   * @param botId - bot id of the adapter.
   * @returns the state, or undefined while the adapter is not attached.
   */
  adapterState(platform: string, botId: string): AdapterStatus | undefined
  /**
   * Issue a one-time owner pairing code, the way `dsh chat init` does.
   * @returns the plaintext code, shown once, and its absolute expiry in ms since the epoch.
   */
  issueOwnerCode(): Promise<{ code: string; expiresAt: number }>
  /**
   * Paired owners (bridge state `members` rows with role owner) plus configured owners.
   * @returns one view per owner identity, configured owners first.
   */
  owners(): readonly OwnerView[]
  /**
   * Remove a paired owner binding.
   * @param key - an {@link OwnerView.key}.
   * @returns false when the key is absent, not an owner, or an owner of the static configuration.
   */
  unpairOwner(key: string): Promise<boolean>
  /**
   * Provide per-bot defaults, consulted whenever a new session of an owner is created; the first provider
   * that returns settings for the bot wins.
   * @param provider - settings of the bot `(platform, botId)`, or undefined for none.
   * @returns a disposer that removes this registration.
   */
  useBotSettings(provider: BotSettingsProvider): () => void
}

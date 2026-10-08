/**
 * Chat bridge core: a function plugin that consumes `ctx.chatAdapters` and
 * `ctx.harniverseClient`, keeps its state in a storage domain, never listens
 * on a port, and provides `ctx.chatBridge` for hosts that embed it. It is a
 * Cordis app building block: `dsh chat` mounts it as a process of its own, and
 * the web composition's `chat-manager` mounts it embedded.
 * @module @deepseek-ai/dsh-chat-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ChatAdapter } from '@deepseek-ai/dsh-chat-adapter'
import type {} from '@deepseek-ai/dsh-chat-harniverse-client'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { Bridge } from './bridge.ts'
import { validateConfig, Config } from './members.ts'
import { timerSleep } from './messenger.ts'
import { bridgeDomainSpec } from './state.ts'
import type { ChatBridgeService } from './types.ts'

export { Config, DEFAULT_OWNER_CODE_TTL_MS, GRANTABLE_COMMANDS, validateConfig } from './members.ts'
export type { Config as BridgeConfig, ConfigInput, GrantableCommand, MemberConfig, OwnerConfig } from './members.ts'
export { COMMAND_TABLE, parseInput, type CommandName } from './commands.ts'
export { generateCode, hashCode, issueCode, redeemCode } from './pairing.ts'
export { bridgeDomainSpec, type BridgeState } from './state.ts'
export { splitMessageText } from './render.ts'
export type {
  AdapterRunState, AdapterStatus, BotSettingsProvider, ChatBotSettings, ChatBridgeService, OwnerView,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Management surface of the running chat bridge; present while the bridge row is mounted. */
    chatBridge: ChatBridgeService
  }

  interface Events {
    /**
     * A queued conversation task started or finished. Tasks of one conversation key never overlap.
     * @param info - the phase and the conversation key.
     * @mode emit
     */
    'chat-bridge/dispatch'(info: { phase: 'start' | 'end'; key: string }): void
  }
}

/** Stable Cordis plugin name. */
export const name = 'chat-bridge'
/** Services required before the bridge can start. */
export const inject = ['chatAdapters', 'harniverseClient', 'storageDomain']

/**
 * Start the bridge: validate the configuration, open durable state, open the
 * event streams, and run every registered adapter until the scope is disposed.
 * @param ctx - plugin context.
 * @param config - validated bridge configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  validateConfig(config)
  const state = await ctx.storageDomain.open(bridgeDomainSpec)
  const logger = ctx.logger
  // `appExit` is a launcher fact (dsh-cmdline); an embedded bridge never asks its host process to exit.
  const exit = config.embedded ? undefined : ctx.get('appExit') as ((code: number) => void) | undefined
  const bridge = new Bridge({
    config,
    state,
    client: ctx.harniverseClient,
    adapters: ctx.chatAdapters,
    log: {
      info: (message) => { logger.info(message) },
      warn: (message, error) => {
        logger.warn(message)
        if (error !== undefined) logger.warn(error)
      },
    },
    sleep: timerSleep,
    dispatched: (phase, key) => { ctx.emit('chat-bridge/dispatch', { phase, key }) },
    ...exit === undefined ? {} : { exit },
  })
  ctx.on('chat-adapter/registered', (adapter: ChatAdapter) => { bridge.attach(adapter) })
  ctx.on('chat-adapter/unregistered', (adapter: ChatAdapter) => { bridge.detach(adapter) })
  ctx.effect(() => async () => {
    await bridge.stop()
    await state.close()
  }, 'chat-bridge.lifecycle')
  ctx.provide('chatBridge', bridge.service())
  bridge.start()
}

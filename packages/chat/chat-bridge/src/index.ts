/**
 * Chat bridge core: a function plugin that consumes `ctx.chatAdapters` and
 * `ctx.harniverseClient`, keeps its state in a storage domain, and never
 * listens on a port. It is a standalone Cordis app building block; it adds no
 * plugin to the Harniverse web composition.
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

export { Config, DEFAULT_OWNER_CODE_TTL_MS, GRANTABLE_COMMANDS, validateConfig } from './members.ts'
export type { Config as BridgeConfig, ConfigInput, GrantableCommand, MemberConfig, OwnerConfig } from './members.ts'
export { COMMAND_TABLE, parseInput, type CommandName } from './commands.ts'
export { generateCode, hashCode, issueCode, redeemCode } from './pairing.ts'
export { bridgeDomainSpec, type BridgeState } from './state.ts'
export { splitMessageText } from './render.ts'

declare module '@deepseek-ai/cordis' {
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
  // `appExit` is a launcher fact (dsh-cmdline); the bridge only needs its call shape.
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
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
  bridge.start()
  ctx.effect(() => async () => {
    await bridge.stop()
    await state.close()
  }, 'chat-bridge.lifecycle')
}

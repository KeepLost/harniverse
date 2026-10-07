/** Test-only function-plugin provider row: mounts one stub adapter into `ctx.chatAdapters`. */

import type { Context } from '@deepseek-ai/cordis'
import { stubAdapter } from './stub-adapter.ts'

/** Stable Cordis plugin name. */
export const name = 'stub-adapter-provider'
/** Services required before the row can register. */
export const inject = ['chatAdapters']

/** Row config. */
interface Config {
  platform: string
  botId: string
}

/**
 * Mount one stub adapter for the row's fiber lifetime.
 * @param ctx - row context.
 * @param config - adapter identity.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.chatAdapters.register(stubAdapter(config.platform, config.botId)))
}

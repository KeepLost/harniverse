/** Test-only function-plugin provider row: registers one stub platform descriptor into `ctx.chatAdapters`. */

import type { Context } from '@deepseek-ai/cordis'
import { stubDescriptor } from './stub-descriptor.ts'

/** Stable Cordis plugin name. */
export const name = 'stub-platform-provider'
/** Services required before the row can register. */
export const inject = ['chatAdapters']

/** Row config. */
interface Config {
  platform: string
}

/**
 * Register one stub platform for the row's fiber lifetime.
 * @param ctx - row context.
 * @param config - platform identity.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.chatAdapters.registerPlatform(stubDescriptor(config.platform)))
}

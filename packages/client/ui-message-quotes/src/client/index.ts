/**
 * Blockquote presentation for sent Web user text: one sent-user-text rule and
 * its run renderer, registered into the conversation seam. Quoting changes
 * only the drawn text; the message text, copy actions, and model input keep
 * the original characters.
 *
 * @module @deepseek-ai/dsh-client-ui-message-quotes/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the conversation service face (ctx.conversation) this
// plugin registers its rule through — cross-plugin value imports are barred
// by the client bundle purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createQuoteRule } from './quote-rule.ts'

/** Required services: the conversation seam. */
export const inject = ['conversation']

/**
 * Register the blockquote matcher into the conversation's sent-user-text seam.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.conversation.sentUserText.register(createQuoteRule()), 'ui-message-quotes: sent-user-text rule')
}

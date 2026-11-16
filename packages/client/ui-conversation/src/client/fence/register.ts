/** Registration of the conversation flow's Markdown fence layers. */
import type { Context } from '@deepseek-ai/cordis'
import { NS } from '../locales.ts'
import { DiffFenceLayer, MathFenceLayer } from './FenceLayers.tsx'

/**
 * Register the flow's built-in fence layers into the language-keyed fence
 * slot; they follow its declaration and the plugin's lifetime. Ids stay
 * literal so the Client slot catalog can name each occupied layer.
 * @param ctx - the conversation plugin context.
 */
export function registerFenceLayers(ctx: Context): void {
  ctx.slots.inject('conversation.chat.markdown.fence', () => ctx.slots.register({
    name: 'conversation.chat.markdown.fence', key: 'math', id: '@deepseek-ai/dsh-client-ui-conversation/fence/math',
  }, MathFenceLayer))
  ctx.slots.inject('conversation.chat.markdown.fence', () => ctx.slots.register({
    name: 'conversation.chat.markdown.fence', key: 'diff', id: '@deepseek-ai/dsh-client-ui-conversation/fence/diff', locale: NS,
  }, DiffFenceLayer))
  ctx.slots.inject('conversation.chat.markdown.fence', () => ctx.slots.register({
    name: 'conversation.chat.markdown.fence', key: 'patch', id: '@deepseek-ai/dsh-client-ui-conversation/fence/diff', locale: NS,
  }, DiffFenceLayer))
}

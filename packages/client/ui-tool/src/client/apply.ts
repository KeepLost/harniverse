/** Register the Tool call tree, details renderer, and built-in atomic views. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ToolCallTree } from './tool/ToolCallTree.tsx'
import { ToolDetails } from './tool/ToolDetails.tsx'
import { CONVERSATION_NS as NS } from './locale.ts'
import { en, NS as TOOL_NS, zh } from './locales.ts'
import { askQuestionToolview } from './tool/toolviews/ask-question-row.tsx'
import { bashToolviewSample } from './tool/toolviews/bash-sample.tsx'
import { fileMutationToolview } from './tool/toolviews/file-mutation-row.tsx'
import { readToolview } from './tool/toolviews/read-row.tsx'
import { searchToolview } from './tool/toolviews/search-row.tsx'
import { todoToolview } from './tool/toolviews/todo-row.tsx'
import { webToolview } from './tool/toolviews/web-row.tsx'

/** Required services: the slot registry and the locale plugin. */
export const inject = ['slots', 'locale']

/**
 * Mount the whole-Tool renderers and built-in atomic Tool registrations.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(TOOL_NS, { zh, en }), 'ui-tool: tool dictionaries')

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'tool-call',
    locale: NS,
    children: {
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    },
    // The bound Tool-namespace translate is stable per namespace, so the
    // inject face never breaks the tree's memoization.
    inject: () => ({ tTool: ctx.locale.bind(TOOL_NS) }),
  }, ToolCallTree))

  ctx.slots.inject('conversation.details.tool', () => ctx.slots.register({
    name: 'conversation.details.tool',
    locale: NS,
  }, ToolDetails))

  ctx.plugin(bashToolviewSample)
  ctx.plugin(readToolview)
  ctx.plugin(fileMutationToolview)
  ctx.plugin(searchToolview)
  ctx.plugin(webToolview)
  ctx.plugin(todoToolview)
  ctx.plugin(askQuestionToolview)
}

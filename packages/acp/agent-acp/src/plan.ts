/**
 * The plan an external agent reports, shown as the session's standing todo
 * list. The list is the `todos` projection the todo tool owns; the fold is
 * installed here for sessions no todo tool drives.
 * @module @deepseek-ai/dsh-agent-acp/plan
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AcpPlanEntry } from '@deepseek-ai/dsh-acp-client'
import type { TodoItem } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tool-todo/types'
import { z as zod } from 'zod'

/** Wire payload of the `todos` projection: the whole list, or `null` before the first write. */
const todosSchema: zod.ZodType<TodoItem[] | null> = zod.union([
  zod.array(zod.object({
    content: zod.string(),
    status: zod.union([zod.literal('pending'), zod.literal('in_progress'), zod.literal('completed')]),
  })),
  zod.null(),
])

/** Read a plan entry's status as a todo status; one this harness does not know ends the entry. */
function todoStatus(status: string | undefined): TodoItem['status'] | undefined {
  if (status === 'in_progress' || status === 'completed') return status
  return status === undefined || status === 'pending' ? 'pending' : undefined
}

/**
 * Fold plan entries into the list the todo tool would write: trimmed,
 * unique, and none the agent cancelled.
 * @param entries - the entries of one plan report.
 * @returns the todo list.
 */
export function planTodos(entries: readonly AcpPlanEntry[]): TodoItem[] {
  const todos: TodoItem[] = []
  for (const entry of entries) {
    const content = entry.content.trim()
    const status = todoStatus(entry.status)
    if (content === '' || status === undefined || todos.some(todo => todo.content === content)) continue
    todos.push({ content, status })
  }
  return todos
}

/**
 * Install the `todos` projection for the sessions this preset drives. A
 * composition that mounts the todo tool leaves this out: one key, one unit.
 * @param ctx - the plugin's context.
 */
export function installPlanProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'todos', TodoItem[] | null>({
      key: 'todos',
      summary: false,
      schema: todosSchema,
      init: () => null,
      apply: (state, event) => event.type === 'todo/write' ? event.data.todos : state,
      view: state => state,
      stateVersion: 2,
    })
  })
}

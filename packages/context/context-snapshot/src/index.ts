/**
 * Durable runtime-context snapshots for the system-prompt contexts plane.
 *
 * @module @deepseek-ai/dsh-context-snapshot
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-compaction'

export const name = 'context-snapshot'
export const inject = ['agents', 'systemPrompt']

const SOURCE = '@deepseek-ai/dsh-context-snapshot'
const COMPLETE_FRAME = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
const PARTIAL_FRAME = 'Current runtime context has some updates.'
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

/** One owned durable message reduced to the terms the retained-state fold uses. */
type OwnedRecord =
  | { kind: 'cleared' }
  | { kind: 'complete'; sections: readonly ContextSnapshotSection[] }
  | { kind: 'partial'; sections: readonly ContextSnapshotSection[] }

function isOwned(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === SOURCE
}

function singleText(message: UserMessage): string | undefined {
  const [block] = message.content
  return message.content.length === 1 && block?.type === 'text' ? block.text : undefined
}

/**
 * Sections of one owned durable record, or undefined when the record is not a
 * usable snapshot.
 *
 * `agent.session.events` may be a resumed, forked, or externally written seed,
 * and seed validation only guarantees a source object with a non-empty `kind`;
 * no per-plugin field is checked there. An unreadable record is therefore
 * treated as "not this plugin's snapshot" — it contributes neither retained
 * state nor the published flag — rather than throwing inside a step or request
 * listener, which would fail every subsequent turn of that session.
 */
function readSnapshotSections(source: unknown): ContextSnapshotSection[] | undefined {
  const sections = (source as { sections?: unknown }).sections
  if (!Array.isArray(sections)) return undefined
  const readable: ContextSnapshotSection[] = []
  for (const section of sections as readonly unknown[]) {
    if (typeof section !== 'object' || section === null) return undefined
    const { name, text } = section as { name?: unknown; text?: unknown }
    if (typeof name !== 'string' || name === '' || typeof text !== 'string') return undefined
    readable.push({ name, text })
  }
  return readable
}

/**
 * Classify one owned message into the fold's terms.
 * @returns the record it contributes, or undefined when it is unusable.
 */
function ownedRecord(message: UserMessage): OwnedRecord | undefined {
  const { form } = message.source as { form?: unknown }
  if (form === undefined) {
    return singleText(message) === CLEARED ? { kind: 'cleared' } : undefined
  }
  if (form !== 'snapshot') return undefined
  const sections = readSnapshotSections(message.source)
  if (sections === undefined) return undefined
  return (message.source as { partial?: unknown }).partial === true
    ? { kind: 'partial', sections }
    : { kind: 'complete', sections }
}

/** Retained state re-derived from the session log on every emission decision. */
interface Retained {
  /** Effective section text by name, in the order the names were last introduced. */
  readonly sections: Map<string, string>
  /** The last visible usable record; undefined when none is visible. */
  readonly last: OwnedRecord['kind'] | undefined
  /** Whether any usable owned record is currently visible. */
  readonly visible: boolean
  /** Whether a usable owned record or cleared marker exists anywhere in the log. */
  readonly published: boolean
}

/**
 * Fold every visible owned message in event order into the retained state.
 * @param agent - the agent whose session log and surface decide the fold.
 * @returns the retained state, with no in-memory caching between calls.
 */
function retainedState(agent: Agent): Retained {
  const visibleNodes = new Set(agent.session.surface.nodes)
  const sections = new Map<string, string>()
  let last: OwnedRecord['kind'] | undefined
  let visible = false
  let published = false
  for (const event of agent.session.events) {
    if (event.type !== 'user/message' || !isOwned(event.data)) continue
    const record = ownedRecord(event.data)
    if (record === undefined) continue
    published = true
    if (!visibleNodes.has(event.seq)) continue
    visible = true
    last = record.kind
    if (record.kind === 'cleared') {
      sections.clear()
    } else if (record.kind === 'complete') {
      sections.clear()
      for (const section of record.sections) sections.set(section.name, section.text)
    } else {
      for (const section of record.sections) sections.set(section.name, section.text)
    }
  }
  return { sections, last, visible, published }
}

function completeMessage(sections: readonly ContextSnapshotSection[]): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `${COMPLETE_FRAME}\n\n${sections.map(s => s.text).join('\n\n')}` }],
    source: { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections },
  })
}

function partialMessage(changed: readonly ContextSnapshotSection[]): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `${PARTIAL_FRAME}\n\n${changed.map(s => s.text).join('\n\n')}` }],
    source: { kind: 'plugin', plugin: SOURCE, form: 'snapshot', partial: true, sections: changed },
  })
}

function clearedMessage(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: CLEARED }],
    // The cleared marker has no contributions left to attribute.
    source: { kind: 'plugin', plugin: SOURCE },
  })
}

/**
 * The durable message the current sections owe, or undefined when the retained
 * state already publishes exactly them.
 * @param retained - the log-derived retained state.
 * @param sections - the currently assembled context sections.
 * @returns the COMPLETE, PARTIAL, or CLEARED message due, if any.
 */
function snapshotMessage(retained: Retained, sections: readonly ContextSnapshotSection[]): UserMessage | undefined {
  if (sections.length === 0) {
    if (!retained.published || retained.last === 'cleared') return undefined
    return clearedMessage()
  }
  if (!retained.visible) return completeMessage(sections)
  const sameNames = retained.sections.size === sections.length
    && sections.every(section => retained.sections.has(section.name))
  if (!sameNames) return completeMessage(sections)
  const changed = sections.filter(section => retained.sections.get(section.name) !== section.text)
  return changed.length === 0 ? undefined : partialMessage(changed)
}

/**
 * Render the calling agent's current runtime-context sections.
 * @param ctx - context carrying the system-prompt service.
 * @param agent - the agent the assembly is scoped to.
 * @param signal - the controlling turn's signal, when one is live.
 * @returns the non-empty context sections of this assembly.
 */
async function currentSections(
  ctx: Context,
  agent: Agent,
  signal?: AbortSignal,
): Promise<ContextSnapshotSection[]> {
  return renderContextSections(await ctx.systemPrompt.assemble(assembleContextFor(agent, signal)))
}

/**
 * Durably append the message the current sections owe. The retained state is
 * re-derived after assembly completes — immediately before the append — so a
 * usable owned record that became visible in the meantime skips the append.
 */
function appendOwed(agent: Agent, sections: readonly ContextSnapshotSection[]): void {
  const message = snapshotMessage(retainedState(agent), sections)
  if (message !== undefined) agent.session.append('user/message', message, { surfaceOp: 'append' })
}

/**
 * Publish the system-prompt contexts plane as durable user-role runtime-context
 * snapshots: complete at session start and after the section name set changes
 * or compaction removes the retained snapshot, partial when only section texts
 * change, cleared when the last published state empties.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    const sections = await currentSections(ctx, agent, signal)
    signal.throwIfAborted()
    const message = snapshotMessage(retainedState(agent), sections)
    if (message === undefined) return decision
    return { kind: 'enter', messages: [message, ...decision.messages] }
  })

  ctx.on('agent/request', async ({ agent, signal }, next) => {
    const config = await next()
    try {
      // Compaction may complete inside this waterfall and shadow the retained
      // snapshot; the step boundary does not re-run before this request, so
      // the recovery is appended durably here and the request history is
      // rebuilt from the surface afterwards.
      const retained = retainedState(agent)
      if (!retained.published || retained.visible) return config
      appendOwed(agent, await currentSections(ctx, agent, signal))
    } catch (error: unknown) {
      // Context bookkeeping must never break the request it observes.
      ctx.logger.warn(`context-snapshot: request-boundary recovery failed: ${String(error)}`)
    }
    return config
  })

  ctx.on('session/event', (subject: Session, event) => {
    if (event.type !== 'compaction/end' || event.data.error !== undefined) return
    const agent = ctx.agents.get(subject.id)
    // In-flight turns and requests own their recovery through the listeners above.
    if (agent === undefined || agent.status !== 'idle') return
    void (async () => {
      appendOwed(agent, await currentSections(ctx, agent))
    })().catch((error: unknown) => {
      ctx.logger.warn(`context-snapshot: manual-compaction recovery failed: ${String(error)}`)
    })
  })
}

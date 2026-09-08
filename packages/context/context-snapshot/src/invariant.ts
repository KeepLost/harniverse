/** Package-owned durable runtime-context invariants. @module @deepseek-ai/dsh-context-snapshot/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-context-snapshot'
const SOURCE = '@deepseek-ai/dsh-context-snapshot'
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

/** Cordis companion plugin name. */
export const name = 'context-snapshot-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Whether one event is an owned user/message with usable durable sections or a cleared marker. */
function isUsableOwned(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = event.data.source as { kind?: unknown; plugin?: unknown; form?: unknown }
  if (source.kind !== 'plugin' || source.plugin !== SOURCE) return false
  if (source.form === undefined) {
    const [block] = event.data.content
    return event.data.content.length === 1 && block?.type === 'text' && block.text === CLEARED
  }
  if (source.form !== 'snapshot') return false
  const sections = (source as { sections?: unknown }).sections
  if (!Array.isArray(sections)) return false
  return sections.every(section => typeof section === 'object' && section !== null
    && typeof (section as { name?: unknown }).name === 'string' && (section as { name?: unknown }).name !== ''
    && typeof (section as { text?: unknown }).text === 'string')
}

/** Whether one event is an owned partial snapshot. */
function isPartialOwned(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = event.data.source as { kind?: unknown; plugin?: unknown; form?: unknown; partial?: unknown }
  return source.kind === 'plugin'
    && source.plugin === SOURCE
    && source.form === 'snapshot'
    && source.partial === true
}

/**
 * Validate every owned partial snapshot already present in one session log:
 * each visible partial must follow a visible usable owned record.
 */
function validateSession(session: Session, fail: InvariantFailure): void {
  const visible = new Set(session.surface.nodes)
  let preceded = false
  for (const event of session.events) {
    if (isPartialOwned(event) && visible.has(event.seq) && !preceded) {
      fail('a visible partial runtime-context snapshot must follow a visible usable owned record')
    }
    // A usable partial legitimately precedes later partials; it cannot precede itself.
    if (isUsableOwned(event) && visible.has(event.seq)) preceded = true
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Install validation for loaded and newly appended partial snapshots. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (!isPartialOwned(event)) return
    // The appended event is the one under test; its own visibility is the
    // append in progress, so only the preceding prefix decides.
    const visible = new Set(session.surface.nodes)
    const preceded = session.events.some(candidate => candidate.seq < event.seq
      && isUsableOwned(candidate) && visible.has(candidate.seq))
    if (!preceded) {
      fail('a visible partial runtime-context snapshot must follow a visible usable owned record')
    }
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the context-snapshot invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

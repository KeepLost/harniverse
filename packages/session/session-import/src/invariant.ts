/** Package-owned session-event invariants for foreign-session import. @module @deepseek-ai/dsh-session-import/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SUPERVISION_MODES } from '@deepseek-ai/dsh-supervision'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-import'

/** The foreign generations an import marker may name. */
const CLASSIFIED_FOREIGN_FORMATS = new Set<string>(['official-v1', 'official-v2', 'official-v3'])

/** Cordis companion plugin name. */
export const name = 'session-import-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/**
 * Validate one `import/record` event against the log before it: the marker is
 * the first event of its session, appears at most once, names a classified
 * foreign format (never `current` or `unknown`), a non-empty artifact name,
 * and a known supervision mode.
 */
function validateEvent(prior: SessionEvent[], event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'import/record') return
  if (prior.length > 0) {
    fail('import/record must be the first event of its session; imported history follows the marker')
    return
  }
  const format: unknown = event.data.source.format
  if (typeof format !== 'string' || !CLASSIFIED_FOREIGN_FORMATS.has(format)) {
    fail(`import/record source.format must name a classified foreign generation, got ${JSON.stringify(format)}`)
  }
  if (typeof event.data.source.artifactName !== 'string' || event.data.source.artifactName.length === 0) {
    fail('import/record source.artifactName must be a non-empty string naming the preserved source artifact')
  }
  if (!SUPERVISION_MODES.includes(event.data.posture.supervisionMode)) {
    fail(`import/record posture.supervisionMode must be one of ${SUPERVISION_MODES.join(', ')}`)
  }
}

/** Install validation for loaded and newly appended import markers. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    const prior: SessionEvent[] = []
    for (const event of session.events) {
      validateEvent(prior, event, fail)
      prior.push(event)
    }
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = (args as [Session, SessionEvent])
    validateEvent(session.events.filter(candidate => candidate.seq < event.seq), event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

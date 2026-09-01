/** Package-owned supervision event invariants. */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { SUPERVISION_MODES } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-supervision'

export const name = 'supervision-invariant'
export const inject = ['invariants']

function validateEvent(_ctx: Context, event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'supervision/mode' && !SUPERVISION_MODES.includes(event.data.mode)) {
    fail(`supervision/mode contains unknown mode ${JSON.stringify(event.data.mode)}`)
  }
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(ctx, event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    validateEvent(ctx, (args as [Session, SessionEvent])[1], fail)
  }, { global: true })
}, { inject: ['supervision', 'sessions'] })

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

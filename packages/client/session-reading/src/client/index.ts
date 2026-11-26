/**
 * Session-reading plugin, browser half. It mirrors the Host ledger and
 * publishes it as the optional `useSessionReading` root hook: the session list
 * reads each row's unread marker, reports whether it renders the selected
 * row, and offers the manual mark. The controller, not the list, decides when
 * the reader has seen a completed turn.
 * @module @deepseek-ai/dsh-client-session-reading/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote namespace and the ctx.remote merge
// through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the forwarded `sessionReading/changed` key this plugin subscribes to.
import type {} from '../types.ts'
import { SessionReadingController } from './controller.ts'
import type { ReadingPage, SessionReadingState } from './controller.ts'

export type {
  ReadingPage,
  ReadingSessions,
  SessionReadingRemote,
  SessionReadingState,
  SessionReadingUnread,
  SessionReadingUnreadRows,
} from './controller.ts'
export type { SessionReadingAction, SessionReadingRecord } from '../types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /**
     * Reading state of every session row: which are unread and whether their
     * latest completed turn failed, the manual mark, and the row-visibility
     * report. Absent while the session-reading plugin is not composed.
     */
    useSessionReading?: SnapshotSelectorHook<SessionReadingState>
  }
}

/** Services required by the browser half: the slot registry, the sessions feed, and the Remote namespace. */
export const inject = ['slots', 'sessions', 'remote', 'remote.sessionReading']

/**
 * Publish the reading ledger as a root hook and keep it current.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const controller = new SessionReadingController(ctx.remote.sessionReading, ctx.sessions, pageAttention())
  ctx.effect(() => controller.start(), 'session-reading: controller')
  ctx.effect(
    () => ctx.remote.$on('sessionReading/changed', () => { void controller.invalidate() }),
    'session-reading: ledger change signal',
  )
  ctx.on('connection/reset', () => { void controller.invalidate() })
  ctx.slots.provideRoot({ hooks: { sessionReading: controller } })
}

/** Page attention read from the document: visible and holding the window focus. */
function pageAttention(): ReadingPage {
  return {
    focused: () => document.visibilityState === 'visible' && document.hasFocus(),
    onFocusedChange: (listener) => {
      window.addEventListener('focus', listener)
      window.addEventListener('blur', listener)
      document.addEventListener('visibilitychange', listener)
      return () => {
        window.removeEventListener('focus', listener)
        window.removeEventListener('blur', listener)
        document.removeEventListener('visibilitychange', listener)
      }
    },
  }
}

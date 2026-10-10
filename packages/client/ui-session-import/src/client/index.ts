/**
 * Session-import plugin, browser half. Registers the "会话导入" settings
 * section — scan, select, and import the targeted machine's official
 * DeepSeek Harness sessions, or upload one log — over the typed
 * `officialSessionImport` Remote, its `settings.nav.icon` glyph, and an
 * archive dock in the conversation's input dock that keeps an imported
 * archive's composer inert and continues the archive in a new session.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-settings SlotMap merge (the settings.section list and the keyed settings.nav.icon).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input dock) and the ctx.conversation face.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ArchiveDock } from './ArchiveDock.tsx'
import {
  createArchiveDockController, createSessionImportController, type OfficialSessionImportRemote,
} from './controller.ts'
import { en, NS, zh, type SessionImportKey } from './locales.ts'
import { SessionImportNavIcon } from './NavIcon.tsx'
import { SessionImportSection } from './SessionImportSection.tsx'
import { createArchiveDockStore, createSessionImportStore } from './stores.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session-import section and archive dock copy. */
    sessionImport: SessionImportKey
  }
}

export type { ArchiveDockProps } from './ArchiveDock.tsx'
export type { ArchiveDockInjected, SessionImportInjected } from './controller.ts'
export type { SessionImportSectionProps } from './SessionImportSection.tsx'
export type { ArchiveDockState, SessionImportState } from './stores.ts'

/**
 * Required services: the slot registry, the locale seat, the connection (the
 * machine target and the preset roster wire), the Remote mount and its
 * `officialSessionImport` namespace (a host without the import Remote never
 * activates this plugin), and the sessions service.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.officialSessionImport', 'sessions']

/** Whether one `sessionImport` projection value marks an imported archive. */
function isArchive(value: unknown): boolean {
  return typeof value === 'object' && value !== null
}

/**
 * Client plugin body: register the dictionaries, the settings section, and the archive dock.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-session-import: dictionaries')
  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection') as ConnectionHandle
  const remote = ctx.get('remote.officialSessionImport') as OfficialSessionImportRemote
  const sessions = ctx.sessions

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'session-import',
    // After IM bots (21) and before Voice (25): importing history follows agent composition.
    order: 22,
    label: () => t('nav'),
    locale: NS,
    store: createSessionImportStore(),
    inject: actions => createSessionImportController({
      remote,
      sessions,
      machine: connection.target,
      copy: {
        tooLarge: (size, limit) => t('upload.tooLarge', { size, limit }),
        readError: message => t('upload.readError', { message }),
      },
    }, actions),
  }, SessionImportSection))
  ctx.slots.inject('settings.nav.icon', () => ctx.slots.register({
    name: 'settings.nav.icon',
    key: 'session-import',
  }, SessionImportNavIcon))

  // The composer cannot read this plugin (the dependency runs one way), so an
  // archive's block is pushed: each dock occurrence watches its session's
  // `sessionImport` projection for as long as the session scope lives.
  ctx.inject(['conversation'], (scope: ClientContext) => {
    const blocks = scope.conversation.blocks
    const watched = new Set<SessionId>()
    const watch = (sessionId: SessionId): void => {
      if (watched.has(sessionId)) return
      const face = sessions.binding(sessionId)?.session.projections.faceOf('sessionImport')
      const sessionScope = sessions.scope(sessionId)
      /* v8 ignore next -- a dock renders only for a listed session, which always has a binding and a scope. */
      if (face === undefined || sessionScope === undefined) return
      watched.add(sessionId)
      const publish = (): void => {
        blocks.set(sessionId, isArchive(face.getSnapshot()) ? { reason: t('composer.blocked') } : undefined)
      }
      publish()
      sessionScope.effect(() => {
        const stop = face.subscribe(publish)
        return () => {
          stop()
          watched.delete(sessionId)
          blocks.set(sessionId, undefined)
        }
      }, 'ui-session-import: archive composer block')
    }
    scope.slots.inject('conversation.input.dock', () => scope.slots.register({
      name: 'conversation.input.dock',
      id: 'session-import-archive',
      // The archive notice leads the dock: it replaces what the composer below can do.
      order: -100,
      locale: NS,
      store: createArchiveDockStore(),
      inject: (sessionId: SessionId, actions) => {
        watch(sessionId)
        return createArchiveDockController({ api: connection.api, sessions }, sessionId, actions)
      },
    }, ArchiveDock))
  })
}

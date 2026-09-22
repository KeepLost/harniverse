/**
 * Terminal panel, browser half: a sidebar footer trigger that occupies the
 * center column with the user's shell surface. The panel controller owns the
 * terminal list, the exclusive input attachment over the active terminal
 * (snapshot-then-deltas over the EventsApi terminal stream, bounded
 * slow-follower reattach), window holds for every running terminal, and the
 * create/rename/close/resize/write verbs over the shared `/api` logical
 * channel. Nothing here is model-facing: no tools, no session events.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the ui-layout SlotMap merge (the center view list).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the ui-sidebar SlotMap merge (the footer action list).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { TerminalPanelView } from './TerminalPanelView.tsx'
import { TerminalSidebarAction } from './TerminalSidebarAction.tsx'
import { TerminalPanelController } from './controller.ts'
import { createTerminalViewStore } from './view-store.ts'
import { en, NS, zh, type TerminalKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Terminal panel copy. */
    'terminal': TerminalKey
  }
}

export type {
  TerminalPanelInjected,
  TerminalPanelViewProps,
} from './TerminalPanelView.tsx'
export type { TerminalSidebarActionProps, TerminalSidebarFace } from './TerminalSidebarAction.tsx'

/** Required services for locale registration, the slots, the connection, and the layout exit. */
export const inject = ['slots', 'locale', 'layout', 'connection']

/**
 * Client plugin body: register the dictionaries, the sidebar footer trigger,
 * and the center terminal view. One occupancy store is shared by the trigger
 * and the view; the panel controller (list, follow stream, holds) lives as
 * long as the plugin fiber, so terminals keep running while the view is
 * closed and the controller's snapshot re-binds on remount.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-terminal: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new TerminalPanelController({ rpc: connection.rpc, events: connection.api.events })
  ctx.effect(() => () => { controller.dispose() }, 'ui-terminal: panel controller')
  const viewStore = createTerminalViewStore()
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'terminal-view',
    // After the browser trigger: interactive shell follows deliberate browsing.
    order: 40,
    locale: NS,
    store: viewStore,
    inject: () => ({
      openView: () => { ctx.layout.setCenterView('terminal') },
    }),
  }, TerminalSidebarAction))
  ctx.slots.inject('center.view', () => ctx.slots.register({
    name: 'center.view',
    id: 'terminal',
    locale: NS,
    store: viewStore,
    inject: () => ({
      closeView: () => { ctx.layout.clearCenterView() },
      hooks: { terminals: controller.state },
      bindSession: (sessionId: Parameters<TerminalPanelController['bindSession']>[0]) => {
        controller.bindSession(sessionId)
      },
      activate: controller.activate.bind(controller),
      create: controller.create.bind(controller),
      close: controller.close.bind(controller),
      rename: controller.rename.bind(controller),
      write: controller.write.bind(controller),
      resize: controller.resize.bind(controller),
      takeInput: controller.takeInput.bind(controller),
      bindSurface: controller.bindSurface.bind(controller),
    }),
  }, TerminalPanelView))
}

/**
 * Terminal panel, browser half: a workspace-workbench section (its tab beside
 * the shipped files/changes/search tabs) with the user's shell surface. The panel controller owns the
 * terminal list, the exclusive input attachment over the active terminal
 * (snapshot-then-deltas over the EventsApi terminal stream, bounded
 * slow-follower reattach), window holds for every running terminal, and the
 * create/rename/close/resize/write verbs over the shared `/api` logical
 * channel. Nothing here is model-facing: no tools, no session events.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the ui-layout Context merge (ctx.layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-theme Context merge (ctx.theme).
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { TerminalPanelView } from './TerminalPanelView.tsx'
import { TerminalSectionTab } from './TerminalSectionTab.tsx'
import { TerminalPanelController, type TerminalAppearance } from './controller.ts'
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
export type { TerminalSectionTabProps } from './TerminalSectionTab.tsx'

/**
 * Required services for locale registration, the slots, the connection, the
 * layout exit, and the theme revision the xterm.js presentation re-reads on.
 */
export const inject = ['slots', 'locale', 'layout', 'connection', 'theme']

/**
 * Client plugin body: register the dictionaries, the workbench section tab,
 * and the workbench section body. The panel controller (list, follow stream,
 * holds) lives as long as the plugin fiber, so terminals keep running while
 * another section shows and the controller's snapshot re-binds on remount.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-terminal: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new TerminalPanelController({ rpc: connection.rpc, events: connection.api.events })
  ctx.effect(() => () => { controller.dispose() }, 'ui-terminal: panel controller')
  // xterm.js renders from JavaScript values, so a palette or content
  // font-size change has to be pushed into it; the revision counter is the
  // panel's notification that the declared presentation must be re-read.
  const appearance = createSnapshotStore<TerminalAppearance>({ revision: ctx.theme.getTheme().revision })
  ctx.on('theme/change', (snapshot) => {
    appearance.set({ revision: snapshot.revision })
  })
  ctx.slots.inject('workbench.section.tab', () => ctx.slots.register({
    name: 'workbench.section.tab',
    id: 'terminal',
    order: 20,
    locale: NS,
  }, TerminalSectionTab))
  ctx.slots.inject('workbench.section.panel', () => ctx.slots.register({
    name: 'workbench.section.panel',
    id: 'terminal',
    locale: NS,
    inject: () => ({
      closeView: () => { ctx.layout.closeWorkbench() },
      hooks: { terminals: controller.state, appearance },
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

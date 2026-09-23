/**
 * Browser panel, browser half: a workspace-workbench section (its tab beside
 * the shipped files/changes/search tabs) with a page running on the harness
 * HOST. The panel controller owns the page list, the exclusive control
 * attachment over the active page (baseline-then-frames over the EventsApi
 * browser stream, bounded reattach), and the create/navigate/act/input/
 * resize/close verbs over the shared `/api` logical channel. The navigation
 * policy is the host controller's, not this half's: the page loads from the
 * host's network position, so the operator owns which destinations are
 * reachable. Nothing here is model-facing.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the ui-layout Context merge (ctx.layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { BrowserPanelView } from './BrowserPanelView.tsx'
import { BrowserSectionTab } from './BrowserSectionTab.tsx'
import { BrowserPanelController } from './controller.ts'
import { en, NS, zh, type BrowserKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Browser panel copy. */
    'browser': BrowserKey
  }
}

export type { BrowserPanelInjected, BrowserPanelViewProps } from './BrowserPanelView.tsx'
export type { BrowserSectionTabProps } from './BrowserSectionTab.tsx'
export {
  BrowserPanelController, type BrowserPanelDeps, type BrowserPanelState, type BrowserSurface,
} from './controller.ts'

/** Required services for locale registration, the slots, the connection, and the layout exit. */
export const inject = ['slots', 'locale', 'layout', 'connection']

/**
 * Client plugin body: register the dictionaries, the workbench section tab,
 * and the workbench section body. The panel controller (list, page stream)
 * lives as long as the plugin fiber, so host pages keep running while another
 * section shows and the controller's snapshot re-binds on remount.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-browser: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new BrowserPanelController({ rpc: connection.rpc, events: connection.api.events })
  ctx.effect(() => () => { controller.dispose() }, 'ui-browser: panel controller')
  ctx.slots.inject('workbench.section.tab', () => ctx.slots.register({
    name: 'workbench.section.tab',
    id: 'browser',
    order: 10,
    locale: NS,
  }, BrowserSectionTab))
  ctx.slots.inject('workbench.section.panel', () => ctx.slots.register({
    name: 'workbench.section.panel',
    id: 'browser',
    locale: NS,
    inject: () => ({
      closeView: () => { ctx.layout.closeWorkbench() },
      hooks: { panel: controller.state },
      bindSession: (sessionId: Parameters<BrowserPanelController['bindSession']>[0]) => {
        controller.bindSession(sessionId)
      },
      activate: controller.activate.bind(controller),
      create: controller.create.bind(controller),
      close: controller.close.bind(controller),
      navigate: controller.navigate.bind(controller),
      act: controller.act.bind(controller),
      input: controller.input.bind(controller),
      resize: controller.resize.bind(controller),
      takeInput: controller.takeInput.bind(controller),
      bindSurface: controller.bindSurface.bind(controller),
    }),
  }, BrowserPanelView))
}

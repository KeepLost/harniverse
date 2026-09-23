/**
 * Browser panel, browser half: a sidebar footer trigger that occupies the
 * center column with a page running on the harness HOST. The panel controller
 * owns the page list, the exclusive control attachment over the active page
 * (baseline-then-frames over the EventsApi browser stream, bounded reattach),
 * and the create/navigate/act/input/resize/close verbs over the shared `/api`
 * logical channel. The navigation policy is the host controller's, not this
 * half's: the page loads from the host's network position, so the operator owns
 * which destinations are reachable. Nothing here is model-facing.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the ui-layout SlotMap merge (the center view list).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the ui-sidebar SlotMap merge (the footer action list).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { BrowserCenterView } from './BrowserCenterView.tsx'
import { BrowserSidebarAction } from './BrowserSidebarAction.tsx'
import { BrowserPanelController } from './controller.ts'
import { createBrowserViewStore } from './view-store.ts'
import { en, NS, zh, type BrowserKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Browser panel copy. */
    'browser': BrowserKey
  }
}

export type { BrowserPanelInjected, BrowserCenterViewProps } from './BrowserCenterView.tsx'
export type { BrowserSidebarActionProps, BrowserSidebarFace } from './BrowserSidebarAction.tsx'
export {
  BrowserPanelController, type BrowserPanelDeps, type BrowserPanelState, type BrowserSurface,
} from './controller.ts'
export { createBrowserViewStore, type BrowserViewState } from './view-store.ts'

/** Required services for locale registration, the slots, the connection, and the layout exit. */
export const inject = ['slots', 'locale', 'layout', 'connection']

/**
 * Client plugin body: register the dictionaries, the sidebar footer trigger,
 * and the center browser view. One occupancy store is shared by the trigger
 * and the view; the panel controller (list, page stream) lives as long as the
 * plugin fiber, so host pages keep running while the view is closed and the
 * controller's snapshot re-binds on remount.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-browser: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new BrowserPanelController({ rpc: connection.rpc, events: connection.api.events })
  ctx.effect(() => () => { controller.dispose() }, 'ui-browser: panel controller')
  const viewStore = createBrowserViewStore()
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'browser-view',
    // After the governor board: deliberate web browsing follows telemetry.
    order: 30,
    locale: NS,
    store: viewStore,
    inject: () => ({
      openView: () => { ctx.layout.setCenterView('browser') },
    }),
  }, BrowserSidebarAction))
  ctx.slots.inject('center.view', () => ctx.slots.register({
    name: 'center.view',
    id: 'browser',
    locale: NS,
    store: viewStore,
    inject: () => ({
      closeView: () => { ctx.layout.clearCenterView() },
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
  }, BrowserCenterView))
}

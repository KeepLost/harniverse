/**
 * Browser carrier panel, browser half: a sidebar footer trigger that
 * occupies the center column with an embedded-browser surface — URL bar,
 * sandboxed iframe, and app-owned session history (back/forward/reload over
 * the panel's own trail, never browser history). Every submission passes
 * the pure navigation policy first; refusals render inline and never reach
 * the frame. The optional host allowlist rides the `browser` settings
 * section (registered by the node half) through the client settings scope,
 * so deployment policy reaches the panel live.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-layout SlotMap merge (the center view list).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the ui-sidebar SlotMap merge (the footer action list).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the ui-settings Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { BrowserCenterView, type BrowserPanelSettings } from './BrowserCenterView.tsx'
import { BrowserSidebarAction } from './BrowserSidebarAction.tsx'
import { createBrowserViewStore } from './history.ts'
import { en, NS, zh, type BrowserKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Browser panel copy. */
    'browser': BrowserKey
  }
}

export type {
  BrowserCenterInjected,
  BrowserCenterViewProps,
  BrowserPanelSettings,
} from './BrowserCenterView.tsx'
export type { BrowserSidebarActionProps, BrowserSidebarFace } from './BrowserSidebarAction.tsx'

/**
 * Settings namespace of the browser panel's section. Spelled here rather
 * than imported: a client package must not depend on a Host package's
 * runtime values, and the node half owns the same spelling.
 */
const BROWSER_SETTINGS_NS = 'browser'

/** Required services for locale registration, the slots, the settings scope, and the layout exit. */
export const inject = ['slots', 'locale', 'settingsScope', 'layout']

/**
 * Client plugin body: register the dictionaries, the sidebar footer trigger,
 * and the center browser view sharing one store (the view writes occupancy,
 * the trigger reads it; the history trail survives view remounts).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-browser: dictionaries')
  // One store instance shared by the trigger and the view.
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
  const scope = ctx.settingsScope.bind<BrowserPanelSettings>({ namespace: BROWSER_SETTINGS_NS })
  ctx.slots.inject('center.view', () => ctx.slots.register({
    name: 'center.view',
    id: 'browser',
    locale: NS,
    store: viewStore,
    inject: () => ({
      closeView: () => { ctx.layout.clearCenterView() },
      hooks: { config: scope },
      selfOrigin: location.origin,
    }),
  }, BrowserCenterView))
}

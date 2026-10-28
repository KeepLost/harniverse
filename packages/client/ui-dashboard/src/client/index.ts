/**
 * Dashboard, browser half: a sidebar footer trigger that occupies the center
 * column with one in-page tab ring over plugin-contributed management
 * surfaces (schedules, remote hosts, resources, queue) through the
 * `dashboard.center.tab` slot. The shell owns only the chrome — title,
 * dismissal, tab selection, and occupancy for the trigger's pressed
 * affordance — while every tab is self-sufficient through its own inject
 * face, so a domain package can contribute or leave without touching the
 * shell.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-layout SlotMap merge (the center view list).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the ui-sidebar SlotMap merge (the footer action list).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { DashboardView, type DashboardTabsSource } from './DashboardView.tsx'
import { DashboardSidebarAction } from './DashboardSidebarAction.tsx'
import { createDashboardViewStore } from './stores.ts'
import { en, NS, zh, type DashboardKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Dashboard copy. */
    'dashboard': DashboardKey
  }
  interface SlotMap {
    /**
     * One in-page tab of the dashboard (仪表盘) center view. Entries render
     * in ascending `order` as the tab ring; each renders its own surface
     * when active. The shell passes nothing: a tab is self-sufficient
     * through its own inject face (the schedules tab holds the scheduler
     * Remote verbs, the resources tab the governor Remote verbs).
     */
    'dashboard.center.tab': { kind: 'list'; scope: 'root'; owner: DashboardCenterTabOwnerProps }
  }
}

/** Owner share of one dashboard tab: deliberately empty — every tab is self-sufficient. */
export interface DashboardCenterTabOwnerProps {}

export type { DashboardSidebarActionProps, DashboardSidebarFace } from './DashboardSidebarAction.tsx'
export type { DashboardCenterActions, DashboardViewProps } from './DashboardView.tsx'

/** Required services for locale registration, the slots, and the layout exit. */
export const inject = ['slots', 'locale', 'layout']

/**
 * Client plugin body: register the dictionaries, the sidebar footer trigger,
 * and the tabbed center view.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-dashboard: dictionaries')
  // One store instance shared by the trigger and the view: the view writes
  // occupancy on mount/unmount, the trigger reads it.
  const viewStore = createDashboardViewStore()
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dashboard-view',
    // After the Cordis panel: management surfaces follow process state.
    order: 10,
    locale: NS,
    store: viewStore,
    inject: () => ({
      openView: () => { ctx.layout.setCenterView('dashboard') },
    }),
  }, DashboardSidebarAction))
  // The tab ledger over the dashboard.center.tab registry: same shape as the
  // conversation view ring (version-keyed subscription, list on render).
  const tabs: DashboardTabsSource = {
    list: () => {
      const descriptors: { id: string; label: string }[] = []
      for (const entry of ctx.slots.entries('dashboard.center.tab')) {
        /* v8 ignore next 2 -- unreachable: list registration validates id at load. */
        if (entry.options.id === undefined) continue
        const label = typeof entry.options.label === 'function' ? entry.options.label() : entry.options.label
        descriptors.push({ id: entry.options.id, label: label ?? entry.options.id })
      }
      return descriptors
    },
    subscribe: fn => ctx.slots.subscribe('dashboard.center.tab', fn),
    version: () => ctx.slots.getVersion('dashboard.center.tab'),
  }

  ctx.slots.inject('center.view', () => ctx.slots.register({
    name: 'center.view',
    id: 'dashboard',
    locale: NS,
    store: viewStore,
    children: {
      'dashboard.center.tab': { kind: 'list', scope: 'root' },
    },
    inject: () => ({
      closeView: () => { ctx.layout.clearCenterView() },
      tabs,
    }),
  }, DashboardView))
}

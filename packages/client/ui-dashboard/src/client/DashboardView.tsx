import { useEffect, useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createDashboardViewStore } from './stores.ts'
import { NS } from './locales.ts'
import css from './DashboardView.module.css'

/** Injected business face of the shell (view dismissal plus the tab ledger). */
export interface DashboardCenterActions {
  closeView: () => void
  /** Tab descriptors resolved from the `dashboard.center.tab` slot registry. */
  tabs: DashboardTabsSource
}

/** One in-page tab descriptor: entry id plus its resolved label. */
export interface DashboardTabDescriptor {
  id: string
  label: string
}

/** The entries face the apply world derives from the tab slot registry. */
export interface DashboardTabsSource {
  list: () => readonly DashboardTabDescriptor[]
  subscribe: (fn: () => void) => () => void
  version: () => number
}

/** Full props composed by the dashboard center-view slot. */
export type DashboardViewProps =
  PropsRuntime<'center.view'>
  & PropsStore<ReturnType<typeof createDashboardViewStore>>
  & InjectFace<DashboardCenterActions>
  & PropsRenderSlots<'dashboard.center.tab'>
  & PropsLocale<typeof NS>

/**
 * The dashboard panel shell (仪表盘): title and dismissal, the in-page tab
 * ring over the `dashboard.center.tab` contributions, and the active tab's
 * surface. With a single contribution the tab ring stays hidden and the view
 * reads as the plain surface it hosts.
 * @param props - center slot currency, the shared store, the tabs ledger, the child renderer, and the translator.
 * @returns the panel shell.
 */
export function DashboardView({ actions, closeView, tabs, useStore, renderSlot, t }: DashboardViewProps) {
  useEffect(() => { actions.setOpen(true); return () => { actions.setOpen(false) } }, [actions])
  useSyncExternalStore(tabs.subscribe, tabs.version)
  const tab = useStore(state => state.tab)
  const descriptors = tabs.list()
  const active = descriptors.find(descriptor => descriptor.id === tab) ?? descriptors[0]
  return (
    <section className={css.view} aria-label={t('view.title')}>
      <header className={css.header}>
        <h2 className={css.title}>{t('view.title')}</h2>
        <div className={css.headerActions}>
          <button type="button" className={css.button} onClick={closeView}>{t('view.close')}</button>
        </div>
      </header>
      {descriptors.length > 1 ? (
        <div className={css.tabs} role="tablist">
          {descriptors.map(descriptor => (
            <button
              key={descriptor.id}
              type="button"
              role="tab"
              aria-selected={descriptor.id === active?.id}
              className={descriptor.id === active?.id ? `${css.tab} ${css.tabActive}` : css.tab}
              onClick={() => { actions.setTab(descriptor.id) }}
            >
              {descriptor.label}
            </button>
          ))}
        </div>
      ) : null}
      {active !== undefined ? renderSlot('dashboard.center.tab', {}, { only: active.id }) : null}
    </section>
  )
}

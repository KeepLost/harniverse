import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { createDashboardViewStore } from './stores.ts'
import { NS } from './locales.ts'
import css from './DashboardSidebarAction.module.css'

/** Injected business face of the sidebar footer trigger. */
export interface DashboardSidebarFace {
  /** Occupy the center column with the dashboard. */
  openView: () => void
}

/** Full props composed by the sidebar footer-action slot. */
export type DashboardSidebarActionProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createDashboardViewStore>>
  & InjectFace<DashboardSidebarFace>
  & PropsLocale<typeof NS>

/**
 * Sidebar footer trigger for the dashboard: a full-width row in the wide
 * sidebar, a round icon button on the rail. The pressed affordance mirrors
 * actual occupancy (the view writes the store fact on mount/unmount), so it
 * clears when a session switch dismisses the view.
 * @param props - footer slot currency, the shared view store, the open verb, and the translator.
 * @returns the footer trigger button.
 */
export function DashboardSidebarAction({ wide, useStore, openView, t }: DashboardSidebarActionProps) {
  const open = useStore(state => state.open)
  return (
    <button
      type="button"
      className={wide ? css.row : css.rail}
      data-active={open || undefined}
      aria-pressed={open}
      aria-label={t('view.open')}
      title={t('view.nav')}
      onClick={openView}
    >
      <IconDataOutline16 />
      {wide ? <span className={css.label}>{t('view.nav')}</span> : null}
    </button>
  )
}

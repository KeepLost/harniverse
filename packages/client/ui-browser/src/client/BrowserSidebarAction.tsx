import { IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createBrowserViewStore } from './history.ts'
import { NS } from './locales.ts'
import css from './BrowserSidebarAction.module.css'

/** Injected business face of the sidebar footer trigger. */
export interface BrowserSidebarFace {
  /** Occupy the center column with the browser panel. */
  openView: () => void
}

/** Full props composed by the sidebar footer-action slot. */
export type BrowserSidebarActionProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createBrowserViewStore>>
  & InjectFace<BrowserSidebarFace>
  & PropsLocale<typeof NS>

/**
 * Sidebar footer trigger for the browser panel: a full-width row in the
 * wide sidebar, a round icon button on the rail. The pressed affordance
 * mirrors actual occupancy (the panel writes the store fact on
 * mount/unmount), so it clears when a session switch dismisses the view.
 * @param props - footer slot currency, the shared view store, the open verb, and the translator.
 * @returns the footer trigger button.
 */
export function BrowserSidebarAction({ wide, useStore, openView, t }: BrowserSidebarActionProps) {
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
      <IconBrowseOutline16 />
      {wide ? <span className={css.label}>{t('view.nav')}</span> : null}
    </button>
  )
}

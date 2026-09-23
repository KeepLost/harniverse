import { IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createTerminalViewStore } from './view-store.ts'
import { NS } from './locales.ts'
import css from './TerminalSidebarAction.module.css'

/** Injected business face of the sidebar footer trigger. */
export interface TerminalSidebarFace {
  /** Occupy the center column with the terminal panel. */
  openView: () => void
}

/** Full props composed by the sidebar footer-action slot. */
export type TerminalSidebarActionProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createTerminalViewStore>>
  & InjectFace<TerminalSidebarFace>
  & PropsLocale<typeof NS>

/**
 * Sidebar footer trigger for the terminal panel: a full-width row in the
 * wide sidebar, a round icon button on the rail. The pressed affordance
 * mirrors actual occupancy (the panel writes the store fact on
 * mount/unmount), so it clears when a session switch dismisses the view.
 * @param props - footer slot currency, the shared view store, the open verb, and the translator.
 * @returns the footer trigger button.
 */
export function TerminalSidebarAction({ wide, useStore, openView, t }: TerminalSidebarActionProps) {
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
      <IconCodeOutline16 />
      {wide ? <span className={css.label}>{t('view.nav')}</span> : null}
    </button>
  )
}

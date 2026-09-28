/** Sidebar footer trigger for the remote-hosts center view. */
import { IconGlobeOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createRemoteHostsViewStore } from './stores.ts'
import { NS } from './locales.ts'
import css from './RemoteHostsSidebarAction.module.css'

export type RemoteHostsSidebarActionProps = PropsRuntime<'sidebar.footer.action'> & PropsStore<ReturnType<typeof createRemoteHostsViewStore>> & InjectFace<{ openView: () => void }> & PropsLocale<typeof NS>

export function RemoteHostsSidebarAction({ wide, useStore, openView, t }: RemoteHostsSidebarActionProps) {
  const open = useStore(state => state.open)
  return <button type="button" className={wide ? css.row : css.rail} data-active={open || undefined} aria-pressed={open} aria-label={t('open')} title={t('nav')} onClick={openView}>
    <IconGlobeOutline14 size={wide ? 16 : 18} />
    {wide ? <span className={css.label}>{t('nav')}</span> : null}
  </button>
}

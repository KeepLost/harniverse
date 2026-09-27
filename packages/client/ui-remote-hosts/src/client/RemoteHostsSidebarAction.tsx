import { IconGlobeOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createRemoteHostsViewStore } from './stores.ts'
import { NS } from './locales.ts'
import css from './remote-hosts.module.css'

export type RemoteHostsSidebarActionProps = PropsRuntime<'sidebar.footer.action'> & PropsStore<ReturnType<typeof createRemoteHostsViewStore>> & InjectFace<{ openView: () => void }> & PropsLocale<typeof NS>

export function RemoteHostsSidebarAction({ wide, useStore, openView, t }: RemoteHostsSidebarActionProps) {
  const open = useStore(state => state.open)
  return <button type="button" className={wide ? css.navRow : css.navRail} data-active={open || undefined} aria-pressed={open} aria-label={t('open')} title={t('open')} onClick={openView}>
    <IconGlobeOutline14 />{wide ? <span>{t('nav')}</span> : null}
  </button>
}

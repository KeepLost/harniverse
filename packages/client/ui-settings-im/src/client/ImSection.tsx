/**
 * The "IM 机器人" settings section: a channel column driven by the host's
 * platform descriptors, and the selected channel's panel. The section polls
 * the host snapshot while it is mounted (the settings shell mounts only the
 * active section) and every mutation refetches through the controller.
 */
import { useEffect, useMemo } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceChoice } from './BotSettings.tsx'
import { ChannelList } from './ChannelList.tsx'
import { ChannelPanel } from './ChannelPanel.tsx'
import type { ImInjected } from './controller.ts'
import { botsOf } from './format.ts'
import type { NS } from './locales.ts'
import { startPolling } from './poll.ts'
import type { createImStore } from './stores.ts'
import controls from './controls.module.css'
import css from './ImSection.module.css'

/** Full props composed by the `settings.section` slot. */
export type ImSectionProps =
  PropsRuntime<'settings.section'>
  & PropsStore<ReturnType<typeof createImStore>>
  & PropsLocale<typeof NS>
  & InjectFace<ImInjected>

/**
 * Render the IM settings section.
 * @param props - the settings-section currency, the store seat, the operation face, and the translator.
 * @returns the section element.
 */
export function ImSection(props: ImSectionProps) {
  const { t, useStore, actions, useWorkspaces, refresh, loadCatalog, pollMs } = props
  const state = useStore(snapshot => snapshot)
  const registered = useWorkspaces(list => list.items)
  const workspaces = useMemo<WorkspaceChoice[]>(
    () => registered.map(workspace => ({ path: workspace.path, title: workspace.title })),
    [registered],
  )
  useEffect(() => startPolling(() => { void refresh() }, pollMs), [refresh, pollMs])
  useEffect(() => { void loadCatalog() }, [loadCatalog])

  const snapshot = state.snapshot
  const platforms = snapshot?.platforms ?? []
  const platform = platforms.find(entry => entry.platform === state.selected) ?? platforms[0]
  const bridge = snapshot?.bridge ?? 'running'
  // The host starts the bridge with the first bot, so a stopped bridge with no bots is the normal idle state.
  const idle = bridge === 'stopped' && snapshot?.bots.length === 0
  const failure = state.loadError === null ? null : t('loadError', { message: state.loadError.message })
  return (
    <section className={css.section} aria-label={t('title')}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {bridge === 'running' || idle
        ? null
        : (
          <p className={css.banner} role="status">
            {bridge === 'starting'
              ? t('bridge.starting')
              : bridge === 'stopped'
                ? t('bridge.stopped')
                : snapshot?.bridgeMessage === undefined
                  ? t('bridge.errorBare')
                  : t('bridge.error', { message: snapshot.bridgeMessage })}
          </p>
        )}
      {failure === null
        ? null
        : (
          <div className={css.failure}>
            <p className={css.failureText} role="alert">{failure}</p>
            <Button size="sm" variant="outline" onClick={() => { void refresh() }}>{t('retry')}</Button>
          </div>
        )}
      {state.phase === 'loading' ? <p className={css.status} role="status">{t('loading')}</p> : null}
      {snapshot !== null && platform === undefined ? <p className={controls.hint}>{t('noPlatforms')}</p> : null}
      {snapshot !== null && platform !== undefined
        ? (
          <div className={css.layoutHost}>
            <div className={css.layout}>
              <ChannelList
                platforms={platforms}
                bots={snapshot.bots}
                selected={platform.platform}
                onSelect={actions.select}
                t={t}
              />
              <ChannelPanel
                platform={platform}
                bots={botsOf(snapshot.bots, platform.platform)}
                owners={snapshot.owners.filter(owner => owner.platform === platform.platform)}
                state={state}
                workspaces={workspaces}
                face={props}
                actions={actions}
                t={t}
              />
            </div>
          </div>
        )
        : null}
    </section>
  )
}

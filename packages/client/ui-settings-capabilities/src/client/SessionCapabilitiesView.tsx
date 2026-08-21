/** Read-only Session generation assembly result. */

import { useEffect, useState, type ReactNode } from 'react'
import type { SessionCapabilitySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CapabilityCompositionLocaleKey } from './locales.ts'
import css from './SessionCapabilitiesView.module.css'

export interface SessionCapabilitiesViewInjected {
  load: () => Promise<SessionCapabilitySnapshot>
}

type SessionCapabilitiesViewProps = PropsRuntime<'conversation.view'>
  & PropsLocale<'settings.capabilityComposition'>
  & InjectFace<SessionCapabilitiesViewInjected>

const STATUS_KEYS = {
  loaded: 'statusLoaded',
  'not-loaded': 'statusNotLoaded',
  'load-failed': 'statusLoadFailed',
  'dependency-blocked': 'statusDependencyBlocked',
  'security-denied': 'statusSecurityDenied',
} as const satisfies Record<SessionCapabilitySnapshot['entries'][number]['status'], CapabilityCompositionLocaleKey>

export function SessionCapabilitiesView(props: SessionCapabilitiesViewProps): ReactNode {
  const [snapshot, setSnapshot] = useState<SessionCapabilitySnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const { load } = props

  useEffect(() => {
    let active = true
    setFailed(false)
    void load().then(
      (value) => { if (active) setSnapshot(value) },
      () => { if (active) setFailed(true) },
    )
    return () => { active = false }
  }, [load])

  if (failed) return <p className={css.status} role="alert">{props.t('sessionError')}</p>
  if (snapshot === null) return <p className={css.status}>{props.t('sessionLoading')}</p>

  return (
    <div className={css.view}>
      <header className={css.header}>
        <span>{props.t('sessionProfile')}: <strong>{snapshot.agentProfile ?? '-'}</strong></span>
        <span>{props.t('sessionGeneration')}: <code>{snapshot.generation ?? '-'}</code></span>
      </header>
      <ul className={css.list}>
        {snapshot.entries.map(entry => (
          <li key={entry.id} data-status={entry.status}>
            <div>
              <strong>{entry.name}</strong>
              <small>{entry.owner ?? entry.id}</small>
            </div>
            <span>{props.t(STATUS_KEYS[entry.status])}</span>
            {entry.reason === undefined ? null : <p>{entry.reason}</p>}
          </li>
        ))}
      </ul>
    </div>
  )
}

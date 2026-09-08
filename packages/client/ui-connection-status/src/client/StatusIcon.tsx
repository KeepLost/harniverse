import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionHealthSource } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from './index.ts'
import css from './StatusIcon.module.css'

type Props = PropsRuntime<'sidebar.header.status'> & PropsLocale<'connectionStatus'>
  & InjectFace<{ hooks: { health: ConnectionHealthSource } }>

/** Read-only health indicator; mounting or focusing it never starts network work. */
export function StatusIcon({ useHealth, t, wide }: Props) {
  const state = useHealth(state => state)
  const label = t(state)
  const busy = state === 'connecting' || state === 'renewing' || state === 'recovering'
  const path = state === 'required' ? 'M8 4v5m0 2v1'
    : state === 'reconnecting' ? 'M4 4l8 8'
      : busy ? 'M8 2a6 6 0 0 1 6 6'
        : 'M4 8l3 3 5-6'
  return (
    <Tooltip label={label} side={wide ? 'bottom' : 'right'} delayMs={500} maxWidth={280}>
      <span className={css.indicator} data-state={state} role="img" aria-label={label} tabIndex={0}
        onPointerDown={(event) => { if (event.pointerType === 'touch') event.currentTarget.focus() }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <circle cx="8" cy="8" r="6" opacity={busy ? 0.25 : 1} />
          <path d={path} className={busy ? css.busy : undefined} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </Tooltip>
  )
}

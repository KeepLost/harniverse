/**
 * The model-profile chip on the new-session screen, beside the agent-preset
 * chip. It renders nothing while the deployment configures no profiles beyond
 * the built-in unrestricted one — a choice of one is not a choice.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the hero seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ModelProfileOption, ModelProfileSeatState } from './hero-store.ts'
import css from './ModelProfileSeat.module.css'

/** Registration-side business face for the hero chip. */
export interface ModelProfileSeatInjected {
  hooks: {
    /** Seat snapshot bound by the renderer as useModelProfileSeat. */
    modelProfileSeat: SnapshotStore<ModelProfileSeatState>
  }
  /** Read the roster when the chip first renders. */
  load: () => Promise<void>
  /** Re-read the current session's profile when the chip first renders. */
  refreshSession: () => Promise<void>
  /** Reconcile a staged pick once its session is current. */
  apply: () => Promise<void>
  /** Stage one profile and apply it. */
  select: (id: string) => void
}

/** Full component props. */
export type ModelProfileSeatProps =
  PropsRuntime<'conversation.hero.modelProfile'>
  & PropsLocale<'model'>
  & InjectFace<ModelProfileSeatInjected>

/** Localized display name of one roster row; the built-in id gets product copy. */
function optionLabel(option: ModelProfileOption, unrestricted: string): string {
  return option.unrestricted ? unrestricted : option.name
}

/**
 * Render the new-session model-profile chip.
 * @param props - composed slot props.
 * @returns the chip, or null while no profile besides the built-in exists.
 */
export function ModelProfileSeat(props: ModelProfileSeatProps): ReactNode {
  const { load, refreshSession, apply, select, useModelProfileSeat, t } = props
  const state = useModelProfileSeat(snapshot => snapshot)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void load()
    // The sessions-list subscription reconciles later moves; the mount read
    // covers a session that became current before this chip registered.
    void refreshSession().then(() => apply())
  }, [load, refreshSession, apply])

  // Nothing to choose between: only the built-in unrestricted profile exists.
  if (state.options.length <= 1) return null

  const chosen = state.options.find(option => option.id === state.current)
  const chosenText = chosen === undefined
    ? t('seat.selectAria')
    : optionLabel(chosen, t('seat.unrestricted'))

  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={state.options.map(option => ({
        id: option.id,
        label: optionLabel(option, t('seat.unrestricted')),
        disabled: state.busy,
      }))}
      selectedId={state.current === '' ? undefined : state.current}
      onSelect={(id) => {
        setOpen(false)
        select(id)
      }}
      align="start"
      anchor={(
        <button
          type="button"
          className={css.seat}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('seat.aria', { profile: chosenText })}
          title={state.error ?? t('seat.hint')}
          disabled={state.busy}
          onClick={() => { setOpen(value => !value) }}
        >
          <span className={css.label}>{t('seat.profile')}</span>
          <span className={css.value}>{chosenText}</span>
          <IconChevronDownOutline14 className={css.chevron} />
        </button>
      )}
    />
  )
}

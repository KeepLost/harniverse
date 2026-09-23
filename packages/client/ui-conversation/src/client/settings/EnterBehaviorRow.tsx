/** General Settings row for the Composer's busy-state Enter preference. */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BusyEnterBehavior } from '../contract/composer-submission.ts'
import type { ConversationKey } from '../locales.ts'
import { PreferenceSelectRow } from './PreferenceSelectRow.tsx'

/** Registration-side preference face. */
export interface EnterBehaviorRowInjected {
  hooks: {
    /** Persisted busy-state preference bound as useBusyEnter. */
    busyEnter: SnapshotStore<BusyEnterBehavior>
  }
  /** Change the busy-state plain-Enter behavior. */
  setBusyEnter: (behavior: BusyEnterBehavior) => void
}

/** Full Settings-row props. */
export type EnterBehaviorRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<EnterBehaviorRowInjected>

const LABELS: Record<BusyEnterBehavior, ConversationKey> = {
  queue: 'settings.enter.queue',
  steer: 'settings.enter.steer',
}

/**
 * Render the busy-state Enter behavior selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function EnterBehaviorRow({ useBusyEnter, setBusyEnter, t }: EnterBehaviorRowProps) {
  const behavior = useBusyEnter(value => value)

  return (
    <PreferenceSelectRow
      title={t('settings.enter.title')}
      description={t('settings.enter.description')}
      options={[
        { id: 'queue', label: t(LABELS.queue) },
        { id: 'steer', label: t(LABELS.steer) },
      ]}
      selected={behavior}
      selectedLabel={t(LABELS[behavior])}
      onSelect={setBusyEnter}
    />
  )
}

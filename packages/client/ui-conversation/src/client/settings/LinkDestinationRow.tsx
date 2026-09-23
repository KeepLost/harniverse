/** General Settings row choosing which machine opens a link in assistant prose. */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LinkDestination } from '../../conversation-settings.ts'
import type { ConversationKey } from '../locales.ts'
import { PreferenceSelectRow } from './PreferenceSelectRow.tsx'

/** Registration-side preference face. */
export interface LinkDestinationRowInjected {
  hooks: {
    /** Persisted link destination bound as useLinkDestination. */
    linkDestination: SnapshotStore<LinkDestination>
  }
  /** Change which machine opens a link. */
  setLinkDestination: (destination: LinkDestination) => void
}

/** Full Settings-row props. */
export type LinkDestinationRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<LinkDestinationRowInjected>

const LABELS: Record<LinkDestination, ConversationKey> = {
  panel: 'settings.links.panel',
  device: 'settings.links.device',
}

/**
 * Render the link destination selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function LinkDestinationRow({ useLinkDestination, setLinkDestination, t }: LinkDestinationRowProps) {
  const destination = useLinkDestination(value => value)

  return (
    <PreferenceSelectRow
      title={t('settings.links.title')}
      description={t('settings.links.description')}
      options={[
        { id: 'panel', label: t(LABELS.panel) },
        { id: 'device', label: t(LABELS.device) },
      ]}
      selected={destination}
      selectedLabel={t(LABELS[destination])}
      onSelect={setLinkDestination}
    />
  )
}

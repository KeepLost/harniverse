/** The Appearance section: one column rendering feature-owned item contributions. */
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './AppearanceSection.module.css'

/** Full component props: section owner share plus item render share. */
export type AppearanceSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.appearance.item'>

/**
 * Render the Appearance section content column.
 * @param props - composed slot props.
 * @returns the section element tree.
 */
export function AppearanceSection({ renderSlot }: AppearanceSectionComponentProps) {
  return (
    <div className={css.section}>
      {renderSlot('settings.appearance.item', {})}
    </div>
  )
}

/**
 * The terminal section's tab in the workspace workbench: a role="tab" button
 * beside the shipped files/changes/search tabs. The tab self-identifies by
 * its registration id — `current` and `select` are the workbench's owner
 * share — and the workbench's tablist owns arrow-key navigation.
 */
import { IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './TerminalSectionTab.module.css'

/** Full props composed by the workbench section-tab slot. */
export type TerminalSectionTabProps =
  PropsRuntime<'workbench.section.tab'>
  & PropsLocale<typeof NS>

/**
 * Render the terminal section tab.
 * @param props - the workbench's current section, selection verb, and the translator.
 * @returns the section tab button.
 */
export function TerminalSectionTab({ current, select, t }: TerminalSectionTabProps) {
  const active = current === 'terminal'
  return (
    <button
      type="button"
      id="workspace-workbench-section-terminal"
      role="tab"
      className={css.tab}
      data-active={active || undefined}
      aria-controls="workspace-workbench-navigation"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      title={t('view.title')}
      onClick={() => { select('terminal') }}
    >
      <IconCodeOutline16 size={14} />
      <span>{t('view.title')}</span>
    </button>
  )
}

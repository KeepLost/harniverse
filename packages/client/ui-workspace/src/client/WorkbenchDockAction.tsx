/**
 * The workbench opener for sessions whose header chrome is hidden: a fresh
 * blank session hides the session header (clean first run), which also hides
 * the header's workbench button — this input-dock chip keeps the workbench
 * (files, changes, search, and the contributed browser/terminal sections)
 * reachable from the composer until the first turn brings the header back.
 */
import { IconFolderOpen16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceWorkbenchInjected } from './contract/slots.ts'
import css from './WorkbenchDockAction.module.css'

/** Full props composed by the input dock slot. */
export type WorkbenchDockActionProps =
  PropsRuntime<'conversation.input.dock'>
  & InjectFace<WorkspaceWorkbenchInjected>
  & PropsLocale<'workspace'>

/**
 * Render the input-dock workbench chip while the session is still blank.
 * @param props - the session runtime share, the workbench callbacks, and the translator.
 * @returns the dock chip, or nothing once the session header carries the button.
 */
export function WorkbenchDockAction(props: WorkbenchDockActionProps) {
  const blank = props.useSession(state => state.composerPhase === 'blank')
  if (!blank) return null
  return (
    <div className={css.row}>
      <button
        type="button"
        className={css.chip}
        aria-label={props.t('workbench.open')}
        onClick={() => { props.openWorkbench() }}
      >
        <IconFolderOpen16 size={12} />
        <span>{props.t('workbench.label')}</span>
      </button>
    </div>
  )
}

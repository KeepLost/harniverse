import { IconFolderOpen16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceWorkbenchInjected } from './contract/slots.ts'
import css from './WorkspaceWorkbenchButton.module.css'

/** Session-header entry point; opening the workbench itself performs no inspection request. */
export function WorkspaceWorkbenchButton(props: PropsRuntime<'conversation.session.header.utilities'> & InjectFace<WorkspaceWorkbenchInjected> & PropsLocale<'workspace'>) {
  return (
    <button
      type="button"
      className={css.workbenchButton}
      aria-label={props.t('workbench.open')}
      onClick={() => { props.openWorkbench() }}
    >
      <span>{props.t('workbench.label')}</span>
      <IconFolderOpen16 size={12} />
    </button>
  )
}

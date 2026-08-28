import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceWorkbenchInjected } from './contract/slots.ts'

/** Session-header entry point; opening the workbench itself performs no inspection request. */
export function WorkspaceWorkbenchButton(props: PropsRuntime<'conversation.session.header.utilities'> & InjectFace<WorkspaceWorkbenchInjected> & PropsLocale<'workspace'>) {
  return <button type="button" aria-label={props.t('workbench.open')} onClick={() => { props.openWorkbench() }}>{props.t('workbench.label')}</button>
}

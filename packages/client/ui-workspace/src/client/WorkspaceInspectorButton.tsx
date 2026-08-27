import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceInspectorInjected } from './contract/slots.ts'

/** Session-header entry point; opening the panel itself performs no inspection request. */
export function WorkspaceInspectorButton(props: PropsRuntime<'conversation.session.header.utilities'> & InjectFace<WorkspaceInspectorInjected>) {
  return <button type="button" aria-label="打开工作区检查器" onClick={() => { props.openDetails() }}>工作区</button>
}

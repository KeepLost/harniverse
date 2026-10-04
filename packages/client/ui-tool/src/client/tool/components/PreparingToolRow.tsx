/** Tool-owned non-expandable chrome without dispatched argument material. */
import type { ReactNode } from 'react'
import type { ToolRowProps } from './ToolRow.tsx'
import { classifyTool } from '../models/tool-call-model.ts'
import { ToolRow } from './ToolRow.tsx'

/** Inputs contain a tool-owned icon/title and no expandable body. */
export interface PreparingToolRowProps {
  toolName: string
  icon: ReactNode
  title: string
  /** Optional preparation summary (for example streamed-argument progress). */
  summary?: string
  /** Localized `row.preparing` status label from the tool dictionary. */
  preparingLabel: string
  t: ToolRowProps['t']
}

/**
 * Render a non-expandable tool prefix with an optional preparation summary.
 * @param props - tool prefix, preparation summary, and locale.
 * @returns the preparation row.
 */
export function PreparingToolRow({ toolName, icon, title, summary = '', preparingLabel, t }: PreparingToolRowProps) {
  return <ToolRow t={t} variant={classifyTool(toolName)} toolName={toolName}
    icon={icon} title={title} summary={summary} body={null}
    state="preparing" preparingLabel={preparingLabel} />
}

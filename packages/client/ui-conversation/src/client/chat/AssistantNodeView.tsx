import { memo, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ChatNodeViewProps, TurnTailOwnerProps } from '../contract/slots.ts'
import type { AssistantMetaOwnerProps, ChatImagesOwnerProps, ReasoningBodyOwnerProps } from '../contract/slots.ts'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'

/** Streaming, settled, and interrupted Assistant states share one keyed renderer instance. */
export const AssistantNodeView = memo(function AssistantNodeView({
  node, useTurnData, openFile, loadImage, fileMentions, externalLinks, renderImages, renderBody, renderMeta, t,
}: ChatNodeViewProps<'assistant-step'> & {
  /** Seat-bound gallery renderer; supplied by the assistant-step seat bridge. */
  renderImages?: ((owner: ChatImagesOwnerProps) => ReactNode) | undefined
  /** Seat-bound reasoning-body renderer; supplied by the assistant-step seat bridge. */
  renderBody?: ((owner: ReasoningBodyOwnerProps) => ReactNode) | undefined
  /** Seat-bound meta renderer; supplied by the assistant-step seat bridge. */
  renderMeta?: ((owner: AssistantMetaOwnerProps) => ReactNode) | undefined
}) {
  const data = node.data
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  const tail = useTurnData('turn-tail')
  const owner = useMemo<TurnTailOwnerProps | undefined>(() => {
    if (turn?.status !== 'closed' || data.finalNode === undefined) return undefined
    if (tail?.closing?.finalNode.seq !== data.finalNode.seq) return undefined
    return { turn, seq: data.finalNode.seq, openFile }
  }, [data.finalNode, openFile, tail, turn])
  const mentions = useMemo(
    () => owner === undefined ? undefined : fileMentions(owner),
    [fileMentions, owner],
  )
  return (
    <AssistantMarkdown
      blocks={data.blocks}
      streaming={data.status === 'running'}
      interrupted={data.status === 'interrupted'}
      loadImage={loadImage}
      mentions={mentions}
      externalLinks={externalLinks}
      provenance={data.finalNode?.provenance}
      renderImages={renderImages}
      renderBody={renderBody}
      renderMeta={renderMeta}
      t={t}
    />
  )
})

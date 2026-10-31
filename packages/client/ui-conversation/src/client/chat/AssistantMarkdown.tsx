// AssistantMarkdown: renders assistant blocks in order — markdown text body,
// reasoning as the figma Think summary row (expand = indented gray text),
// other-block JSON fallback. Tool-call heads are NOT rendered here: the chat
// view groups them into tool rows through its keyed toolview slot (figma
// step-summary flow). Shared by finalized nodes and the streaming partial;
// the turn-level loading dots live in the chat view's tail, not here.
// Finalized content (text) nodes append IconActions once their turn ends
// (`time` is omitted for mid-turn narration and while the turn still runs);
// their branch action is enabled only when the node is also the completed
// turn's transcript tail. Think / tool-head-only nodes stay chrome-free.

import { Fragment, memo, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { AssistantBlock, AssistantProvenanceView } from '@deepseek-ai/dsh-client-runtime/client'
import { JsonBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownExternalLinks, MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import { ImageGallery, type ImageLoader } from '@deepseek-ai/dsh-client-ui-attachment'
import type {
  AssistantMetaOwnerProps, ChatImagesOwnerProps, ChatViewSlotProps, ReasoningBodyOwnerProps,
} from '../contract/slots.ts'
import { messageImageLabels } from '../image-labels.ts'
import { ReasoningRow } from './ReasoningRow.tsx'
import css from './AssistantMarkdown.module.css'

export interface AssistantMarkdownProps {
  blocks: readonly AssistantBlock[]
  streaming: boolean
  /** Frozen partial of an aborted turn: rendered with a stopped marker. */
  interrupted?: boolean | undefined
  /** Session-authorized durable image loader. */
  loadImage?: ImageLoader
  /** Resolved prose file mentions for this Assistant's closing turn. */
  mentions?: MarkdownFileMentions | undefined
  /** Where a link in this prose opens (the host browser panel, or a new tab). */
  externalLinks?: MarkdownExternalLinks | undefined
  /** Provider/model identity of the finalized message; omitted while unknown (streaming). */
  provenance?: AssistantProvenanceView | undefined
  /** Seat-bound gallery renderer for the assistant image position; omitted renders the shared gallery directly. */
  renderImages?: ((owner: ChatImagesOwnerProps) => ReactNode) | undefined
  /** Seat-bound body renderer for reasoning disclosures; omitted renders the plain Think body. */
  renderBody?: ((owner: ReasoningBodyOwnerProps) => ReactNode) | undefined
  /** Seat-bound meta renderer for the provenance line; omitted renders the plain ids. */
  renderMeta?: ((owner: AssistantMetaOwnerProps) => ReactNode) | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/** Reasoning block as the Think variant summary row (figma 39:28304). */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  blocks, streaming, interrupted, loadImage, mentions, externalLinks, provenance, renderImages, renderBody,
  renderMeta, t,
}: AssistantMarkdownProps) {
  const imageLoader = loadImage ?? (() => Promise.reject(new Error(t('image.serviceUnavailable'))))
  // Stable per locale revision (t identity changes on switch): a fresh object
  // per render would rebuild MarkdownText's component table every chunk.
  const codeLabels = useMemo(() => ({ copyLabel: t('copy'), copiedLabel: t('copied') }), [t])
  const last = blocks.length - 1
  // Tool-call heads render as tool rows in the chat view's grouping pass, so
  // a node that is only those heads (or empty) would paint an empty root
  // between tool groups — skip the shell unless something visible remains.
  const hasVisible = streaming
    || interrupted === true
    || blocks.some(block => block.kind !== 'tool-call')
  if (!hasVisible) return null
  const rendered: ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block === undefined) continue
    switch (block.kind) {
      case 'text':
        rendered.push(
          <MarkdownText
            key={i}
            text={block.text}
            streaming={streaming}
            codeLabels={codeLabels}
            fileMentions={mentions}
            externalLinks={externalLinks}
          />,
        )
        break
      case 'reasoning':
        rendered.push(<ReasoningRow key={i} text={block.text} running={streaming && i === last} renderBody={renderBody} t={t} />)
        break
      case 'image': {
        // Consecutive image blocks share one gallery so several images tile
        // into rows instead of each opening a one-image group of its own.
        // Keyed by the group's FIRST block index: a streaming append that
        // extends the group then only grows `images` instead of remounting
        // the gallery under a shifted key.
        const start = i
        const group = [block]
        while (i + 1 < blocks.length) {
          const next = blocks[i + 1]
          if (next === undefined || next.kind !== 'image') break
          group.push(next)
          i += 1
        }
        rendered.push(renderImages !== undefined
          ? <Fragment key={start}>{renderImages({ images: group.map(block => block.attachment), load: imageLoader, align: 'start' })}</Fragment>
          : <ImageGallery key={start} images={group} load={imageLoader} align="start" labels={messageImageLabels(t)} />)
        break
      }
      // Grouped into tool rows by ChatView; hasVisible above skips an empty shell.
      case 'tool-call':
        break
      default:
        rendered.push(
          <JsonBlock
            key={i}
            label={t('message.unknownBlock')}
            payload={block.block}
            truncatedLabel={total => t('json.truncated', { total })}
          />,
        )
    }
  }
  return (
    <div className={css.root} data-streaming={streaming || undefined}>
      <div className={css.body}>
        {rendered}
        {interrupted && <span className={css.stopped}>{t('message.stopped')}</span>}
      </div>
      {provenance !== undefined && (
        <div className={css.meta}>
          {renderMeta !== undefined
            ? renderMeta({ provenance })
            : `${provenance.provider} · ${provenance.model}`}
        </div>
      )}
    </div>
  )
})

/** Shipped occupants of the chat presentation seats and the user-seat bridge. */
import { memo, useMemo, useCallback } from 'react'
import { ImageGallery } from '@deepseek-ai/dsh-client-ui-attachment'
import type {
  AssistantMetaOwnerProps, AssistantSeatViewProps, ChatImagesOwnerProps, ChatUserSeatViewProps,
  ReasoningBodyOwnerProps,
} from '../contract/slots.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { messageImageLabels } from '../image-labels.ts'
import { AssistantNodeView } from './AssistantNodeView.tsx'
import { UserMessageNodeView } from './MessageItem.tsx'
import css from './ReasoningRow.module.css'
import type { FileActions } from '@deepseek-ai/dsh-client-ui-file-actions/client'
import type { ImageActionsFor, ImageLightboxActionLabels } from '@deepseek-ai/dsh-client-ui-attachment'

/** The file-actions inject face this seat's registration declares; members stay optional for standalone renders. */
export interface ChatImagesFileActionsFace {
  /** Framework-bound seat over the bridge store; undefined when the seat registered without it. */
  useFileActions?: (select: (service: FileActions | undefined) => FileActions | undefined) => FileActions | undefined
  /** Original-file command labels resolved by the owning plugin. */
  actionLabels?: () => ImageLightboxActionLabels
}

/** Shipped gallery of one chat image seat: the shared `ui-attachment` atoms over the owner share. */
export function ChatImagesDefault(
  { images, load, align, t, useFileActions, actionLabels }: ChatImagesOwnerProps & Pick<ChatViewSlotProps, 't'> & ChatImagesFileActionsFace,
) {
  const service = useFileActions?.(current => current)
  const actionsFor = useMemo<ImageActionsFor | undefined>(() => {
    if (service === undefined || actionLabels === undefined) return undefined
    const labels = actionLabels()
    return resolved => ({
      labels,
      // Completion feedback rides the file-actions menu batch's notify surface;
      // until then a failed gesture is swallowed here after its rejection settles.
      copy: () => { void service.copyImage({ url: resolved.url, name: resolved.name }).catch(() => {}) },
      download: () => { void service.save({ url: resolved.url, name: resolved.name }, 'download').catch(() => {}) },
      ...service.canSaveAs ? {
        saveAs: () => { void service.save({ url: resolved.url, name: resolved.name }, 'saveAs').catch(() => {}) },
      } : {},
    })
  }, [service, actionLabels])
  return (
    <ImageGallery
      images={images.map(attachment => ({ attachment }))}
      load={load}
      align={align}
      labels={messageImageLabels(t)}
      {...actionsFor === undefined ? {} : { actionsFor }}
    />
  )
}

/** Shipped reasoning body: the plain pre-wrap Think text. */
export function ReasoningBodyDefault({ text }: ReasoningBodyOwnerProps) {
  return <div className={css.thinkBody}>{text}</div>
}

/** Shipped assistant meta line: the provider and model ids of one finalized message. */
export function AssistantMetaDefault({ provenance }: AssistantMetaOwnerProps) {
  return <span>{`${provenance.provider} · ${provenance.model}`}</span>
}

/**
 * User-key chat renderer bridging the user-images seat into the bubble: the
 * seat is declared here so it lives exactly while user messages render
 * through this key, and the bound render survives the inner memo.
 */
export const UserMessageSeatView = memo(function UserMessageSeatView(
  { renderSlot, ...rest }: ChatUserSeatViewProps,
) {
  const renderImages = useCallback(
    (owner: ChatImagesOwnerProps) => renderSlot('conversation.chat.user.images', owner),
    [renderSlot],
  )
  return <UserMessageNodeView {...rest} renderImages={renderImages} />
})

/**
 * Assistant-step chat renderer bridging the assistant-images,
 * reasoning-body, and assistant-meta seats into the shared markdown
 * renderer: the seats live exactly while assistant output renders through
 * this key, and the bound renders survive the inner memo.
 */
export const AssistantSeatView = memo(function AssistantSeatView(
  { renderSlot, ...rest }: AssistantSeatViewProps,
) {
  const renderImages = useCallback(
    (owner: ChatImagesOwnerProps) => renderSlot('conversation.chat.assistant.images', owner),
    [renderSlot],
  )
  const renderBody = useCallback(
    (owner: ReasoningBodyOwnerProps) => renderSlot('conversation.chat.reasoning.body', owner),
    [renderSlot],
  )
  const renderMeta = useCallback(
    (owner: AssistantMetaOwnerProps) => renderSlot('conversation.chat.assistant.meta', owner),
    [renderSlot],
  )
  return (
    <AssistantNodeView {...rest} renderImages={renderImages} renderBody={renderBody} renderMeta={renderMeta} />
  )
})

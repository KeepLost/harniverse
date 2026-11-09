import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { FileActions } from '@deepseek-ai/dsh-client-ui-file-actions/client'
import type { ImageLightboxActionLabels } from '@deepseek-ai/dsh-client-ui-attachment'
import { NS } from '../locales.ts'
import { CommandNodeView, ManualCompactionNodeView } from './CommandNodeView.tsx'
import {
  CompactionNodeView, ContextMessageNodeView, RetryNodeView, TurnErrorNodeView,
  TurnMaxTokensNodeView, UnknownNodeView, UserMessageNodeView,
} from './MessageItem.tsx'
import { TurnTailNodeView } from './TurnTailNodeView.tsx'
import { AssistantSeatView, AssistantMetaDefault, ChatImagesDefault, ReasoningBodyDefault, UserMessageSeatView } from './seat-occupants.tsx'

/**
 * Register this package's business renderers behind the keyed Chat Node seat.
 * @param ctx - owning UI Conversation context.
 */
export function registerChatNodeRenderers(ctx: Context): void {
  // The file-actions capability is an optional sibling: track it through the
  // service lifecycle so the image seats offer original-file commands exactly
  // while a provider is live, without depending on its activation order.
  const fileActions = createSnapshotStore<FileActions | undefined>(undefined)
  ctx.effect(() => {
    const read = (): FileActions | undefined => {
      // An undeclared optional service read throws while absent; that is the
      // off state this bridge publishes.
      try {
        return (ctx as unknown as { get(name: string): unknown }).get('fileActions') as FileActions | undefined ?? undefined
      } catch {
        return undefined
      }
    }
    const refresh = (name?: string, value?: unknown): void => {
      if (name !== undefined && name !== 'fileActions') return
      fileActions.set(value === undefined ? read() : value as FileActions | undefined)
    }
    const off = ctx.on('internal/service', refresh)
    refresh()
    return off
  }, 'chat image file-actions bridge')
  const actionLabels = (): ImageLightboxActionLabels => {
    const t = ctx.locale.bind('fileActions')
    return { copy: t('menu.copyImage'), download: t('menu.download'), saveAs: t('menu.saveAs') }
  }
  const imageInject = () => ({ hooks: { fileActions }, actionLabels })
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'user',
    locale: NS,
    children: { 'conversation.chat.user.images': { kind: 'single', scope: 'session' } },
  }, UserMessageSeatView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'steering', locale: NS }, UserMessageNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'context', locale: NS }, ContextMessageNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'assistant-step',
    locale: NS,
    children: {
      'conversation.chat.assistant.images': { kind: 'single', scope: 'session' },
      'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
      'conversation.chat.assistant.meta': { kind: 'single', scope: 'session' },
    },
  }, AssistantSeatView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'command',
    locale: NS,
    children: { 'conversation.chat.commandview': { kind: 'keyed', scope: 'session' } },
  }, CommandNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'manual-compaction', locale: NS }, ManualCompactionNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'compaction', locale: NS }, CompactionNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'model-retry', locale: NS }, RetryNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-error', locale: NS }, TurnErrorNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-max-tokens', locale: NS }, TurnMaxTokensNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'turn-tail',
    locale: NS,
    children: {
      'conversation.chat.turnTail': { kind: 'chain', scope: 'session' },
      'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
    },
  }, TurnTailNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'unknown', locale: NS }, UnknownNodeView))

  // Shipped occupants of the presentation seats those entries declare:
  // priority 100 leaves room below for a third-party replacement per domain,
  // and disposal restores the shipped presentation.
  ctx.slots.inject('conversation.chat.user.images', () => ctx.slots.register(
    { name: 'conversation.chat.user.images', priority: 100, locale: NS, inject: imageInject }, ChatImagesDefault))
  ctx.slots.inject('conversation.chat.assistant.images', () => ctx.slots.register(
    { name: 'conversation.chat.assistant.images', priority: 100, locale: NS, inject: imageInject }, ChatImagesDefault))
  ctx.slots.inject('conversation.chat.reasoning.body', () => ctx.slots.register(
    { name: 'conversation.chat.reasoning.body', priority: 100, locale: NS }, ReasoningBodyDefault))
  ctx.slots.inject('conversation.chat.assistant.meta', () => ctx.slots.register(
    { name: 'conversation.chat.assistant.meta', priority: 100, locale: NS }, AssistantMetaDefault))
}

import type { Context } from '@deepseek-ai/cordis'
import { NS } from '../locales.ts'
import { CommandNodeView, ManualCompactionNodeView } from './CommandNodeView.tsx'
import {
  CompactionNodeView, ContextMessageNodeView, RetryNodeView, TurnErrorNodeView,
  TurnMaxTokensNodeView, UnknownNodeView, UserMessageNodeView,
} from './MessageItem.tsx'
import { TurnTailNodeView } from './TurnTailNodeView.tsx'
import { AssistantSeatView, ChatImagesDefault, ReasoningBodyDefault, UserMessageSeatView } from './seat-occupants.tsx'

/**
 * Register this package's business renderers behind the keyed Chat Node seat.
 * @param ctx - owning UI Conversation context.
 */
export function registerChatNodeRenderers(ctx: Context): void {
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
    { name: 'conversation.chat.user.images', priority: 100, locale: NS }, ChatImagesDefault))
  ctx.slots.inject('conversation.chat.assistant.images', () => ctx.slots.register(
    { name: 'conversation.chat.assistant.images', priority: 100, locale: NS }, ChatImagesDefault))
  ctx.slots.inject('conversation.chat.reasoning.body', () => ctx.slots.register(
    { name: 'conversation.chat.reasoning.body', priority: 100, locale: NS }, ReasoningBodyDefault))
}

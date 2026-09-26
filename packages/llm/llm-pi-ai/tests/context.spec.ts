import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CallId, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { toPiContext } from '../src/context.ts'
import { toPiAssistant } from '../src/replay.ts'

const ref: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
}

const attachments = {
  readImage: vi.fn(() => Promise.resolve({ ref, data: Uint8Array.of(1) })),
} as unknown as AttachmentStore

function request(messages: GenerateOptions['messages']): GenerateOptions {
  return {
    provider: 'openai',
    model: 'gpt-4.1',
    system: 'system prompt',
    tools: [{ name: 'lookup', description: 'look up', parameters: { type: 'object' } }],
    messages,
  }
}

function user(content: ContentBlock[]): Message {
  return createUserMessage({ content, source: { kind: 'plugin', plugin: 'test' } })
}

function history(role: 'system' | 'assistant', content: ContentBlock[]): Message {
  return createMessage({ role, content, source: { kind: 'plugin', plugin: 'test' } })
}

describe('reasoning degrade notices', () => {
  it('appends one notice when a reasoning assistant message has no replay metadata', () => {
    const context = toPiContext(request([
      user([{ type: 'text', text: 'hello' }]),
      history('assistant', [{ type: 'reasoning', text: 'mull' }, { type: 'text', text: 'answer' }]),
      user([{ type: 'text', text: 'continue' }]),
    ]))
    const last = context.messages.at(-1)
    expect(last?.role).toBe('user')
    expect(typeof last?.content === 'string' ? last?.content : '').toContain('<system-reminder>')
    expect(typeof last?.content === 'string' ? last?.content : '')
      .toContain('reasoning chain cannot be replayed')
    // Exactly one notice, not one per degraded message.
    expect(context.messages.filter(message =>
      typeof message.content === 'string' && message.content.includes('<system-reminder>'))).toHaveLength(1)
  })

  it('appends no notice for reasoning-free history or usable replay state', () => {
    const textOnly = toPiContext(request([
      history('assistant', [{ type: 'text', text: 'answer' }]),
    ]))
    expect(textOnly.messages.at(-1)?.role).toBe('assistant')

    const modelMessage = createMessage({
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'mull', encrypted: 'cipher' }],
      source: {
        kind: 'model',
        provider: 'openai',
        model: 'gpt-4.1',
        stopReason: { kind: 'stop' },
        usage: { inputTokens: 1, outputTokens: 1 },
        replayState: {
          response: {
            kind: 'pi-ai',
            version: 2,
            api: 'openai-responses',
            provider: 'openai',
            model: 'gpt-4.1',
            stopReason: 'stop',
          },
          blocks: [{ type: 'reasoning' }],
        },
      },
    })
    const replayed = toPiContext(request([modelMessage]))
    expect(replayed.messages.at(-1)?.role).toBe('assistant')
  })

  it('appends a notice when the stored route no longer matches this request', () => {
    const staleRoute = createMessage({
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'mull' }],
      source: {
        kind: 'model',
        provider: 'anthropic',
        model: 'claude-x',
        stopReason: { kind: 'stop' },
        usage: { inputTokens: 1, outputTokens: 1 },
        replayState: {
          response: {
            kind: 'pi-ai',
            version: 2,
            api: 'anthropic-messages',
            provider: 'anthropic',
            model: 'claude-x',
            stopReason: 'stop',
          },
          blocks: [{ type: 'reasoning' }],
        },
      },
    })
    const context = toPiContext(request([staleRoute]))
    expect(context.messages.some(message =>
      typeof message.content === 'string' && message.content.includes('<system-reminder>'))).toBe(true)
  })
})

describe('pi-ai request context conversion', () => {
  it('omits absent and empty request-level optional fields', () => {
    const base = { provider: 'openai', model: 'gpt-4.1', messages: [] }
    expect(toPiContext(base)).toEqual({ messages: [] })
    expect(toPiContext({ ...base, tools: [] })).toEqual({ messages: [] })
  })

  it('converts complete text-only history and rejects nested images without storage', () => {
    const callId = CallId('call-1')
    expect(toPiContext(request([
      history('system', [{ type: 'text', text: 'history system' }]),
      history('assistant', [{ type: 'tool-call', id: callId, name: 'lookup', arguments: '{}' }]),
      user([
        { type: 'text', text: 'after tool' },
        {
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: '' }],
        },
      ]),
    ]))).toMatchObject({
      systemPrompt: 'system prompt',
      tools: [{ name: 'lookup' }],
      messages: [
        { role: 'user', content: 'history system' },
        { role: 'assistant' },
        // The result directly answers the assistant's call; the user's own
        // text follows it. A user message first would make pi-ai answer the
        // call with a synthetic "No result provided" before the real one.
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'lookup',
          content: [{ type: 'text', text: '(no output)' }],
          isError: false,
        },
        { role: 'user', content: 'after tool' },
      ],
    })

    expect(() => toPiContext(request([user([{
      type: 'tool-result',
      toolCallId: callId,
      content: [{ type: 'image', attachment: ref }],
    }])]))).toThrow(/durable attachment service/)
  })

  it('resolves user and tool-result images while preserving explicit fallbacks', async () => {
    const callId = CallId('missing-call')
    const knownCallId = CallId('known-call')
    const context = await toPiContext(request([
      user([{ type: 'text', text: '' }]),
      history('assistant', [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: knownCallId, name: 'lookup', arguments: '{}' },
      ]),
      user([
        { type: 'image', attachment: ref },
        { type: 'text', text: 'caption' },
        { type: 'reasoning', text: 'ignored' },
      ]),
      user([{
        type: 'tool-result',
        toolCallId: knownCallId,
        content: [{ type: 'text', text: '' }],
      }]),
      user([{
        type: 'tool-result',
        toolCallId: callId,
        isError: true,
        content: [
          { type: 'tool-result', toolCallId: callId, content: [] },
          { type: 'image', attachment: ref },
        ],
      }]),
    ]), attachments)

    expect(context.messages).toEqual([
      { role: 'user', content: '', timestamp: 0 },
      expect.objectContaining({ role: 'assistant' }),
      {
        role: 'user',
        content: [
          { type: 'image', data: 'AQ==', mimeType: 'image/png' },
          { type: 'text', text: 'caption' },
        ],
        timestamp: 0,
      },
      {
        role: 'toolResult',
        toolCallId: 'known-call',
        toolName: 'lookup',
        content: [{ type: 'text', text: '(no output)' }],
        isError: false,
        timestamp: 0,
      },
      {
        role: 'toolResult',
        toolCallId: 'missing-call',
        toolName: 'unknown',
        content: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
        isError: true,
        timestamp: 0,
      },
    ])
  })

  it('keeps every tool result adjacent to its call on the image path too', async () => {
    const callId = CallId('call-adjacent')
    const context = await toPiContext(request([
      history('assistant', [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: callId, name: 'lookup', arguments: '{}' },
      ]),
      user([
        { type: 'text', text: 'meanwhile' },
        { type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'payload' }] },
      ]),
    ]), attachments)

    expect(context.messages).toEqual([
      expect.objectContaining({ role: 'assistant' }),
      {
        role: 'toolResult',
        toolCallId: 'call-adjacent',
        toolName: 'lookup',
        content: [{ type: 'text', text: 'payload' }],
        isError: false,
        timestamp: 0,
      },
      { role: 'user', content: 'meanwhile', timestamp: 0 },
    ])
  })

  it('keeps empty text-only users while separating result-only messages', () => {
    const callId = CallId('unknown-call')
    expect(toPiContext(request([
      user([]),
      history('assistant', [
        { type: 'text', text: 'answer' },
        { type: 'tool-call', id: CallId('other-call'), name: 'lookup', arguments: '{}' },
      ]),
      user([{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: 'result' }],
      }]),
    ]))).toMatchObject({
      messages: [
        { role: 'user', content: '' },
        { role: 'assistant' },
        { role: 'toolResult', toolName: 'unknown' },
      ],
    })
  })

  it('handles in-history system and assistant messages explicitly on the image path', async () => {
    await expect(toPiContext(request([
      history('system', [{ type: 'image', attachment: ref }]),
    ]), attachments)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })

    await expect(toPiContext(request([
      history('system', [{ type: 'text', text: 'history system' }]),
      history('assistant', [{ type: 'text', text: 'answer' }]),
      user([{ type: 'text', text: 'plain' }]),
    ]), attachments)).resolves.toMatchObject({
      messages: [
        { role: 'user', content: 'history system' },
        { role: 'assistant' },
        { role: 'user', content: 'plain' },
      ],
    })

    expect(() => toPiAssistant(
      history('assistant', [{ type: 'image', attachment: ref }]),
    )).toThrow(/assistant image output/)
  })
})

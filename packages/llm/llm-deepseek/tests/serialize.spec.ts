import { describe, expect, it } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, CallId, ReasoningEffortId, createMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { serializeMessages, serializeMessagesWithImages, serializeRequest } from '../src/serialize.ts'

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [], ...overrides }
}

function requestImage(overrides: Partial<RequestImageAttachment> = {}): RequestImageAttachment {
  const attachment = {
    attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
    mediaType: 'image/png' as const,
    bytes: 2,
    width: 2,
    height: 1,
  }
  return {
    variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
    attachment,
    data: new Uint8Array([1, 2]),
    mediaType: 'image/png',
    bytes: 2,
    width: 2,
    height: 1,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
    ...overrides,
  }
}

describe('serializeMessages', () => {
  it('maps user text to string content', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'user', content: 'hello world' }])
  })

  it('maps system-role messages in history', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'system', content: [{ type: 'text', text: 'be brief' }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'system', content: 'be brief' }])
  })

  it('passes reasoning_content back on tool-call-free turns', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking…' },
          { type: 'text', text: 'answer' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'assistant', content: 'answer', reasoning_content: 'thinking…' }])
  })

  it('passes reasoning_content back on tool-call turns (official passback rule)', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'I should check the weather.' },
          { type: 'tool-call', id: CallId('call-1'), name: 'get_weather', arguments: '{"city":"Paris"}' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{
      role: 'assistant',
      // "" (not null) on tool-call turns — mirrors the official samples'
      // verbatim message replay; some gateways reject null.
      content: '',
      reasoning_content: 'I should check the weather.',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
    }])
  })

  it('serializes parallel tool calls in order', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [
          { type: 'tool-call', id: CallId('a'), name: 'one', arguments: '{}' },
          { type: 'tool-call', id: CallId('b'), name: 'two', arguments: '{}' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    const assistant = wire[0] as { tool_calls: { id: string }[] }
    expect(assistant.tool_calls.map(call => call.id)).toEqual(['a', 'b'])
  })

  it('turns tool results into role:tool messages', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          content: [{ type: 'text', text: 'Sunny 22C' }],
        }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'tool', tool_call_id: 'call-1', content: 'Sunny 22C' }])
  })

  it('sends a sentinel for empty tool-result content', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{ type: 'tool-result', toolCallId: CallId('call-1'), content: [] }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'tool', tool_call_id: 'call-1', content: '(no output)' }])
  })

  it('splits mixed user text + tool results into separate wire messages', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [
          { type: 'text', text: 'context note' },
          { type: 'tool-result', toolCallId: CallId('call-1'), content: [{ type: 'text', text: 'ok' }] },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([
      { role: 'user', content: 'context note' },
      { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
    ])
  })

  it('skips plugin-added block types (merge-extensible ContentBlockMap)', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [
          { type: 'chart', data: 'x' } as unknown as ContentBlock,
          { type: 'text', text: 'see chart' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'user', content: 'see chart' }])
  })

  it('rejects image blocks instead of silently flattening them away', () => {
    expect(() => serializeMessages([createUserMessage({
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
          mediaType: 'image/png', bytes: 68, width: 1, height: 1,
        },
      }],
      source: { kind: 'plugin', plugin: 'test' },
    })])).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
  })

  it('serializes inline image parts with a stable attachment handle', async () => {
    const image = requestImage()
    const wire = await serializeMessagesWithImages([
      createUserMessage({
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', attachment: image.attachment },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ], {
      representation: { kind: 'base64' },
      requestImages: new Map([[image.attachment.attachmentId, image]]),
    })
    expect(wire).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'text', text: '\n[image sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2x1]' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQI=' } },
      ],
    }])
  })

  it('resolves file parts with their message and image locations', async () => {
    const image = requestImage()
    const locations: { message: number; image: number }[] = []
    const wire = await serializeMessagesWithImages([
      createUserMessage({
        content: [{ type: 'image', attachment: image.attachment }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ], {
      representation: {
        kind: 'file',
        resolveFileId: async (_version, location) => {
          locations.push(location)
          return 'file-1'
        },
      },
      requestImages: new Map([[image.attachment.attachmentId, image]]),
    })
    expect(locations).toEqual([{ message: 1, image: 1 }])
    expect(wire[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '[image sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2x1]' },
        { type: 'file', file_id: 'file-1' },
      ],
    })
  })

  it('keeps tool text in the tool message and projects tool images into a later user message', async () => {
    const image = requestImage()
    const wire = await serializeMessagesWithImages([
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          content: [
            { type: 'text', text: 'tool saw an image' },
            { type: 'image', attachment: image.attachment },
          ],
        }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ], {
      representation: { kind: 'base64' },
      requestImages: new Map([[image.attachment.attachmentId, image]]),
    })
    expect(wire).toEqual([
      { role: 'tool', tool_call_id: 'call-1', content: 'tool saw an image\n[image sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2x1]' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Attached image(s) from tool result:' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AQI=' } },
        ],
      },
    ])
  })

  it('renders omitted images as explicit text without reading a request image', async () => {
    const image = requestImage()
    const wire = await serializeMessagesWithImages([
      createUserMessage({
        content: [{ type: 'image', attachment: image.attachment }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ], {
      representation: { kind: 'base64' },
      requestImages: new Map(),
      omittedImages: new Set([image.attachment.attachmentId]),
    })
    expect(wire).toEqual([{
      role: 'user',
      content: `[image omitted: ${image.attachment.attachmentId}]`,
    }])
  })

  it('rejects image content in system and assistant history roles', async () => {
    const image = requestImage()
    for (const role of ['system', 'assistant'] as const) {
      await expect(serializeMessagesWithImages([createMessage({
        role,
        content: [{ type: 'image', attachment: image.attachment }],
        source: { kind: 'plugin', plugin: 'test' },
      })], {
        representation: { kind: 'base64' },
        requestImages: new Map([[image.attachment.attachmentId, image]]),
      })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    }
  })

  it('refuses an image the request never prepared', async () => {
    const image = requestImage()

    // Neither prepared nor deliberately omitted: the request is incoherent.
    await expect(serializeMessagesWithImages([
      createUserMessage({
        content: [{ type: 'image', attachment: image.attachment }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ], {
      representation: { kind: 'base64' },
      requestImages: new Map(),
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('carries tool-result images into a following user message', async () => {
    const image = requestImage()
    const wire = await serializeMessagesWithImages([
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          content: [
            { type: 'text', text: 'rendered' },
            { type: 'image', attachment: image.attachment },
          ],
        }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ], {
      representation: { kind: 'base64' },
      requestImages: new Map([[image.attachment.attachmentId, image]]),
    })

    // The tool turn keeps only its text; images follow as user content the
    // provider accepts.
    expect(wire).toMatchObject([
      { role: 'tool', tool_call_id: 'call-1' },
      { role: 'user', content: [{ type: 'text' }, { type: 'image_url' }] },
    ])
    const toolMessage = wire[0] as { content: string }
    expect(toolMessage.content).toContain('rendered')
  })

  it('reports no output for a tool result that produced none', async () => {
    const wire = await serializeMessagesWithImages([
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-2'),
          // An empty text block contributes nothing at all.
          content: [{ type: 'text', text: '' }],
        }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ], { representation: { kind: 'base64' }, requestImages: new Map() })

    expect(wire).toEqual([{ role: 'tool', tool_call_id: 'call-2', content: '(no output)' }])
  })

  it('flushes pending tool images before a following system or assistant turn', async () => {
    const image = requestImage()
    const wire = await serializeMessagesWithImages([
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-3'),
          content: [{ type: 'image', attachment: image.attachment }],
        }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
      createMessage({ role: 'system', content: [{ type: 'text', text: 'after' }], source: { kind: 'plugin', plugin: 'test' } }),
    ], {
      representation: { kind: 'base64' },
      requestImages: new Map([[image.attachment.attachmentId, image]]),
    })

    expect(wire.map(entry => entry.role)).toEqual(['tool', 'user', 'system'])
  })

  it('flattens a tool result nested inside another tool result', async () => {
    const image = requestImage()
    const wire = await serializeMessagesWithImages([
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('outer'),
          content: [
            { type: 'text', text: 'outer text' },
            {
              type: 'tool-result',
              toolCallId: CallId('inner'),
              content: [
                { type: 'text', text: 'inner text' },
                { type: 'image', attachment: image.attachment },
              ],
            },
          ],
        }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ], {
      representation: { kind: 'base64' },
      requestImages: new Map([[image.attachment.attachmentId, image]]),
    })

    // The nested result contributes its own text and image to the outer one.
    const toolMessage = wire[0] as { role: string; content: string }
    expect(toolMessage.role).toBe('tool')
    expect(toolMessage.content).toContain('outer text')
    expect(toolMessage.content).toContain('inner text')
    expect(wire[1]).toMatchObject({ role: 'user', content: [{ type: 'text' }, { type: 'image_url' }] })
  })

  it('serializes an assistant turn alongside prepared images', async () => {
    const image = requestImage()
    const wire = await serializeMessagesWithImages([
      createUserMessage({
        content: [{ type: 'image', attachment: image.attachment }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
      createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'described' }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ], {
      representation: { kind: 'base64' },
      requestImages: new Map([[image.attachment.attachmentId, image]]),
    })

    expect(wire.map(entry => entry.role)).toEqual(['user', 'assistant'])
    expect(wire[1]).toMatchObject({ role: 'assistant', content: 'described' })
  })

  it('skips content kinds the provider wire has no place for', async () => {
    const wire = await serializeMessagesWithImages([
      createUserMessage({
        content: [
          { type: 'text', text: 'kept' },
          // A reasoning block belongs to assistant history, not user content.
          { type: 'reasoning', text: 'private' } as ContentBlock,
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ], { representation: { kind: 'base64' }, requestImages: new Map() })

    expect(wire).toEqual([{ role: 'user', content: 'kept' }])
  })

  it('emits an empty user message rather than dropping block-less messages', () => {
    const wire = serializeMessages([createUserMessage({
      content: [],
      source: { kind: 'plugin', plugin: 'test' },
    })])
    expect(wire).toEqual([{ role: 'user', content: '' }])
  })
})

describe('serializeRequest', () => {
  const history: Message[] = [createUserMessage({
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'plugin', plugin: 'test' },
  })]

  it('always streams with usage and maps the basics', () => {
    const wire = serializeRequest(request({ messages: history }))
    expect(wire).toEqual({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it('prepends the system prompt', () => {
    const wire = serializeRequest(request({ messages: history, system: 'be helpful' }))
    expect(wire.messages[0]).toEqual({ role: 'system', content: 'be helpful' })
    expect(wire.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('maps sampling params and stop sequences', () => {
    const wire = serializeRequest(request({ messages: history, temperature: 0.2, maxTokens: 100, stop: ['END'] }))
    expect(wire.temperature).toBe(0.2)
    expect(wire.max_tokens).toBe(100)
    expect(wire.stop).toEqual(['END'])
  })

  it('maps tools to the wire function shape', () => {
    const wire = serializeRequest(request({
      messages: history,
      tools: [
        { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } },
        { name: 'b', description: 'B', parameters: { type: 'object', properties: { x: { type: 'string' } } } },
      ],
    }))
    expect(wire.tools).toEqual([
      { type: 'function', function: { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'b', description: 'B', parameters: { type: 'object', properties: { x: { type: 'string' } } } } },
    ])
  })

  it('omits an empty tools array', () => {
    const wire = serializeRequest(request({ messages: history, tools: [] }))
    expect(wire.tools).toBeUndefined()
  })

  it('maps adapter-default thinking and the request reasoning effort', () => {
    const wire = serializeRequest(
      request({ messages: history, reasoningEffort: ReasoningEffortId('max') }),
      { thinking: 'enabled', reasoningEffort: 'high' },
    )
    expect(wire.thinking).toEqual({ type: 'enabled' })
    expect(wire.reasoning_effort).toBe('max')
  })

  it('maps off to disabled thinking without a wire reasoning effort', () => {
    const wire = serializeRequest(
      request({ messages: history, reasoningEffort: ReasoningEffortId('off') }),
      { thinking: 'enabled', reasoningEffort: 'max' },
    )
    expect(wire.thinking).toEqual({ type: 'disabled' })
    expect(wire.reasoning_effort).toBeUndefined()
  })

  it('re-enables thinking when max overrides an off default', () => {
    const wire = serializeRequest(
      request({ messages: history, reasoningEffort: ReasoningEffortId('max') }),
      { reasoningEffort: 'off' },
    )
    expect(wire.thinking).toEqual({ type: 'enabled' })
    expect(wire.reasoning_effort).toBe('max')
  })

  it('places the system prompt ahead of image-bearing history', async () => {
    const image = requestImage()
    const wire = await serializeRequest(
      request({
        system: 'be careful',
        messages: [createUserMessage({
          content: [{ type: 'image', attachment: image.attachment }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      }),
      {},
      {
        representation: { kind: 'base64' },
        requestImages: new Map([[image.attachment.attachmentId, image]]),
      },
    )

    expect(wire.messages[0]).toEqual({ role: 'system', content: 'be careful' })
    expect(wire.messages[1]).toMatchObject({ role: 'user' })
  })

  it('omits a system turn from an image request that has none', async () => {
    const image = requestImage()
    const wire = await serializeRequest(
      request({
        messages: [createUserMessage({
          content: [{ type: 'image', attachment: image.attachment }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      }),
      {},
      {
        representation: { kind: 'base64' },
        requestImages: new Map([[image.attachment.attachmentId, image]]),
      },
    )

    expect(wire.messages.map(entry => entry.role)).toEqual(['user'])
  })

  it('rejects enabling thinking when the deployment is locked to disabled', () => {
    expect(() => serializeRequest(
      request({ messages: history, reasoningEffort: ReasoningEffortId('high') }),
      { thinking: 'disabled' },
    )).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
  })

  it('disables thinking for session-title requests without changing adapter defaults', () => {
    const wire = serializeRequest(
      request({
        messages: history,
        purpose: 'session-title',
        reasoningEffort: ReasoningEffortId('max'),
      }),
      { thinking: 'enabled', reasoningEffort: 'max' },
    )
    expect(wire.thinking).toEqual({ type: 'disabled' })
    expect(wire.reasoning_effort).toBeUndefined()
  })

  it('omits thinking fields when unset (provider default applies)', () => {
    const wire = serializeRequest(request({ messages: history }))
    expect(wire.thinking).toBeUndefined()
    expect(wire.reasoning_effort).toBeUndefined()
  })

  it('preserves an explicit enabled default without inventing a wire effort', () => {
    const wire = serializeRequest(request({ messages: history }), { thinking: 'enabled' })
    expect(wire.thinking).toEqual({ type: 'enabled' })
    expect(wire.reasoning_effort).toBeUndefined()
  })

  it('rejects an effort outside the DeepSeek capability', () => {
    expect(() => serializeRequest(request({
      messages: history,
      reasoningEffort: ReasoningEffortId('medium'),
    }))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
  })
})

describe('review fixes: assistant content shapes', () => {
  it('serializes a content-less, tool-call-less assistant message as "" content, never null', () => {
    // Aborted/empty assistant turns: no text, no calls → "". The earlier
    // null shape was live-falsified: the API 400s a null-content assistant
    // message without tool_calls ("content or tool_calls must be set").
    const wire = serializeMessages([createMessage({
      role: 'assistant', content: [],
      source: { kind: 'plugin', plugin: 'test' },
    })])
    expect(wire).toEqual([{ role: 'assistant', content: '' }])
  })

  it('serializes a reasoning-ONLY assistant message as "" content beside its reasoning', () => {
    // The model can answer entirely in the reasoning channel (a v4-flash
    // greeting did, live). Content must still be SET — a null here poisoned
    // the session log and bricked every later turn of that session.
    const wire = serializeMessages([createMessage({
      role: 'assistant', content: [{ type: 'reasoning', text: '你好！有什么我可以帮你的吗？' }],
      source: { kind: 'plugin', plugin: 'test' },
    })])
    expect(wire).toEqual([{
      role: 'assistant', content: '', reasoning_content: '你好！有什么我可以帮你的吗？',
    }])
  })

  it('serializes tool-call turns with empty string content, not null', () => {
    const wire = serializeMessages([createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: CallId('c'), name: 'f', arguments: '{}' }],
      source: { kind: 'plugin', plugin: 'test' },
    })])
    expect(wire[0]).toMatchObject({ content: '' })
  })
})

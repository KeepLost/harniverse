/** Messages request conversion, replay validation, and image representations. */

import { describe, expect, it, vi } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createMessage, createToolResultMessage, ReasoningEffortId, CallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageBlock, Message } from '@deepseek-ai/dsh-llm'
import { resolveAdapterOptions } from '../../src/index.ts'
import type { Config } from '../../src/index.ts'
import { modelInfo } from '../../src/common/model-info.ts'
import type { ImageRequestRepresentation, ImageSerializationOptions } from '../../src/common/request-images.ts'
import { readReplay, replayState } from '../../src/protocols/messages/replay.ts'
import { serialize } from '../../src/protocols/messages/serialize.ts'
import { MODEL, options, user } from './helpers.ts'

const connection = resolveAdapterOptions({ protocol: 'messages' })
const call = (id = 'a'): ContentBlock => ({ type: 'tool-call', id: CallId(id), name: 'read', arguments: '{"path":"a"}' })
const assistant = (content: ContentBlock[]) => createAssistantMessage({ content, source: { provider: 'deepseek-official', model: MODEL } })
const result = (id = 'a', content: ContentBlock[] = [{ type: 'text', text: 'result' }]) => createToolResultMessage({ callId: CallId(id), content, isError: false })
const PLAIN = 'deepseek-v4-pro'
const body = async (messages: Message[] = [user()], overrides: Partial<GenerateOptions> = {}) => serialize(
  options({ model: PLAIN, messages, ...overrides }), connection, connection.defaults, messages, undefined,
)
const system = (text: string) => createMessage({ role: 'system', source: { kind: 'plugin', plugin: 'test' }, content: [{ type: 'text', text }] })
const capable = resolveAdapterOptions({ protocol: 'messages', models: [{ id: MODEL, systemPromptUpdate: 'in-history' }] })
const nativeBody = async (messages: Message[]) => serialize(options({ messages }), capable, capable.defaults, messages, undefined)

describe('Messages request conversion', () => {
  it('keeps the original top-level prompt and cached prefix while appending native system updates', async () => {
    const head = system('original')
    const first = [head, user('first')]
    const update = system('updated')
    const second = [...first, assistant([{ type: 'text', text: 'one' }]), update, user('second')]
    const saved = JSON.stringify(second)
    const before = await nativeBody(first)
    const after = await nativeBody(second)
    expect(after.system).toBe(before.system)
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages)
    expect(after.messages.slice(-2)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
      { role: 'system', content: [{ type: 'text', text: 'updated' }] },
    ])
    const third = await nativeBody([...second, assistant([{ type: 'text', text: 'two' }]), user('third')])
    expect(third.messages.slice(0, after.messages.length)).toEqual(after.messages)
    expect(JSON.stringify(second)).toBe(saved)
  })

  it('places system updates after all parallel tool results and before the next assistant', async () => {
    const history = [system('original'), user(), assistant([call(), call('b')]),
      system('first update'), result(), system('second update'), result('b'),
      user('more input'), assistant([{ type: 'text', text: 'done' }])]
    const request = await nativeBody(history)
    expect(request.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'system', 'system', 'assistant'])
    expect(request.messages[2]?.content.map(block => block.type)).toEqual(['tool_result', 'tool_result', 'text'])
    expect(request.messages.slice(3, 5).map(message => message.content)).toEqual([
      [{ type: 'text', text: 'first update' }], [{ type: 'text', text: 'second update' }],
    ])
  })

  it('accepts native trailing updates without a top-level prompt and rejects unrepresentable positions', async () => {
    const update = system('update')
    expect(await nativeBody([user(), update])).toMatchObject({ messages: [
      { role: 'user' }, { role: 'system', content: [{ type: 'text', text: 'update' }] },
    ] })
    expect((await nativeBody([user(), update])).system).toBeUndefined()
    await expect(nativeBody([user(), assistant([{ type: 'text', text: 'done' }]), update])).rejects.toThrow(/preceding user/)
    await expect(nativeBody([user(), system('')])).rejects.toThrow(/empty in-history/)
    await expect(nativeBody([user(), assistant([call(), call('b')]), update, result()])).rejects.toThrow(/immediate results/)
  })

  it('groups parallel results before ordinary text and keeps tool failure content', async () => {
    const messages = [user(), assistant([call(), call('b')]), user('follow-up'), result(), createToolResultMessage({ callId: CallId('b'), content: [{ type: 'text', text: 'permission denied' }], isError: true })]
    expect((await body(messages)).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: ['a', 'b'].map(id => ({ type: 'tool_use', id, name: 'read', input: { path: 'a' } })) },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'result' }], is_error: false },
        { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'permission denied' }], is_error: true },
        { type: 'text', text: 'follow-up' },
      ] },
    ])
    expect(messages[2]?.content).toEqual([{ type: 'text', text: 'follow-up' }])
  })

  it('preserves empty results without inventing model-visible output', async () => {
    const response = await body([user(), assistant([call()]), result('a', [])])
    expect(response.messages[2]?.content[0]).toMatchObject({ content: [] })
    const minimal = createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'tool-result', toolCallId: CallId('a'), content: [{ type: 'text', text: '' }] }] })
    expect((await body([assistant([call()]), minimal])).messages[1]?.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'a', content: [] })
  })

  it('collects leading system text and maps tools, stop sequences and explicit output cap', async () => {
    const system = createMessage({ role: 'system', source: { kind: 'plugin', plugin: 'test' }, content: [{ type: 'text', text: 'instructions' }] })
    expect(await body([system, user()], { system: 'top', maxTokens: 123, stop: ['END'], tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }] })).toMatchObject({
      system: 'top\n\ninstructions', max_tokens: 123, stop_sequences: ['END'], tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object' } }],
    })
    expect((await body([user(), system])).system).toBe('instructions')
  })

  it('uses the latest complete system snapshot without changing tool history or durable messages', async () => {
    const conversation = [user(), assistant([call()]), result(), assistant([{ type: 'text', text: 'done' }]), user('continue')]
    const history = [system('obsolete'), ...conversation.slice(0, 2),
      system('intermediate'), ...conversation.slice(2, 4),
      system('current'), conversation[4]!]
    const saved = JSON.stringify(history)
    expect(await body(history)).toEqual({ ...await body(conversation), system: 'current' })
    expect((await body(history, { system: 'one-shot prefix' })).system).toBe('one-shot prefix\n\ncurrent')
    expect(JSON.stringify(history)).toBe(saved)
  })

  it('replaces adjacent system snapshots and joins blocks only within the current snapshot', async () => {
    const latest = createMessage({ role: 'system', source: { kind: 'plugin', plugin: 'test' },
      content: [{ type: 'text', text: 'part one' }, { type: 'text', text: ' and part two' }] })
    expect((await body([system('old'), latest, user()])).system).toBe('part one and part two')
  })

  it.each([[], [{ type: 'text' as const, text: '' }]].map(content => ({ content })))('clears earlier prompt snapshots with empty content %#', async ({ content }) => {
    const cleared = createMessage({ role: 'system', source: { kind: 'plugin', plugin: 'test' }, content })
    const history = [system('old'), user(), cleared]
    expect((await body(history)).system).toBeUndefined()
    expect((await body(history, { system: 'one-shot prefix' })).system).toBe('one-shot prefix')
    expect((await body(history, { system: '' })).system).toBeUndefined()
  })

  it('rejects non-text system content even when a later snapshot supersedes it', async () => {
    const invalid = createMessage({ role: 'system', source: { kind: 'plugin', plugin: 'test' }, content: [{ type: 'reasoning', text: 'bad' }] })
    await expect(body([invalid, user(), system('current')])).rejects.toThrow(/non-text system/)
  })

  it.each(['off', 'low', 'high', 'max'])('maps reasoning effort %s', async (effort) => {
    const request = await body([user()], { reasoningEffort: ReasoningEffortId(effort) })
    expect(request.thinking.type).toBe(effort === 'off' ? 'disabled' : 'enabled')
    expect(request.output_config).toEqual(effort === 'off' ? undefined : { effort })
  })

  it('disables thinking for titles, passes temperature with thinking and refuses unsupported effort', async () => {
    expect(await body([user()], { purpose: 'session-title', temperature: 0 })).toMatchObject({ thinking: { type: 'disabled' }, temperature: 0 })
    expect(await body([user()], { temperature: 0 })).toMatchObject({ thinking: { type: 'enabled' }, temperature: 0 })
    await expect(body([user()], { reasoningEffort: ReasoningEffortId('medium') })).rejects.toThrow(/effort/)
    const disabled = resolveAdapterOptions({ protocol: 'messages', thinking: 'disabled' })
    expect((await serialize(options(), disabled, disabled.defaults, [user()], undefined)).thinking).toEqual({ type: 'disabled' })
    await expect(serialize(options({ reasoningEffort: ReasoningEffortId('high') }), disabled, disabled.defaults, [user()], undefined)).rejects.toThrow(/effort/)
    const capped = resolveAdapterOptions({ protocol: 'messages', models: [{ id: MODEL, maxTokens: 321 }] })
    expect((await serialize(options(), capped, capped.defaults, [user()], undefined)).max_tokens).toBe(321)
    const low = resolveAdapterOptions({ protocol: 'messages', reasoningEffort: 'low' })
    expect(modelInfo(low, 'deepseek-official', MODEL).reasoning?.defaultEffort).toBe(ReasoningEffortId('low'))
  })

  it.each([
    [result()], [assistant([call()])], [assistant([call()]), user()],
    [assistant([call(), call()]), result()],
    [assistant([call()]), result(), result()],
  ])('rejects unmatched or duplicated tool history %#', async (...messages) => {
    await expect(body(messages)).rejects.toThrow(/tool/)
  })

  it.each(['{', '', '[]', 'null', '42', 'true', '"text"', '{"description":"最快，但"某个说法"没有证据。"}'])('uses empty input for malformed or non-object historical tool arguments %s', async (arguments_) => {
    const message = assistant([{ type: 'tool-call', id: CallId('a'), name: 'read', arguments: arguments_ }])
    const history = [user(), message, createToolResultMessage({ callId: CallId('a'), content: [{ type: 'text', text: 'Invalid arguments' }], isError: true }), user('Continue')]
    const saved = JSON.stringify(history)
    const restored = JSON.parse(saved) as Message[]
    expect((await body(restored)).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read', input: {} }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'Invalid arguments' }], is_error: true },
        { type: 'text', text: 'Continue' },
      ] },
    ])
    expect(JSON.stringify(restored)).toBe(saved)
  })

  it('preserves own signed thinking, omits absent signatures and validates durable metadata', async () => {
    const content: ContentBlock[] = [{ type: 'reasoning', text: '' }, { type: 'text', text: 'answer' }]
    const source = { provider: 'deepseek-official', model: MODEL, replayState: replayState(MODEL, [{ type: 'reasoning', signature: 'signed' }, { type: 'text' }]) }
    const message = createAssistantMessage({ content, source })
    expect((await body([user(), message, user()], { model: MODEL })).messages[1]?.content).toEqual([{ type: 'thinking', thinking: '', signature: 'signed' }, { type: 'text', text: 'answer' }])
    expect((await body([assistant([{ type: 'reasoning', text: 'foreign thought' }])])).messages[0]?.content).toEqual([{ type: 'thinking', thinking: 'foreign thought' }])
    expect(readReplay(message, 'different-model')).toBeUndefined()
    expect(readReplay(user(), MODEL)).toBeUndefined()
  })

  it.each([
    null,
    [],
    { response: null, blocks: [] },
    { response: { kind: 'other', version: 1 }, blocks: [] },
    { response: { kind: 'deepseek-messages', version: 2 }, blocks: [] },
    { response: { kind: 'deepseek-messages', version: 1, model: 'wrong' }, blocks: [] },
    { response: { kind: 'deepseek-messages', version: 1, model: MODEL }, blocks: [] },
    { response: { kind: 'deepseek-messages', version: 1, model: MODEL }, blocks: null },
    { response: { kind: 'deepseek-messages', version: 1, model: MODEL }, blocks: [null] },
    { response: { kind: 'deepseek-messages', version: 1, model: MODEL }, blocks: [{ type: 'tool-call' }] },
    { response: { kind: 'deepseek-messages', version: 1, model: MODEL }, blocks: [{ type: 'reasoning', signature: 3 }] },
  ].map(state => ({ state })))('degrades unusable replay state with a diagnostic %#', ({ state }) => {
    const message = createAssistantMessage({ content: [{ type: 'reasoning', text: 'think' }], source: { provider: 'deepseek-official', model: MODEL, replayState: state } })
    const onDegrade = vi.fn()
    expect(readReplay(message, MODEL, onDegrade)).toBeUndefined()
    expect(onDegrade).toHaveBeenCalledExactlyOnceWith(expect.any(String))
  })

  it('drops unusable signatures while keeping durable tool history intact', async () => {
    const message = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'Read the file.' }, { type: 'text', text: 'Checking a.' }, call()],
      source: { provider: 'deepseek-official', model: MODEL, replayState: replayState(MODEL, [
        { type: 'reasoning', signature: 'do-not-send' }, { type: 'text', signature: 'invalid-for-text' }, { type: 'tool-call' },
      ]) },
    })
    const saved = JSON.stringify(message)
    const restored = JSON.parse(saved) as Message
    const messages = [user(), restored, result()]
    const onDegrade = vi.fn()
    const request = await serialize(options(), connection, connection.defaults, messages, undefined, onDegrade)
    expect(onDegrade).toHaveBeenCalledExactlyOnceWith('DeepSeek Messages replay: invalid signature')
    expect(request.messages[1]?.content).toEqual([
      { type: 'thinking', thinking: 'Read the file.' },
      { type: 'text', text: 'Checking a.' },
      { type: 'tool_use', id: 'a', name: 'read', input: { path: 'a' } },
    ])
    expect(JSON.stringify(restored)).toBe(saved)
  })

  it('keeps valid cross-model and foreign history quiet and propagates diagnostic failures', () => {
    const onDegrade = vi.fn()
    const message = createAssistantMessage({ content: [{ type: 'reasoning', text: 'think' }], source: {
      provider: 'deepseek-official', model: MODEL, replayState: replayState(MODEL, [{ type: 'reasoning', signature: '' }]),
    } })
    expect(readReplay(message, MODEL, onDegrade)).toEqual([{ type: 'reasoning', signature: '' }])
    expect(readReplay(message, 'different-model', onDegrade)).toBeUndefined()
    expect(readReplay(assistant([{ type: 'text', text: 'foreign' }]), MODEL, onDegrade)).toBeUndefined()
    expect(onDegrade).not.toHaveBeenCalled()
    const damaged = { ...message, source: { ...message.source, replayState: { response: {}, blocks: [] } } }
    const failure = new Error('diagnostic failed')
    expect(() => readReplay(damaged, MODEL, () => { throw failure })).toThrow(failure)
  })
})

describe('Messages images', () => {
  const ref: ImageAttachmentRef = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', width: 1, height: 1, bytes: 3 }
  const image: ImageBlock = { type: 'image', attachment: ref }
  const version: RequestImageAttachment = {
    attachment: ref,
    variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
    mediaType: 'image/png',
    bytes: 3,
    data: Uint8Array.of(1, 2, 3),
    width: 1,
    height: 1,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
  }
  const withImages = (
    representation: ImageRequestRepresentation,
    extra: Partial<ImageSerializationOptions> = {},
  ): ImageSerializationOptions => ({
    representation,
    requestImages: new Map([[ref.attachmentId, version]]),
    ...extra,
  })
  const imageBody = async (messages: Message[], images: ImageSerializationOptions | undefined, overrides: Partial<GenerateOptions> = {}) =>
    serialize(options({ model: MODEL, messages, ...overrides }), connection, connection.defaults, messages, images)

  it('sends inline base64 sources with a handle naming the durable attachment', async () => {
    const request = await imageBody([user('look'), createMessage({ role: 'user', source: { kind: 'user' }, content: [image] })], withImages({ kind: 'base64' }))
    expect(request.messages[0]?.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'text', text: `[image ${ref.attachmentId} 1x1]` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
    ])
  })

  it('resolves file representations through the shared upload seam', async () => {
    const resolveFileId = vi.fn(async () => 'file-9')
    const request = await imageBody([createMessage({ role: 'user', source: { kind: 'user' }, content: [image] })], withImages({ kind: 'file', resolveFileId }))
    expect(request.messages[0]?.content[1]).toEqual({ type: 'image', source: { type: 'file', file_id: 'file-9' } })
    expect(resolveFileId).toHaveBeenCalledExactlyOnceWith(version, { message: 1, image: 1 })
  })

  it('keeps image bytes inside tool results after their identity text', async () => {
    const request = await imageBody([assistant([call()]), result('a', [image])], withImages({ kind: 'base64' }))
    expect(request.messages[1]?.content[0]).toMatchObject({ type: 'tool_result', content: [
      { type: 'text', text: `[image ${ref.attachmentId} 1x1]` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
    ] })
  })

  it('separates the handle from earlier content in one tool result', async () => {
    const request = await imageBody([assistant([call()]), result('a', [{ type: 'text', text: 'see' }, image])], withImages({ kind: 'base64' }))
    expect(request.messages[1]?.content[0]).toMatchObject({ type: 'tool_result', content: [
      { type: 'text', text: 'see' },
      { type: 'text', text: `\n[image ${ref.attachmentId} 1x1]` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
    ] })
  })

  it('marks omitted images without leaking their bytes', async () => {
    const request = await imageBody([createMessage({ role: 'user', source: { kind: 'user' }, content: [image] })],
      withImages({ kind: 'base64' }, { omittedImages: new Set([ref.attachmentId]) }))
    expect(request.messages[0]?.content).toEqual([{ type: 'text', text: `[image omitted: ${ref.attachmentId}]` }])
  })

  it('rejects unprepared, misplaced, and unrepresentable image content', async () => {
    await expect(imageBody([createMessage({ role: 'user', source: { kind: 'user' }, content: [image] })],
      withImages({ kind: 'base64' }, { requestImages: new Map() }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(imageBody([createMessage({ role: 'user', source: { kind: 'user' }, content: [image] })], undefined))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(imageBody([assistant([image as ContentBlock])], withImages({ kind: 'base64' })))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(imageBody([result('a', [{ type: 'reasoning', text: 'bad' }])], undefined))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(imageBody([result('a', [{ type: 'tool-result', toolCallId: CallId('x'), content: [] }])], undefined))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })
})

describe('validated configuration', () => {
  it('advertises exact model metadata and allows unlisted text models', () => {
    expect(modelInfo(connection, 'deepseek-official', MODEL)).toMatchObject({ context: { contextWindow: 1_000_000 }, defaultMaxTokens: 256_000, reasoning: { defaultEffort: 'high' } })
    expect(modelInfo(connection, 'deepseek-official', 'custom').inputModalities).toEqual(['text'])
    expect(modelInfo(resolveAdapterOptions({ protocol: 'messages', thinking: 'disabled' }), 'deepseek-official', MODEL).reasoning?.efforts).toMatchObject([{ id: 'off', name: 'Off' }])
    expect(resolveAdapterOptions({ protocol: 'messages', baseURL: 'https://example.com/anthropic///' }).baseURL).toBe('https://example.com/anthropic///')
  })
  it.each([
    { protocol: 'messages', models: [{ id: MODEL, contextWindow: 0 }] },
    { protocol: 'messages', models: [{ id: MODEL, maxTokens: 1.5 }] },
    { protocol: 'messages', models: [{ id: MODEL, imageMaxBytes: 0 }] },
    { protocol: 'messages', models: [{ id: MODEL, systemPromptUpdate: 'unsupported' as never }] },
  ])('rejects invalid composition input %#', (value) => {
    expect(() => resolveAdapterOptions(value as Config)).toThrow()
  })
})

import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId, createToolResultMessage, createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { DeepSeekFileStore, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { imageSerialization, projectImageOmissions, type ImageSerializationOptions } from '../src/common/request-images.ts'

const attachment = { attachmentId: AttachmentId('same-image'), mediaType: 'image/png' as const, bytes: 4, width: 1, height: 1 }
const image = { type: 'image' as const, attachment }

function request(): GenerateOptions {
  return {
    provider: 'deepseek-official', model: 'vision',
    messages: [
      createToolResultMessage({ callId: CallId('read'), isError: false, content: [
        { type: 'text', text: 'before' }, image, { type: 'text', text: 'between' }, image,
      ] }),
      createUserMessage({ source: { kind: 'user' }, content: [image] }),
    ],
  }
}

describe('request image omission boundaries', () => {
  it('rejects mismatched prepared references before selecting a representation', () => {
    expect(() => imageSerialization(
      { refs: [attachment], versions: [] }, resolveAdapterOptions({}), new DeepSeekFileStore(),
      'test-key', new AbortController().signal, 'base64', 'chat-completions', request().messages,
    )).toThrow('DeepSeek image preparation returned mismatched references.')
  })

  it('preserves the original request when a direct serializer caller supplies no occurrence omissions', () => {
    const options = request()
    const images: ImageSerializationOptions = { representation: { kind: 'base64' }, requestImages: new Map() }
    expect(projectImageOmissions(options, images)).toBe(options)
    expect(options.messages[1]?.content).toEqual([image])
  })

  it('omits only the selected nested occurrence while retaining repeated attachments elsewhere', () => {
    const options = request()
    const result = projectImageOmissions(options, {
      representation: { kind: 'base64' }, requestImages: new Map(),
      omittedOccurrences: [{ message: 0, image: 1 }],
    })
    expect(result.messages[0]).toEqual({
      ...options.messages[0],
      content: [{ type: 'tool-result', toolCallId: CallId('read'), isError: false, content: [
        { type: 'text', text: 'before' }, image, { type: 'text', text: 'between' },
        { type: 'text', text: '[image omitted: same-image]' },
      ] }],
    })
    expect(result.messages[1]).toEqual(options.messages[1])
    expect(options.messages[0]?.content[0]).toMatchObject({ content: [
      { type: 'text', text: 'before' }, image, { type: 'text', text: 'between' }, image,
    ] })
    expect(Object.isFrozen(result.messages[0]?.content[0])).toBe(true)
  })
})

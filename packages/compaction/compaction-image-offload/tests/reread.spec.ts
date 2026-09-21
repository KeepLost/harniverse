/** Real read_image admission and binary retention across temporary request visibility. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import LlmRuntime, { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { OFFLOADED_IMAGE_STUB_TEXT } from '@deepseek-ai/dsh-image-offload-policy'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as imageOffload from '../src/index.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

it.each(['age', 'pressure'] as const)('applies %s to an authorized re-read and denies another read without accessing retained bytes', async (reason) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-offload-reread-'))
  directories.push(dir)
  await writeFile(join(dir, 'red.png'), png)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools, { mode: 'native' })
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(LocalAttachmentStore, { dshHome: dir })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  ctx.provide('settings', { get: () => ({ imageOffloadAfterUserTurns: 2 }) })
  await ctx.plugin(imageOffload)
  await ctx.plugin(ToolFs)
  const adapter = new MockAdapter([
    textResponse('ok'), textResponse('ok'), textResponse('ok'),
    (options) => {
      if (reason === 'pressure') {
        const message = options.messages.findIndex(entry => entry.source.kind === 'tool' && entry.source.callId === CallId('explicit-reread'))
        expect(message).toBeGreaterThanOrEqual(0)
        const projected = options.onImagesOmitted?.([{ message, image: 0 }])
        expect(JSON.stringify(projected?.[message]?.content)).toContain(OFFLOADED_IMAGE_STUB_TEXT)
      }
      return textResponse('ok')
    },
    textResponse('ok'),
  ])
  adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  ctx.llm.registerAdapter(['vision'], adapter)
  const session = ctx.sessions.create(SessionId('reread'), { meta: { cwd: dir } })
  const agent = { session, options: { provider: 'vision', model: 'vision' } } as Agent
  const read = (id: string) => ctx.tools.execute({
    signal: new AbortController().signal, callId: CallId(id), name: 'read_image',
    arguments: { file_path: 'red.png' }, agent,
  })
  const send = async () => {
    for await (const _chunk of ctx.llm.stream({ provider: 'vision', model: 'vision', sessionId: session.id, messages: session.deriveMessages() })) { /* drain */ }
  }
  const laterUser = () => session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'next' }] }), { surfaceOp: 'append' })

  const first = await read('initial')
  expect(first.isError).toBe(false)
  const image = first.content.find(block => block.type === 'image')
  if (image?.type !== 'image') throw new Error('read_image did not return an image')
  const original = session.append('tool/result', {
    turn: 1, step: 1, message: createToolResultMessage({ callId: CallId('initial'), content: first.content, isError: false }),
  }, { surfaceOp: 'append' })
  await send()
  laterUser()
  laterUser()
  await send()
  expect(session.events.filter(event => event.type === 'image/offload').flatMap(event => event.data.targets)).toEqual([
    { messageSeq: original.seq, imageIndex: 0 },
  ])
  const reread = await read('explicit-reread')
  expect(reread.isError).toBe(false)
  expect(reread.content.find(block => block.type === 'image')).toEqual(image)
  const fresh = session.append('tool/result', {
    turn: 2, step: 1, message: createToolResultMessage({ callId: CallId('explicit-reread'), content: reread.content, isError: false }),
  }, { surfaceOp: 'append' })
  const visibleTypes = () => {
    const result = session.projectedMessageAt(fresh.seq)?.content[0]
    if (result?.type !== 'tool-result') throw new Error('missing reread projection')
    return result.content.map(block => block.type)
  }
  await send()
  expect(visibleTypes()).toContain('image')
  laterUser()
  await send()
  expect(visibleTypes().includes('image')).toBe(reason === 'age')
  laterUser()
  await send()
  expect(visibleTypes()).not.toContain('image')
  expect(JSON.stringify(adapter.requests.at(-1)?.messages)).toContain(OFFLOADED_IMAGE_STUB_TEXT)
  expect(session.events.filter(event => event.type === 'image/offload').flatMap(event => event.data.targets)).toEqual([
    { messageSeq: original.seq, imageIndex: 0 }, { messageSeq: fresh.seq, imageIndex: 0 },
  ])
  expect(original.data.message.content[0].content).toEqual(first.content)
  const attachments = ctx.get('attachments')!
  const stored = await attachments.readImage(image.attachment)
  expect(Buffer.from(stored.data)).toEqual(png)
  expect(image.attachment).toMatchObject({ width: 1, height: 1, bytes: png.length, name: 'red.png' })
  expect(image.attachment.attachmentId).toMatch(/^sha256:[a-f0-9]{64}$/)

  const reads = vi.spyOn(ctx.fs, 'readBytes')
  const saves = vi.spyOn(attachments, 'saveImage')
  ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'read_image'
    ? { kind: 'deny', reason: 'image read permission revoked' }
    : next())
  const denied = await read('denied-reread')
  expect(denied.isError).toBe(true)
  expect(denied.content.some(block => block.type === 'image')).toBe(false)
  expect(JSON.stringify(denied.content)).toContain('image read permission revoked')
  expect(reads).not.toHaveBeenCalled()
  expect(saves).not.toHaveBeenCalled()
  expect(Buffer.from((await attachments.readImage(image.attachment)).data)).toEqual(png)
})

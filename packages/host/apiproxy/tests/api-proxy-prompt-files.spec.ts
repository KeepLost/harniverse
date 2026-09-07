/** File-part prompt admission: receipt verification, handle publication, rollback-on-failure. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createApiProxy } from '../src/index.ts'
import type { RpcRequest } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'

class CatalogAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: provider }
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // File-admission tests never enter provider streaming.
  }
}

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('r1'), operation: 'op', payload } as RpcRequest<P>
}

async function harness(): Promise<{ ctx: Context; agent: Agent; sessionId: SessionId }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  ctx.llm.registerAdapter(['deepseek-official'], new CatalogAdapter())
  const session = ctx.sessions.create()
  const agent = {
    id: session.id,
    session,
    status: 'running',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  ctx.agents.register(agent)
  return { ctx, agent, sessionId: session.id }
}

const REF: FileAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`),
  bytes: 10,
  mediaType: 'text/plain',
  name: 'notes.txt',
}

interface FileStoreFake {
  readFile: (ref: FileAttachmentRef) => Promise<{ ref: FileAttachmentRef; data: Uint8Array }>
  publishFileHandle: (ref: FileAttachmentRef) => Promise<string>
}

function fileStore(overrides: Partial<FileStoreFake> = {}): FileStoreFake {
  const readFile = vi.fn<FileStoreFake['readFile']>(ref => Promise.resolve({ ref, data: new Uint8Array(10) }))
  const publishFileHandle = vi.fn<FileStoreFake['publishFileHandle']>(ref =>
    Promise.resolve(`/links/${String(ref.attachmentId).slice(8, 16)}-${ref.name ?? 'file'}`))
  return {
    readFile: overrides.readFile ?? readFile,
    publishFileHandle: overrides.publishFileHandle ?? publishFileHandle,
  }
}

describe('session.prompt file admission', () => {
  it('verifies the receipt, publishes the read-only handle, and injects the handle text with source files', async () => {
    const { ctx, agent, sessionId } = await harness()
    const store = fileStore()
    ctx.provide('attachments', {
      imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, mediaTypes: [] },
      fileLimits: { maxFileBytes: 1024 },
      readFile: store.readFile,
      publishFileHandle: store.publishFileHandle,
    } as never)
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const result = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [
        { type: 'file' as const, attachmentId: REF.attachmentId, bytes: REF.bytes, name: 'notes.txt', mediaType: 'text/plain' },
        { type: 'text' as const, text: 'please review' },
      ],
    }))
    expect(result.result.ok).toBe(true)
    expect(store.readFile).toHaveBeenCalledTimes(1)
    expect(store.publishFileHandle).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]?.[0] as UserMessage
    expect(message.source).toMatchObject({ kind: 'user', files: [REF] })
    const handleText = message.content.find(block => block.type === 'text' && block.text.includes('[文件]'))
    expect(handleText).toMatchObject({ type: 'text' })
    expect(JSON.stringify(message.content)).toContain('notes.txt')
    expect(JSON.stringify(message.content)).toContain('/links/')
    await ctx.fiber.dispose()
  })

  it('rolls the whole prompt back when any receipt fails verification', async () => {
    const { ctx, agent, sessionId } = await harness()
    const store = fileStore({
      readFile: vi.fn(() => Promise.reject(new Error('missing object'))),
    })
    ctx.provide('attachments', {
      imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, mediaTypes: [] },
      fileLimits: { maxFileBytes: 1024 },
      readFile: store.readFile,
      publishFileHandle: store.publishFileHandle,
    } as never)
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const result = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [
        { type: 'text' as const, text: 'legitimate text' },
        { type: 'file' as const, attachmentId: REF.attachmentId, bytes: REF.bytes },
      ],
    }))
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) {
      expect(result.result.error.code).toBe('attachment-error')
    }
    expect(followup).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('rejects an unknown attachmentId shape without touching storage', async () => {
    const { ctx, agent, sessionId } = await harness()
    const store = fileStore()
    ctx.provide('attachments', {
      imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, mediaTypes: [] },
      fileLimits: { maxFileBytes: 1024 },
      readFile: store.readFile,
      publishFileHandle: store.publishFileHandle,
    } as never)
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const result = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'file' as const, attachmentId: 'not-a-sha', bytes: 4 }],
    }))
    expect(result.result.ok).toBe(false)
    expect(store.readFile).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})

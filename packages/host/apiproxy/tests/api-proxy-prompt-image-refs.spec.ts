/** Staged-image prompt admission: receipt verification, canonical citation, limit accounting, rollback. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
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
    // Image-admission tests never enter provider streaming.
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

const PIXEL_BASE64 = Buffer.from('png-bytes').toString('base64')

function stagedRef(over: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${'e'.repeat(64)}`),
    mediaType: 'image/png',
    bytes: 10,
    width: 4,
    height: 4,
    name: 'pic.png',
    ...over,
  }
}

interface ImageStoreFake {
  readImage: (ref: ImageAttachmentRef) => Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>
  validateImage: (input: SaveImageAttachment) => Promise<void>
  saveImage: (input: SaveImageAttachment) => Promise<ImageAttachmentRef>
}

function imageStore(overrides: Partial<ImageStoreFake> = {}): ImageStoreFake {
  return {
    readImage: overrides.readImage ?? vi.fn((ref: ImageAttachmentRef) => Promise.resolve({ ref, data: new Uint8Array(10) })),
    validateImage: overrides.validateImage ?? vi.fn(() => Promise.resolve()),
    saveImage: overrides.saveImage ?? vi.fn(() => Promise.resolve(stagedRef())),
  }
}

function provideImages(
  ctx: Context,
  store: ImageStoreFake,
  limits: { maxImagesPerMessage?: number; maxMessageImageBytes?: number } = {},
): void {
  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 1024,
      maxImagesPerMessage: limits.maxImagesPerMessage ?? 4,
      maxMessageImageBytes: limits.maxMessageImageBytes ?? 2048,
      maxImagePixels: 1024,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    readImage: store.readImage,
    validateImage: store.validateImage,
    saveImage: store.saveImage,
  } as never)
}

describe('session.prompt staged image admission', () => {
  it('verifies the staged reference and cites the canonical stored object', async () => {
    const { ctx, agent, sessionId } = await harness()
    const wire = stagedRef({ name: 'Local/Pic.PNG' })
    const canonical = stagedRef({ name: 'pic.png' })
    const store = imageStore({ readImage: vi.fn(() => Promise.resolve({ ref: canonical, data: new Uint8Array(10) })) })
    provideImages(ctx, store)
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
        { type: 'image' as const, ref: wire },
        { type: 'text' as const, text: '请看图' },
      ],
    }))
    expect(result.result.ok).toBe(true)
    const message = followup.mock.calls[0]?.[0] as UserMessage
    expect(message.content).toContainEqual({ type: 'image', attachment: canonical })
    expect(store.validateImage).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('counts staged bytes and image counts toward the per-message limits', async () => {
    const { ctx, agent, sessionId } = await harness()
    provideImages(ctx, imageStore(), { maxMessageImageBytes: 8 })
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    const tooManyBytes = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'image' as const, ref: stagedRef({ bytes: 12 }) }],
    }))
    expect(tooManyBytes.result.ok).toBe(false)
    if (!tooManyBytes.result.ok) {
      expect(tooManyBytes.result.error.details).toMatchObject({ reason: 'IMAGES_TOO_LARGE' })
    }
    expect(followup).not.toHaveBeenCalled()

    const { ctx: ctx2, agent: agent2, sessionId: session2 } = await harness()
    provideImages(ctx2, imageStore(), { maxImagesPerMessage: 1 })
    const followup2 = vi.fn()
    Object.assign(agent2, { followup2 })
    const api2 = createApiProxy(ctx2, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    const tooManyImages = await api2.sessions.prompt(request({
      sessionId: session2,
      mode: 'queue' as const,
      content: [
        { type: 'image' as const, ref: stagedRef() },
        { type: 'image' as const, ref: stagedRef({ attachmentId: AttachmentId(`sha256:${'f'.repeat(64)}`) }) },
      ],
    }))
    expect(tooManyImages.result.ok).toBe(false)
    if (!tooManyImages.result.ok) {
      expect(tooManyImages.result.error.details).toMatchObject({ reason: 'TOO_MANY_IMAGES' })
    }
    expect(followup2).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
    await ctx2.fiber.dispose()
  })

  it('rolls the whole prompt back when a staged reference fails verification', async () => {
    const { ctx, agent, sessionId } = await harness()
    provideImages(ctx, imageStore({
      readImage: vi.fn(() => Promise.reject(new Error('missing object'))),
    }))
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
        { type: 'image' as const, ref: stagedRef() },
      ],
    }))
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) {
      expect(result.result.error.code).toBe('attachment-error')
      expect(result.result.error.details).toMatchObject({ reason: 'ATTACHMENT_READ_FAILED' })
    }
    expect(followup).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('admits encoded images and staged references side by side without re-validating the staged one', async () => {
    const { ctx, agent, sessionId } = await harness()
    const encoded = stagedRef({ attachmentId: AttachmentId(`sha256:${'9'.repeat(64)}`), bytes: 9 })
    const store = imageStore({ saveImage: vi.fn(() => Promise.resolve(encoded)) })
    provideImages(ctx, store)
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
        { type: 'image' as const, mediaType: 'image/png' as const, data: PIXEL_BASE64 },
        { type: 'image' as const, ref: stagedRef() },
        { type: 'text' as const, text: '两张图' },
      ],
    }))
    expect(result.result.ok).toBe(true)
    const message = followup.mock.calls[0]?.[0] as UserMessage
    const attachments = message.content.filter(block => block.type === 'image')
    expect(attachments).toHaveLength(2)
    expect(store.saveImage).toHaveBeenCalledTimes(1)
    expect(store.validateImage).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })
})

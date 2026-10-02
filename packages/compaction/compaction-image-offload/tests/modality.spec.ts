// Modality offload: a request-boundary settlement that stubs every retained
// image occurrence when the final route's model accepts no image input,
// mints read-only hard-link paths through the attachment service, and keeps
// the stubs after switching back to a vision model. Covers the agent/request
// waterfall ordering (settlement observes the config inner listeners chose),
// images produced later in the same session, and cross-model route fallback.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import ModelPolicyService from '@deepseek-ai/dsh-model-policy'
import * as modelPolicyFallback from '@deepseek-ai/dsh-model-policy-fallback'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as imageOffload from '../src/index.ts'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
)
const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Model ids ending in `text-only` accept no image input. */
async function modalResolve(provider: string, model: string): Promise<LlmResolvedModelInfo> {
  return {
    provider,
    id: model,
    name: model,
    inputModalities: model === 'text-only' ? ['text'] : ['text', 'image'],
  }
}

function imageBlock(ref: ImageAttachmentRef) {
  return { type: 'image' as const, attachment: ref }
}

/** Scripted adapter whose entries may be terminal errors, like the fallback harness. */
class ScriptedModalAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: readonly (StreamChunk[] | Error)[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(modalResolve(provider, model))
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script[this.requests.length - 1]
    if (entry instanceof Error) throw entry
    for (const chunk of entry ?? []) yield chunk
  }
}

interface Bench {
  ctx: Context
  agent: Agent
  home: string
  adapter: MockAdapter
  ref: ImageAttachmentRef
}

async function harness(script: MockAdapter['script']): Promise<Bench> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-modality-'))
  directories.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools, { mode: 'native' })
  await ctx.plugin(LocalFileSystem, { cwd: home })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(imageOffload)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  adapter.resolveModel = modalResolve
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId('modality'), { provider: 'mock', model: 'vision' })
  const [ref] = await ctx.get('attachments')!.saveImages([{ data: png, mediaType: 'image/png', name: 'photo.png' }]) as [ImageAttachmentRef]
  return { ctx, agent, home, adapter, ref }
}

function send(agent: Agent, ...blocks: Parameters<typeof createUserMessage>[0]['content']): void {
  agent.followup(createUserMessage({ content: blocks, source: { kind: 'user' } }))
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** Text blocks of one request's messages. */
function textBlocks(request: GenerateOptions): string[] {
  return request.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => (block.type === 'text' ? block.text : ''))
}

/** The read-only path one request's stub names. */
function stubPath(request: GenerateOptions): string {
  const stub = textBlocks(request).find(text => text.includes('只读路径'))
  if (stub === undefined) throw new Error('no path-bearing stub in request')
  return stub.split('\n').find(line => line.startsWith('只读路径'))!.slice('只读路径: '.length)
}

function imageCount(request: GenerateOptions): number {
  return request.messages
    .flatMap(message => message.content)
    .reduce((count, block) => count + (block.type === 'image' ? 1 : 0)
      + (block.type === 'tool-result' ? block.content.filter(nested => nested.type === 'image').length : 0), 0)
}

describe('modality offload at the request boundary', () => {
  it('stubs every image with a path-bearing handle when the model goes text-only, and re-views through read_image after switching back', async () => {
    const bench = await harness([
      textResponse('seen'),
      textResponse('stubbed'),
      // The vision model reads the stub's path back out of its own history
      // and calls read_image on it — exactly the documented re-view flow.
      options => toolCallResponse('re-view', 'read_image', { file_path: stubPath(options) }),
      textResponse('re-viewed'),
    ])
    // A mid-session model switch rides the agent/request waterfall exactly
    // like model-policy-fallback's replacement: the settlement must observe
    // the config inner listeners chose, not the seed.
    let model = 'vision'
    const disposeSwitch = bench.ctx.on('agent/request', async (_payload, next) => {
      const config = await next()
      return { ...config, model }
    })

    const idle1 = waitForIdle(bench.ctx, bench.agent)
    send(bench.agent, { type: 'text', text: 'look' }, imageBlock(bench.ref))
    await idle1
    expect(imageCount(bench.adapter.requests[0]!)).toBe(1)

    model = 'text-only'
    const idle2 = waitForIdle(bench.ctx, bench.agent)
    send(bench.agent, { type: 'text', text: 'describe it' })
    await idle2
    const stubbed = bench.adapter.requests[1]!
    expect(imageCount(stubbed)).toBe(0)
    const stub = textBlocks(stubbed).find(text => text.includes('只读路径'))
    expect(stub).toBeDefined()
    expect(stub!).toContain('[图片] photo.png')
    expect(stub!).toContain('当前模型无法查看图片')
    expect(stub!).toContain('read_image')
    // The durable decision carries the verbatim stub, and the minted path is
    // a real read-only hard link whose bytes are the retained attachment.
    const offload = bench.agent.session.events.find(event => event.type === 'image/offload')
    expect(offload?.data.targets).toHaveLength(1)
    expect(offload!.data.targets[0]!.stub).toBe(stub)
    const path = stubPath(stubbed)
    expect(path.startsWith(join(bench.home, 'attachments'))).toBe(true)
    const stored = await bench.ctx.get('attachments')!.readImage(bench.ref)
    expect(Buffer.compare(await readFile(path), Buffer.from(stored.data))).toBe(0)

    // Switch back to vision: the stubs persist (model-visible ⇔ logged), the
    // model re-views through read_image on the minted path, and the image
    // re-enters model context on the next request of the same turn.
    model = 'vision'
    const idle3 = waitForIdle(bench.ctx, bench.agent)
    send(bench.agent, { type: 'text', text: 'again' })
    await idle3
    expect(imageCount(bench.adapter.requests[2]!)).toBe(0)
    expect(textBlocks(bench.adapter.requests[2]!)).toContain(stub)
    const toolResults = bench.agent.session.events.filter(event => event.type === 'tool/result')
    expect(toolResults).toHaveLength(1)
    expect(imageCount(bench.adapter.requests[3]!)).toBe(1)
    disposeSwitch()
  })

  it('settles images produced later at the next request boundary on the same text-only route', async () => {
    const bench = await harness([textResponse('one'), textResponse('two')])
    const model = 'text-only'
    const disposeSwitch = bench.ctx.on('agent/request', async (_payload, next) => {
      const config = await next()
      return { ...config, model }
    })
    const idle1 = waitForIdle(bench.ctx, bench.agent)
    send(bench.agent, { type: 'text', text: 'a' }, imageBlock(bench.ref))
    await idle1
    expect(imageCount(bench.adapter.requests[0]!)).toBe(0)
    const offloads = () => bench.agent.session.events.filter(event => event.type === 'image/offload')
    expect(offloads()).toHaveLength(1)

    const idle2 = waitForIdle(bench.ctx, bench.agent)
    send(bench.agent, { type: 'text', text: 'b' }, imageBlock(bench.ref))
    await idle2
    expect(imageCount(bench.adapter.requests[1]!)).toBe(0)
    expect(offloads()).toHaveLength(2)
    const stubs = textBlocks(bench.adapter.requests[1]!).filter(text => text.includes('只读路径'))
    expect(stubs).toHaveLength(2)
    disposeSwitch()
  })

  it('never settles while the routed model accepts image input', async () => {
    const bench = await harness([textResponse('one')])
    const idle = waitForIdle(bench.ctx, bench.agent)
    send(bench.agent, { type: 'text', text: 'keep' }, imageBlock(bench.ref))
    await idle
    expect(bench.agent.session.events.some(event => event.type === 'image/offload')).toBe(false)
    expect(imageCount(bench.adapter.requests[0]!)).toBe(1)
  })

  it('skips the settlement when the model modalities are unknown', async () => {
    const bench = await harness([textResponse('one')])
    bench.adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model })
    const idle = waitForIdle(bench.ctx, bench.agent)
    send(bench.agent, { type: 'text', text: 'opaque' }, imageBlock(bench.ref))
    await idle
    expect(bench.agent.session.events.some(event => event.type === 'image/offload')).toBe(false)
    expect(imageCount(bench.adapter.requests[0]!)).toBe(1)
  })

  it('settles images when a route fallback lands on a text-only model', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-modality-fallback-'))
    directories.push(home)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools, { mode: 'native' })
    await ctx.plugin(LocalFileSystem, { cwd: home })
    await ctx.plugin(FsPolicy)
    await ctx.plugin(LocalAttachmentStore, { dshHome: home })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(ModelPolicyService, {
      profiles: {
        routed: {
          models: [],
          routes: ['vision-route'],
          defaultTarget: { kind: 'route', route: 'vision-route' },
        },
      },
      routes: {
        'vision-route': {
          targets: [
            { provider: 'primary', model: 'vision' },
            { provider: 'backup', model: 'text-only' },
          ],
        },
      },
    })
    await ctx.plugin(imageOffload)
    await ctx.plugin(Object.assign((inner: Context) => { modelPolicyFallback.apply(inner) }, { inject: modelPolicyFallback.inject }))
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new ScriptedModalAdapter([new LlmError('primary is down', 'AUTH'), textResponse('backup saw stubs')])
    ctx.llm.registerAdapter(['primary', 'backup'], adapter)
    const agent = ctx.agentLoop.create(SessionId('modality-fallback'), { provider: 'primary', model: 'vision' })
    ctx.modelPolicy.initialize(agent.session, 'routed')
    const [ref] = await ctx.get('attachments')!.saveImages([{ data: png, mediaType: 'image/png', name: 'fallback.png' }]) as [ImageAttachmentRef]

    const idle = waitForIdle(ctx, agent)
    send(agent, { type: 'text', text: 'look' }, imageBlock(ref))
    await idle

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['primary', 'vision'],
      ['backup', 'text-only'],
    ])
    expect(agent.session.events.some(event => event.type === 'model/fallback')).toBe(true)
    const offload = agent.session.events.find(event => event.type === 'image/offload')
    expect(offload?.data.targets[0]?.stub).toContain('只读路径')
    expect(imageCount(adapter.requests[1]!)).toBe(0)
    expect(textBlocks(adapter.requests[1]!).some(text => text.includes('只读路径'))).toBe(true)
    const end = agent.session.events.findLast(event => event.type === 'turn/end')
    expect(end?.data.reason).not.toMatchObject({ kind: 'error' })
  })
})

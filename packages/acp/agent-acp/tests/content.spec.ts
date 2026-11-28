/**
 * Content between the person and an external agent: the person's images reach
 * the agent or are named for the person, the agent's images enter the log as
 * attachments, its context accounting and document plans are recorded and
 * shown, the title it gives survives a reopen, and one preset drives several
 * agents.
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as acp from '../src/index.ts'
import { chunk, dispose, fakeAgent, harness, reopen, restore, run, say, waitForIdle, type Harness, type Mounts } from './harness.ts'

/** A valid 1x1 PNG, as the protocol's image block carries it. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const png = (uri?: string): Record<string, unknown> => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'image', data: PNG, mimeType: 'image/png', ...(uri === undefined ? {} : { uri }) },
})

const of = (agent: Agent, type: string): SessionEvent[] => agent.session.events.filter(event => event.type === type)
const replies = (agent: Agent): string[] => of(agent, 'assistant/message').map((event) => {
  const content = (event as { data: { message: { content: { type: string; text?: string }[] } } }).data.message.content
  return content.map(block => block.text ?? '').join('')
})
const noticeTexts = (agent: Agent): string[] => of(agent, 'user/message')
  .map(event => (event as { data: { source: { form?: string }; content: { text: string }[] } }).data)
  .filter(message => message.source.form === 'notice')
  .map(message => message.content.map(block => block.text).join(''))
const prompts = (h: Harness): unknown[] => h.log().filter(entry => entry.method === 'session/prompt').map(entry => entry.params)
const command = (h: Harness, agent: Agent, line: string) => h.ctx.commands.execute(agent, line, [], new AbortController().signal)

/** Send one message in a session whose workspace is the harness directory, and wait for the turn. */
async function send(h: Harness, content: ContentBlock[]): Promise<Agent> {
  const agent = h.ctx.agentLoop.create(SessionId('acp'), {}, { cwd: h.dir })
  agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
  await waitForIdle(h.ctx, agent)
  return agent
}

/** A reference no store holds, for a composition that mounts none. */
const looseImage = (name: string): ContentBlock => ({
  type: 'image',
  attachment: { attachmentId: `sha256:${'0'.repeat(64)}`, mediaType: 'image/png', bytes: 70, width: 1, height: 1, name } as ImageAttachmentRef,
})

describe("the person's images", () => {
  it('leave out a block of a person\'s message that is neither text nor image', async () => {
    const h = await harness([{ updates: [chunk('ok') ] }])
    try {
      const agent = await send(h, [{ type: 'text', text: 'look' }, { type: 'reasoning', text: 'not for the agent' }])
      expect(prompts(h)).toEqual([{ sessionId: 'external-1', prompt: [{ type: 'text', text: 'look' }] }])
      expect(noticeTexts(agent)).toEqual([])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('reach an agent that admits image prompts, after the text, as the bytes the harness stored', async () => {
    const h = await harness([{ updates: [chunk('a screenshot of a form') ] }], {}, { attachments: true }, { imagePrompts: true })
    try {
      const attachment = await h.ctx.attachments.saveImage({ data: Buffer.from(PNG, 'base64'), mediaType: 'image/png', name: 'shot.png' })
      const agent = await send(h, [{ type: 'text', text: 'what is this?' }, { type: 'image', attachment }])
      expect(prompts(h)).toEqual([{
        sessionId: 'external-1',
        prompt: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', data: PNG, mimeType: 'image/png' },
        ],
      }])
      expect(noticeTexts(agent)).toEqual([])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('stay behind, and the person reads why, when the agent admits no image prompts', async () => {
    const h = await harness([{ updates: [chunk('go on') ] }], {}, { attachments: true })
    try {
      const attachment = await h.ctx.attachments.saveImage({ data: Buffer.from(PNG, 'base64'), mediaType: 'image/png', name: 'shot.png' })
      const agent = await send(h, [{ type: 'text', text: 'what is this?' }, { type: 'image', attachment }])
      expect(prompts(h)).toEqual([{ sessionId: 'external-1', prompt: [{ type: 'text', text: 'what is this?' }] }])
      expect(noticeTexts(agent)).toEqual(['Not forwarded to the external agent: shot.png: this agent does not accept images.'])
      // The turn itself went on, and only the person's step spent an external turn.
      expect(replies(agent)).toEqual(['go on'])
      expect(of(agent, 'session/prompt')).toEqual([])
      expect(of(agent, 'turn/end')).toHaveLength(1)
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('stay behind when the composition mounts no attachment store, and an image-only message sends the placeholder', async () => {
    const h = await harness([{ updates: [chunk('ok') ] }, { updates: [chunk('ok again') ] }], {}, {}, { imagePrompts: true })
    try {
      const agent = await send(h, [{ type: 'text', text: 'look' }, looseImage('shot.png')])
      expect(prompts(h)).toEqual([{ sessionId: 'external-1', prompt: [{ type: 'text', text: 'look' }] }])
      expect(noticeTexts(agent)).toEqual(['Not forwarded to the external agent: shot.png: the harness mounted no attachment store.'])
      // Without the store there is nothing to read back, so an image-only message sends the placeholder.
      agent.followup(createUserMessage({ content: [looseImage('only.png')], source: { kind: 'user' } }))
      await waitForIdle(h.ctx, agent)
      expect(prompts(h).at(-1)).toEqual({ sessionId: 'external-1', prompt: [{ type: 'text', text: '(no text content)' }] })
      expect(noticeTexts(agent).at(-1)).toBe('Not forwarded to the external agent: only.png: the harness mounted no attachment store.')
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })
})

describe('an image the store cannot read back', () => {
  it('stays behind, and the person reads the store\'s reason', async () => {
    const h = await harness([{ updates: [chunk('ok') ] }], {}, { attachments: true }, { imagePrompts: true })
    try {
      // The reference names an object the store never held.
      const agent = await send(h, [{ type: 'text', text: 'look' }, looseImage('gone.png')])
      expect(prompts(h)).toEqual([{ sessionId: 'external-1', prompt: [{ type: 'text', text: 'look' }] }])
      expect(noticeTexts(agent)).toHaveLength(1)
      expect(noticeTexts(agent)[0]).toMatch(/^Not forwarded to the external agent: gone\.png: /)
      expect(noticeTexts(agent)[0]).not.toContain('mounted no attachment store')
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })
})

describe("the agent's images", () => {
  it('enter the log as stored attachments after the text, named by the address the agent gave', async () => {
    const h = await harness([{ updates: [chunk('here it is'), png(), png('file:///tmp/shot.png')] }], {}, { attachments: true })
    try {
      const agent = await run(h, 'show me')
      const message = of(agent, 'assistant/message')[0]
      expect(message?.type === 'assistant/message' && message.data.message.content.map(block => block.type)).toEqual(['text', 'image', 'image'])
      const images = message !== undefined && message.type === 'assistant/message'
        ? message.data.message.content.filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image')
        : []
      expect(images[0]?.attachment).toMatchObject({ mediaType: 'image/png', bytes: 70, width: 1, height: 1 })
      expect(images[0]?.attachment.name).toBeUndefined()
      expect(images[1]?.attachment).toMatchObject({ name: 'shot.png' })
      // The path the address carried is not kept.
      expect(images[1]?.attachment.name).not.toContain('/')
      // What the store holds reads back as exactly what the agent sent.
      const read = await h.ctx.attachments.readImage(images[0]?.attachment as ImageAttachmentRef)
      expect(Buffer.from(read.data).toString('base64')).toBe(PNG)
      // The message is assembled from the chunks it cites, image blocks included.
      const chunks = of(agent, 'assistant/chunk')
      expect(chunks.map(event => (event as { data: { chunk: { type: string } } }).data.chunk.type))
        .toEqual(['block-start', 'text-delta', 'block-start', 'block-end', 'block-start', 'block-end'])
      expect((message as { sourceEventSeqs?: number[] }).sourceEventSeqs).toEqual(chunks.map(event => event.seq))
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('a tool call reports enter its result, between its text, as stored attachments', async () => {
    const h = await harness([{
      updates: [
        {
          sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'the image' } },
            { type: 'content', content: { type: 'image', data: PNG, mimeType: 'image/png' } },
            { type: 'diff', path: '/a', oldText: 'x', newText: 'y' },
            // A block this driver reads neither as text nor as an image contributes nothing.
            { type: 'content', content: { type: 'resource_link', name: 'a.pdf', uri: 'file:///tmp/a.pdf' } },
          ],
        },
        chunk('done'),
      ],
    }], {}, { attachments: true })
    try {
      const agent = await run(h, 'read it')
      const result = of(agent, 'tool/result')[0]
      const content = result?.type === 'tool/result' ? result.data.message.content[0]?.content : undefined
      expect(content?.map(block => block.type)).toEqual(['text', 'image'])
      const image = content?.find(block => block.type === 'image')
      expect(image?.type === 'image' && image.attachment).toMatchObject({ mediaType: 'image/png', bytes: 70 })
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('one the store cannot keep becomes a note saying why', async () => {
    const h = await harness([{
      updates: [
        png(),
        { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'not base64!', mimeType: 'image/png' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: PNG, mimeType: 'image/svg+xml', uri: 'file:///tmp/logo.svg' } },
        // An image missing its bytes is not an image block at all, and is passed over like any other non-text.
        { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png' } },
      ],
    }], {}, { attachments: true })
    try {
      const agent = await run(h, 'show me')
      const message = of(agent, 'assistant/message')[0]
      const content = message?.type === 'assistant/message' ? message.data.message.content : []
      // The notes share one text block, opened after the image that preceded them.
      expect(content.map(block => block.type)).toEqual(['image', 'text'])
      const notes = content[1]?.type === 'text' ? content[1].text : ''
      expect(notes.match(/\[image/g)).toHaveLength(2)
      expect(notes).toMatch(/^\[image \(image\/png\) not shown: /)
      expect(notes).not.toMatch(/^\[image \(image\/png\) not shown: the harness does not store/)
      expect(notes.endsWith('[image logo.svg (image/svg+xml) not shown: the harness does not store image/svg+xml]')).toBe(true)
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('are left out of a segment interrupted before its turn ended, which keeps its text', async () => {
    const h = await harness([{ updates: [chunk('partial'), png()], hang: true }], {}, { attachments: true })
    try {
      const agent = h.ctx.agentLoop.create(SessionId('acp'), {}, { cwd: h.dir })
      const idle = waitForIdle(h.ctx, agent)
      agent.followup(say('go'))
      await vi.waitFor(() => { expect(of(agent, 'assistant/chunk').length).toBeGreaterThan(0) })
      agent.cancel({ kind: 'user' })
      await idle
      expect(of(agent, 'assistant/message')[0]).toMatchObject({ data: { interrupted: true } })
      expect(replies(agent)).toEqual(['partial'])
      expect(of(agent, 'assistant/chunk').map(event => (event as { data: { chunk: { type: string; blockType?: string } } }).data.chunk.blockType))
        .toEqual(['text', undefined])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })
})

describe('the context accounting the agent reports', () => {
  it('is recorded once per distinct report, with whole numbers in range only', async () => {
    const h = await harness([{
      updates: [
        { sessionUpdate: 'usage_update', used: 12_000, size: 200_000 },
        { sessionUpdate: 'usage_update', used: 12_000, size: 200_000 },
        { sessionUpdate: 'usage_update', used: 13000.7, size: 200_000, cost: { amount: 0.5, currency: 'USD' } },
        { sessionUpdate: 'usage_update', used: 13000.7, size: 200_000, cost: { amount: 0.7, currency: 'USD' } },
        { sessionUpdate: 'usage_update', used: 13000.2, size: 200_000, cost: { amount: 0.7, currency: 'EUR' } },
        { sessionUpdate: 'usage_update', used: 13_000, size: 200_000, cost: { amount: 0.7, currency: 'EUR' } },
        { sessionUpdate: 'usage_update', used: -1 },
        { sessionUpdate: 'usage_update', size: 5 },
        { sessionUpdate: 'usage_update', used: 20_000, cost: null },
        { sessionUpdate: 'usage_update', used: 20_000, cost: { amount: -1, currency: 'USD' } },
        chunk('ok'),
      ],
    }])
    try {
      const agent = await run(h, 'go')
      // A report counts again once its count, its window, its amount, or its currency differs; the fourth repeats the third.
      expect(of(agent, 'agent/context').map(event => (event as { data: unknown }).data)).toEqual([
        { used: 12_000, size: 200_000 },
        { used: 13_000, size: 200_000, cost: { amount: 0.5, currency: 'USD' } },
        { used: 13_000, size: 200_000, cost: { amount: 0.7, currency: 'USD' } },
        { used: 13_000, size: 200_000, cost: { amount: 0.7, currency: 'EUR' } },
        { used: 20_000 },
      ])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('reaches the person through /acp', async () => {
    const h = await harness([{ updates: [{ sessionUpdate: 'usage_update', used: 45_000, size: 200_000, cost: { amount: 1.5, currency: 'USD' } }, chunk('ok')] }], {}, { commands: true })
    try {
      const agent = await run(h, 'go')
      expect((await command(h, agent, '/acp'))?.result).toEqual({
        kind: 'success',
        text: [
          'external agent: fake-external (ACP v1)',
          'external session: external-1 (new)',
          'context: 45,000 tokens in use (23% of 200,000), cost 1.5 USD',
        ].join('\n'),
      })
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })
})

describe('a plan the agent keeps as a document', () => {
  const document = (content: string, path?: string): Record<string, unknown> => ({
    sessionUpdate: 'plan_update',
    plan: { type: 'markdown', planId: 'p1', content, ...(path === undefined ? {} : { path }) },
  })

  it('is shown as a notice carrying its text, once per distinct text, and its removal leaves the todo list alone', async () => {
    const h = await harness([{
      updates: [
        document('# Plan\n\n- [ ] one'),
        document('# Plan\n\n- [ ] one'),
        { sessionUpdate: 'plan', entries: [{ content: 'a task' }] },
        document('# Plan\n\n- [x] one', '/plans/p1.md'),
        { sessionUpdate: 'plan_removed', planId: 'p1' },
        { sessionUpdate: 'plan_removed', planId: 'p2' },
        chunk('ok'),
      ],
    }])
    try {
      const agent = await run(h, 'go')
      expect(noticeTexts(agent)).toEqual([
        "The agent's plan:\n\n# Plan\n\n- [ ] one",
        "The agent's plan (/plans/p1.md):\n\n# Plan\n\n- [x] one",
      ])
      const lists = of(agent, 'todo/write').map(event => (event as { data: { todos: unknown } }).data.todos)
      expect(lists).toEqual([[{ content: 'a task', status: 'pending' }], []])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })
})

describe('the title the agent gives', () => {
  const titled = (title: string): Record<string, unknown> => ({ sessionUpdate: 'session_info_update', title })

  it('never replaces a name the person gave before the agent offered any', async () => {
    const h = await harness([{ updates: [chunk('one'), titled('Theirs')] }], {}, { title: true })
    try {
      const agent = h.ctx.agentLoop.create(SessionId('acp'), {}, { cwd: h.dir })
      h.ctx.sessionTitle.rename(agent.session, 'Mine')
      agent.followup(say('one'))
      await waitForIdle(h.ctx, agent)
      expect(h.ctx.get('sessionTitle')?.get(agent.session)?.title).toBe('Mine')
      expect(of(agent, 'acp/title')).toEqual([])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('is replaced by a later one after the session was reopened, until the person names the session', async () => {
    const turns = [
      { updates: [chunk('one'), titled('First')] },
      { updates: [chunk('two'), titled('Second')] },
      { updates: [chunk('three'), titled('Third')] },
    ]
    const mounts: Mounts = { persist: true, title: true }
    const first = await harness(turns, {}, mounts, { resumable: true })
    try {
      const agent = await run(first, 'one')
      expect(first.ctx.get('sessionTitle')?.get(agent.session)?.title).toBe('First')
      await first.ctx.sessions.flush(agent.session)
      await first.ctx.fiber.dispose()

      const second = await reopen(first, {}, mounts)
      try {
        const reopened = await restore(second)
        expect(second.ctx.get('sessionTitle')?.get(reopened.session)?.title).toBe('First')
        reopened.followup(say('two'))
        await waitForIdle(second.ctx, reopened)
        expect(second.ctx.get('sessionTitle')?.get(reopened.session)?.title).toBe('Second')
        // A rename of the person's own ends the agent's say over the title.
        second.ctx.sessionTitle.rename(reopened.session, 'Mine')
        reopened.followup(say('three'))
        await waitForIdle(second.ctx, reopened)
        expect(second.ctx.get('sessionTitle')?.get(reopened.session)?.title).toBe('Mine')
        expect(of(reopened, 'acp/title').map(event => (event as { data: { title: string } }).data.title)).toEqual(['First', 'Second'])
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      dispose(first)
    }
  })
})

describe('several agents in one preset', () => {
  const entry = (dir: string, name: string, args: string[]): acp.AgentConfig => ({
    command: process.execPath,
    args: [fakeAgent, ...args],
    env: { ACP_FAKE_SCENARIO: join(dir, `${name}.json`), ACP_FAKE_LOG: join(dir, `${name}.log`) },
  })
  const read = (file: string): { method: string; params?: unknown }[] =>
    existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string; params?: unknown }) : []

  it('runs the default, switches on request, reattaches to the one it returns to, and continues with the last one after a reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-acp-agents-'))
    writeFileSync(join(dir, 'first.json'), JSON.stringify({ turns: [{ updates: [chunk('from first, one')] }, { updates: [chunk('from first, two')] }, { updates: [chunk('from first, three')] }], resumable: true }))
    writeFileSync(join(dir, 'second.json'), JSON.stringify({ turns: [{ updates: [chunk('from second')] }, { updates: [chunk('from second, again')] }], resumable: true }))
    const config: Partial<acp.Config> = { agents: { first: entry(dir, 'first', []), second: entry(dir, 'second', ['--second']) } }
    const mounts: Mounts = { commands: true, bare: true, persist: true }
    const h = await harness([], config, mounts)
    try {
      const agent = await run(h, 'one')
      expect(replies(agent)).toEqual(['from first, one'])
      const status = await command(h, agent, '/acp')
      expect(status?.result).toEqual({
        kind: 'success',
        text: [
          'external agent: fake-external [first] (ACP v1)',
          'external session: external-1 (new)',
          'agents: *first, second',
        ].join('\n'),
      })
      expect((await command(h, agent, '/acp-agent first'))?.result).toEqual({ kind: 'success', text: 'this session already runs on first' })
      expect((await command(h, agent, '/acp-agent nobody'))?.result).toMatchObject({ kind: 'error' })
      agent.followup(say('two'))
      await waitForIdle(h.ctx, agent)
      // Without a switch the default keeps every turn.
      expect(replies(agent)).toEqual(['from first, one', 'from first, two'])

      expect((await command(h, agent, '/acp-agent second'))?.result).toMatchObject({ kind: 'success' })
      agent.followup(say('three'))
      await waitForIdle(h.ctx, agent)
      expect(replies(agent).at(-1)).toBe('from second')
      expect(read(join(dir, 'second.log')).map(item => item.method)).toEqual(['initialize', 'session/new', 'session/prompt'])
      expect(of(agent, 'acp/session').map(event => (event as { data: { args: string[] } }).data.args.length)).toEqual([1, 2])
      // The status now names the agent in effect.
      expect((await command(h, agent, '/acp'))?.result.text).toContain('external agent: fake-external [second] (ACP v1)')

      await h.ctx.sessions.flush(agent.session)
      await h.ctx.fiber.dispose()
      const second = await reopen(h, config, mounts)
      try {
        const reopened = await restore(second)
        // A reopened session continues with the agent it last talked to, and reattaches to that agent's session.
        reopened.followup(say('four'))
        await waitForIdle(second.ctx, reopened)
        expect(replies(reopened).at(-1)).toBe('from second, again')
        expect(read(join(dir, 'second.log')).map(item => item.method))
          .toEqual(['initialize', 'session/new', 'session/prompt', 'initialize', 'session/load', 'session/prompt'])
        // Back on the first agent, the session it opened earlier in this one is still there to continue.
        expect((await command(second, reopened, '/acp-agent first'))?.result).toMatchObject({ kind: 'success' })
        reopened.followup(say('five'))
        await waitForIdle(second.ctx, reopened)
        expect(replies(reopened).at(-1)).toBe('from first, three')
        expect(read(join(dir, 'first.log')).map(item => item.method))
          .toEqual(['initialize', 'session/new', 'session/prompt', 'session/prompt', 'initialize', 'session/load', 'session/prompt'])
        expect(read(join(dir, 'first.log')).at(-1)?.params).toMatchObject({ sessionId: 'external-1' })
      } finally {
        await second.ctx.fiber.dispose()
        rmSync(dir, { recursive: true, force: true })
      }
    } catch (error) {
      rmSync(dir, { recursive: true, force: true })
      throw error
    }
  })

  it('refuses a switch while a turn runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-acp-agents-'))
    writeFileSync(join(dir, 'first.json'), JSON.stringify({ turns: [{ updates: [chunk('streaming')], hang: true }] }))
    writeFileSync(join(dir, 'second.json'), JSON.stringify({ turns: [{ updates: [chunk('from second') ] }] }))
    const h = await harness([], { agents: { first: entry(dir, 'first', []), second: entry(dir, 'second', []) } }, { commands: true, bare: true })
    try {
      const agent = h.ctx.agentLoop.create(SessionId('acp'), {}, { cwd: h.dir })
      const idle = waitForIdle(h.ctx, agent)
      agent.followup(say('go'))
      await vi.waitFor(() => {
        expect(replies(agent)).toEqual([])
        expect(of(agent, 'assistant/chunk').length).toBeGreaterThan(0)
      })
      const refused = await command(h, agent, '/acp-agent second')
      expect(refused?.result).toMatchObject({ kind: 'error' })
      expect((refused?.result as { text: string }).text).toContain('running a turn')
      agent.cancel({ kind: 'user' })
      await idle
      expect((await command(h, agent, '/acp-agent'))?.result).toEqual({ kind: 'success', text: 'agents: *first, second' })
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('launches a named known agent under the catalog\'s command, with the defaults the row applies', async () => {
    const h = await harness([], { agents: { codex: { agent: 'codex-acp' } } }, { recordSpawns: true, bare: true })
    try {
      await run(h, 'go')
      expect(h.spawns.map(spawn => [spawn.argv, spawn.env])).toEqual([[['npx', '-y', '@agentclientprotocol/codex-acp'], {}]])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('is refused when it names both forms, a default it does not drive, or an agent it cannot launch', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    ctx.provide('subprocess', { spawn: () => { throw new Error('no process') } })
    const launch = { command: process.execPath }
    await expect(ctx.plugin(acp, { command: process.execPath, agents: { one: launch }, env: {}, credentialEnv: {}, permission: 'ask' }))
      .rejects.toThrow('agent-acp: name several agents under agents, or configure one at the top level, not both')
    await expect(ctx.plugin(acp, { agents: { one: launch }, default: 'two', env: {}, credentialEnv: {}, permission: 'ask' }))
      .rejects.toThrow('agent-acp: default names no entry of agents: "two" (named: one)')
    await expect(ctx.plugin(acp, { agents: { one: { agent: 'nobody' } }, env: {}, credentialEnv: {}, permission: 'ask' }))
      .rejects.toThrow('agent-acp: no known agent is named "nobody"')
    await expect(ctx.plugin(acp, { agents: { one: {} }, env: {}, credentialEnv: {}, permission: 'ask' }))
      .rejects.toThrow('agent-acp: config command is required')
    // A protocol this client cannot request reaches the row as configuration, so the type is stepped around on purpose.
    await expect(ctx.plugin(acp, { agents: { one: { command: process.execPath, protocol: 3 } }, env: {}, credentialEnv: {}, permission: 'ask' } as unknown as acp.Config))
      .rejects.toThrow('agent-acp: protocol must be 1 or 2, got 3')
    await ctx.fiber.dispose()
  })
})

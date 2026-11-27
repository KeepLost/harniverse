/**
 * The binding between a harness session and the external agent's session: it
 * is recorded when the session opens, reattached when the harness reopens the
 * session, and kept off a fork's own. A step nobody wrote for starts nothing.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { recordedBinding, type AcpSessionEventData } from '../src/session.ts'
import { chunk, dispose, fakeAgent, harness, reopen, restore, run, say, waitForIdle, type Harness } from './harness.ts'

const methods = (h: Harness): string[] => h.log().map(entry => String(entry.method))
/** The durable events of a session, without the inbox bookkeeping the runtime keeps in its log. */
const core = (agent: Agent): SessionEvent[] => agent.session.events.filter(event => !event.type.startsWith('agent/inbox/'))
const of = (agent: Agent, type: string): SessionEvent[] => core(agent).filter(event => event.type === type)
const bindings = (agent: Agent): AcpSessionEventData[] => of(agent, 'acp/session').map(event => (event as { data: AcpSessionEventData }).data)
const replies = (agent: Agent): string[] => of(agent, 'assistant/message').map((event) => {
  const message = (event as { data: { message: { content: { type: string; text?: string }[] } } }).data.message
  return message.content.map(block => block.text ?? '').join('')
})

describe('the binding to the external session', () => {
  it('is recorded beside the first step', async () => {
    const h = await harness([{ updates: [chunk('Hello')] }])
    try {
      const agent = await run(h, 'hi')
      expect(core(agent).map(event => event.type)).toEqual([
        'turn/start', 'step/start', 'user/message', 'acp/session', 'assistant/chunk', 'assistant/chunk',
        'assistant/message', 'step/end', 'turn/end',
      ])
      expect(bindings(agent)).toEqual([{
        sessionId: 'external-1',
        reached: 'new',
        command: process.execPath,
        args: [fakeAgent],
        protocol: 1,
        agentName: 'fake-external',
        cwd: h.dir,
      }])
      expect(recordedBinding(agent.session)).toMatchObject({ sessionId: 'external-1', reached: 'new' })
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('is reattached by a reopened harness session while the agent still holds it', async () => {
    const first = await harness([{ updates: [chunk('one')] }, { updates: [chunk('two')] }], {}, { persist: true }, { resumable: true })
    try {
      const agent = await run(first, 'one')
      await first.ctx.sessions.flush(agent.session)
      await first.ctx.fiber.dispose()
      const second = await reopen(first, {}, { persist: true })
      try {
        const reopened = await restore(second)
        expect(recordedBinding(reopened.session)).toMatchObject({ sessionId: 'external-1' })
        reopened.followup(say('two'))
        await waitForIdle(second.ctx, reopened)
        expect(methods(second).filter(method => method === 'session/new' || method === 'session/load'))
          .toEqual(['session/new', 'session/load'])
        expect(second.log().find(entry => entry.method === 'session/load')?.params)
          .toEqual({ sessionId: 'external-1', cwd: first.dir, mcpServers: [] })
        expect(replies(reopened)).toEqual(['one', 'two'])
        // A reattachment changes nothing in the log: the recorded binding still holds.
        expect(bindings(reopened)).toHaveLength(1)
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      dispose(first)
    }
  })

  it('gives way to a fresh external session, and says so, when the agent no longer holds it', async () => {
    const first = await harness([{ updates: [chunk('one')] }, { updates: [chunk('two')] }], {}, { persist: true }, { resumable: true })
    try {
      await run(first, 'one')
      await first.ctx.fiber.dispose()
      // The agent forgot its sessions while the harness was down.
      unlinkSync(join(first.dir, 'log.jsonl.sessions'))
      const second = await reopen(first, {}, { persist: true })
      try {
        const reopened = await restore(second)
        reopened.followup(say('two'))
        await waitForIdle(second.ctx, reopened)
        expect(methods(second).filter(method => method === 'session/new' || method === 'session/load'))
          .toEqual(['session/new', 'session/load', 'session/new'])
        expect(bindings(reopened).map(binding => [binding.sessionId, binding.reached])).toEqual([['external-1', 'new'], ['external-1', 'new']])
        const notices = of(reopened, 'user/message').filter((event) => {
          const source = (event as { data: { source: { form?: string } } }).data.source
          return source.form === 'notice'
        })
        expect(notices).toHaveLength(1)
        expect((notices[0] as { data: { content: { text: string }[] } }).data.content[0]?.text)
          .toBe('The external agent no longer holds session external-1; this turn opens a fresh one.')
        expect(replies(reopened)).toEqual(['one', 'two'])
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      dispose(first)
    }
  })

  it('is not reattached while resume is off', async () => {
    const first = await harness([{ updates: [chunk('one')] }, { updates: [chunk('two')] }], { resume: false }, { persist: true }, { resumable: true })
    try {
      const agent = await run(first, 'one')
      await first.ctx.sessions.flush(agent.session)
      await first.ctx.fiber.dispose()
      const second = await reopen(first, { resume: false }, { persist: true })
      try {
        const reopened = await restore(second)
        reopened.followup(say('two'))
        await waitForIdle(second.ctx, reopened)
        expect(methods(second)).not.toContain('session/load')
        expect(methods(second).filter(method => method === 'session/new')).toHaveLength(2)
        expect(bindings(reopened).map(binding => binding.reached)).toEqual(['new', 'new'])
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      dispose(first)
    }
  })

  it('is not reattached to a session another agent opened', async () => {
    const first = await harness([{ updates: [chunk('one')] }, { updates: [chunk('two')] }], {}, { persist: true }, { resumable: true })
    try {
      await run(first, 'one')
      await first.ctx.fiber.dispose()
      const second = await reopen(first, { args: [fakeAgent, '--another-agent'] }, { persist: true })
      try {
        const reopened = await restore(second)
        reopened.followup(say('two'))
        await waitForIdle(second.ctx, reopened)
        expect(methods(second)).not.toContain('session/load')
        expect(bindings(reopened).map(binding => [binding.args.length, binding.reached])).toEqual([[1, 'new'], [2, 'new']])
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      dispose(first)
    }
  })

  it('fails the turn when the agent refuses the reattachment for another reason', async () => {
    const first = await harness([{ updates: [chunk('one')] }], {}, { persist: true }, { resumable: true })
    try {
      await run(first, 'one')
      await first.ctx.fiber.dispose()
      const second = await reopen(first, {}, { persist: true })
      try {
        // The script the reopened harness follows now fails every load.
        const file = join(first.dir, 'scenario.json')
        writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')) as object, loadFails: true }))
        const reopened = await restore(second)
        reopened.followup(say('two'))
        await waitForIdle(second.ctx, reopened)
        const ending = core(reopened).at(-1)
        expect(ending?.type === 'turn/end' && ending.data.reason.kind === 'error' ? ending.data.reason.error.message : '').toContain('Internal error')
        expect(bindings(reopened)).toHaveLength(1)
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      dispose(first)
    }
  })

  it('stays with the parent when the harness session is forked', async () => {
    const h = await harness([{ updates: [chunk('one')] }])
    try {
      const agent = await run(h, 'one')
      const fork = h.ctx.sessions.fork(agent.session)
      expect(recordedBinding(agent.session)).toMatchObject({ sessionId: 'external-1' })
      // The fork replays its parent's events; none of them is its own.
      expect(fork.events.some(event => event.type === 'acp/session')).toBe(true)
      expect(recordedBinding(fork)).toBeUndefined()
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })
})

describe('a step nobody wrote for', () => {
  it('starts no external turn, and the next person message goes on its own', async () => {
    const h = await harness([{ updates: [chunk('ok')] }])
    try {
      const agent = h.ctx.agentLoop.create(SessionId('acp'), {}, { cwd: h.dir })
      const idle = waitForIdle(h.ctx, agent)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'from a plugin' }],
        source: { kind: 'plugin', plugin: 'test', form: 'system-injection' },
      }))
      await idle
      expect(core(agent).map(event => event.type)).toEqual(['turn/start', 'step/start', 'user/message', 'step/end', 'turn/end'])
      expect(methods(h)).toEqual([])
      agent.followup(say('from a person'))
      await waitForIdle(h.ctx, agent)
      expect(h.log().filter(entry => entry.method === 'session/prompt').map(entry => entry.params))
        .toEqual([{ sessionId: 'external-1', prompt: [{ type: 'text', text: 'from a person' }] }])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })
})

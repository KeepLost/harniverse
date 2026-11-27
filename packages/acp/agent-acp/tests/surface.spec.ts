/**
 * What the external agent reports and asks for, put in front of the person:
 * its plan, its title, its notices, its questions, its sign-in, and the
 * switches the `acp` commands operate. Plus how the row launches a known
 * agent and hands it a credential.
 */
import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import * as acp from '../src/index.ts'
import { planTodos } from '../src/plan.ts'
import { chunk, dispose, fakeAgent, harness, run, say, waitForIdle, type Harness } from './harness.ts'

const of = (agent: Agent, type: string): SessionEvent[] => agent.session.events.filter(event => event.type === type)
const core = (agent: Agent): SessionEvent[] => agent.session.events.filter(event => !event.type.startsWith('agent/inbox/'))
type Titled = { title: string }
const data = <T>(events: SessionEvent[]): T[] => events.map(event => (event as { data: T }).data)
const titlesOf = (events: SessionEvent[]): string[] => data<Titled>(events).map(event => event.title)
const methods = (h: Harness): string[] => h.log().map(entry => String(entry.method))
const noticeTexts = (agent: Agent): string[] => of(agent, 'user/message')
  .map(event => (event as { data: { source: { form?: string }; content: { text: string }[] } }).data)
  .filter(message => message.source.form === 'notice')
  .map(message => message.content.map(block => block.text).join(''))

const plan = { sessionUpdate: 'plan', entries: [{ content: ' Read the spec ', priority: 'high', status: 'completed' }, { content: 'Ship it', status: 'in_progress' }, { content: 'Ship it', status: 'pending' }, { content: '   ' }, { content: 'Later', status: 'cancelled' }] }
const planUpdate = { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'p1', entries: [{ content: 'Only this', status: 'pending' }] } }
const planRemoved = { sessionUpdate: 'plan_removed', planId: 'p1' }

describe('the plan the agent reports', () => {
  it('replaces the standing todo list with every report', async () => {
    const h = await harness([{ updates: [chunk('a'), plan, chunk('b'), planUpdate, chunk('c'), planRemoved] }], {}, { projections: true })
    try {
      const agent = await run(h, 'go')
      const types = core(agent).map(event => event.type)
      expect(types.slice(0, 8)).toEqual(['turn/start', 'step/start', 'user/message', 'acp/session', 'assistant/chunk', 'assistant/chunk', 'todo/write', 'assistant/chunk'])
      expect(data<{ todos: { content: string; status: string }[] }>(of(agent, 'todo/write'))).toEqual([
        { todos: [{ content: 'Read the spec', status: 'completed' }, { content: 'Ship it', status: 'in_progress' }] },
        { todos: [{ content: 'Only this', status: 'pending' }] },
        { todos: [] },
      ])
      // The list the todo tool owns is what the conversation shows.
      expect(h.ctx.sessionProjections.snapshot(agent.session).values.todos).toEqual([])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('folds into the list the todo tool would write', () => {
    expect(planTodos([{ content: ' A ' }, { content: 'A' }, { content: '' }, { content: 'B', status: 'cancelled' }, { content: 'C', status: 'brand_new' }]))
      .toEqual([{ content: 'A', status: 'pending' }])
  })
})

describe('the title and the notices the agent reports', () => {
  it('applies the agent\'s title until the person names the session themselves', async () => {
    const titled = (title: string): Record<string, unknown> => ({ sessionUpdate: 'session_info_update', title })
    const h = await harness(
      [{ updates: [chunk('a'), titled('Ship it')] }, { updates: [titled('Ship it again')] }, { updates: [titled('Theirs')] }],
      {},
      { title: true },
    )
    try {
      const agent = await run(h, 'one')
      const titles = h.ctx.get('sessionTitle')
      expect(titles?.get(agent.session)).toMatchObject({ title: 'Ship it', source: { kind: 'user' } })
      agent.followup(say('two'))
      await waitForIdle(h.ctx, agent)
      expect(titles?.get(agent.session)?.title).toBe('Ship it again')
      titles?.rename(agent.session, 'Mine')
      agent.followup(say('three'))
      await waitForIdle(h.ctx, agent)
      expect(titles?.get(agent.session)?.title).toBe('Mine')
      // The service's own fallback title came first, from the person's first message.
      expect(titlesOf(of(agent, 'session/title'))).toEqual(['one', 'Ship it', 'Ship it again', 'Mine'])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('leaves the title alone when a report carries none, and when it repeats the one in effect', async () => {
    const h = await harness(
      [{ updates: [chunk('a'), { sessionUpdate: 'session_info_update', title: 'Ship it' }, { sessionUpdate: 'session_info_update', title: 'Ship it' }] }, { updates: [{ sessionUpdate: 'session_info_update', updatedAt: '2026-11-27T00:00:00Z' }] }],
      {},
      { title: true },
    )
    try {
      const agent = await run(h, 'one')
      agent.followup(say('two'))
      await waitForIdle(h.ctx, agent)
      expect(h.ctx.get('sessionTitle')?.get(agent.session)?.title).toBe('Ship it')
      expect(titlesOf(of(agent, 'session/title'))).toEqual(['one', 'Ship it'])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('shows a notice in the transcript and starts no external turn for it', async () => {
    const h = await harness([{
      updates: [chunk('a'), { sessionUpdate: 'notice', title: 'Context compacted', description: 'Earlier turns were summarized', severity: 'info' }],
    }])
    try {
      const agent = await run(h, 'go')
      expect(noticeTexts(agent)).toEqual(['Context compacted: Earlier turns were summarized'])
      expect(methods(h).filter(method => method === 'session/prompt')).toHaveLength(1)
      // The notice lands in a step of its own after the answer, which spends no external turn.
      expect(core(agent).map(event => event.type)).toEqual([
        'turn/start', 'step/start', 'user/message', 'acp/session', 'assistant/chunk', 'assistant/chunk',
        'assistant/message', 'step/end', 'step/start', 'user/message', 'step/end', 'turn/end',
      ])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })
})

const question = {
  message: 'Where do we ship?',
  requestedSchema: {
    type: 'object',
    required: ['region'],
    properties: { region: { type: 'string', enum: ['eu', 'us'] }, replicas: { type: 'integer', title: 'How many' }, dry: { type: 'boolean' } },
  },
}

describe('a question the agent asks', () => {
  it('reaches the person through the user-questions seam, and the log records what was asked and answered', async () => {
    const h = await harness([{ updates: [chunk('a')], question }], {}, {
      questions: async () => ({
        answers: [{ id: 'region', selected: ['us'] }, { id: 'replicas', selected: [], custom: ' 3 ' }, { id: 'dry', selected: ['Yes'] }],
      }),
    })
    try {
      const agent = await run(h, 'go')
      expect(h.asked[0]?.questions).toEqual([
        { id: 'region', header: 'Where do we ship?', question: 'region', options: [{ label: 'eu' }, { label: 'us' }] },
        { id: 'replicas', header: 'Where do we ship?', question: 'How many' },
        { id: 'dry', header: 'Where do we ship?', question: 'dry', options: [{ label: 'Yes' }, { label: 'No' }] },
      ])
      expect(h.log().find(entry => entry.method === 'question-answer')?.answer)
        .toEqual({ action: 'accept', content: { region: 'us', replicas: 3, dry: true } })
      expect(data<{ turn: number; step: number; callId: string; name: string; arguments: string }>(of(agent, 'tool/call'))).toEqual([{
        turn: 1, step: 1, callId: 'question-1', name: 'acp_question', arguments: '{"region":"region","replicas":"How many","dry":"dry"}',
      }])
      expect(data<{ message: { content: unknown } }>(of(agent, 'tool/result'))[0]?.message.content).toEqual([{
        type: 'tool-result', toolCallId: 'question-1', isError: false, content: [{ type: 'text', text: '{"region":"us","replicas":3,"dry":true}' }],
      }])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('is declined when nobody can answer it, or a required field is left out', async () => {
    const quiet = await harness([{ updates: [chunk('a')], question }])
    try {
      await run(quiet, 'go')
      expect(quiet.log().find(entry => entry.method === 'question-answer')?.answer).toEqual({ action: 'decline' })
      expect(methods(quiet).filter(method => method === 'session/prompt')).toHaveLength(1)
    } finally {
      await quiet.ctx.fiber.dispose()
      dispose(quiet)
    }
    const partial = await harness([{ updates: [chunk('a')], question }], {}, {
      questions: async () => ({ answers: [{ id: 'replicas', selected: [], custom: 'many' }] }),
    })
    try {
      const agent = await run(partial, 'go')
      expect(partial.log().find(entry => entry.method === 'question-answer')?.answer).toEqual({ action: 'decline' })
      expect(of(agent, 'tool/call')).toEqual([])
    } finally {
      await partial.ctx.fiber.dispose()
      dispose(partial)
    }
  })
})

const options = {
  modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Manual' }, { id: 'plan', name: 'Plan' }] },
  configOptions: [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }] },
    { id: 'fast', name: 'Fast mode', type: 'boolean', currentValue: false },
  ],
}

describe('the acp commands', () => {
  const command = (h: Harness, agent: Agent, line: string) =>
    h.ctx.commands.execute(agent, line, [], new AbortController().signal)

  it('report the agent, its session, its modes, and its options', async () => {
    const h = await harness([{ updates: [chunk('ok')] }], {}, { commands: true }, { options })
    try {
      const agent = await run(h, 'go')
      expect((await command(h, agent, '/acp'))?.result).toEqual({
        kind: 'success',
        text: [
          'external agent: fake-external (ACP v1)',
          'external session: external-1 (new)',
          'mode: default — available: *default (Manual), plan (Plan)',
          'options:',
          '  model = opus (opus | sonnet)',
          '  fast = false (true | false)',
        ].join('\n'),
      })
      expect((await command(h, agent, '/acp-mode plan'))?.result).toEqual({ kind: 'success', text: 'plan — available: default (Manual), *plan (Plan)' })
      expect((await command(h, agent, '/acp-option model sonnet'))?.result).toEqual({ kind: 'success', text: 'model = sonnet (opus | sonnet)' })
      expect(h.log().filter(entry => String(entry.method).startsWith('session/set')).map(entry => [entry.method, entry.params])).toEqual([
        ['session/set_mode', { sessionId: 'external-1', modeId: 'plan' }],
        ['session/set_config_option', { sessionId: 'external-1', configId: 'model', value: 'sonnet' }],
      ])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('refuse what the agent does not offer, and a session that never opened', async () => {
    const h = await harness([{ updates: [chunk('ok')] }], {}, { commands: true }, { options })
    try {
      const agent = await run(h, 'go')
      expect((await command(h, agent, '/acp-option model turbo'))?.result).toEqual({ kind: 'error', text: '"turbo" is not a value "model" takes: model = opus (opus | sonnet)' })
      expect((await command(h, agent, '/acp-option nope x'))?.result).toEqual({ kind: 'error', text: 'no option "nope" (model, fast)' })
      expect((await command(h, agent, '/acp-mode turbo'))?.result).toMatchObject({ kind: 'error' })
      // A session that never ran a turn has no external session to switch.
      const fresh = h.ctx.agentLoop.create(SessionId('fresh'), {}, { cwd: h.dir })
      const freshStatus = (await command(h, fresh, '/acp'))?.result
      expect(freshStatus?.kind).toBe('success')
      expect(freshStatus?.text).toContain('external session: none yet — send a message first')
      expect((await command(h, fresh, '/acp-mode plan'))?.result).toEqual({ kind: 'error', text: 'the external agent has no session yet: send a message first' })
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })
})

describe('sign-in', () => {
  it('goes through the agent, by the method the row names, and shows the address it prints once', async () => {
    const h = await harness([{ updates: [chunk('ok')] }], { authMethod: 'agent-login' }, {}, { auth: { method: 'agent', url: 'https://accounts.test/login', twice: true } })
    try {
      const agent = await run(h, 'go')
      expect(methods(h)).toEqual(['initialize', 'session/new', 'authenticate', 'session/new', 'session/prompt'])
      expect(noticeTexts(agent)).toEqual(['Sign in to fake-external: open https://accounts.test/login in a browser.'])
      expect(agent.session.events.at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('asks the person to run the agent\'s own program when only a terminal sign-in is offered', async () => {
    const h = await harness([{ updates: [chunk('ok')] }], {}, {
      questions: async () => {
        // The person runs the program the card names; that is what completes the sign-in.
        writeFileSync(join(h.dir, 'log.jsonl.login-done'), 'ok')
        return { answers: [{ id: 'sign-in', selected: ['Continue'] }] }
      },
    }, { auth: { method: 'terminal', marker: 'beside-log' } })
    try {
      const agent = await run(h, 'go')
      expect(h.asked[0]?.questions).toEqual([{
        id: 'sign-in',
        header: 'Setup',
        question: `Run this in a terminal once, then continue: SETUP_MODE=1 ${process.execPath} ${fakeAgent} --login`,
        options: [{ label: 'Continue' }, { label: 'Cancel' }],
      }])
      // A terminal method is never sent to the agent; only the refused session is asked for again.
      expect(methods(h)).toEqual(['initialize', 'session/new', 'session/new', 'session/prompt'])
      expect(agent.session.events.at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('names no environment when the method has none', async () => {
    const h = await harness([{ updates: [chunk('ok')] }], {}, {
      questions: async () => {
        writeFileSync(join(h.dir, 'log.jsonl.login-done'), 'ok')
        return { answers: [{ id: 'sign-in', selected: ['Continue'] }] }
      },
    }, { auth: { method: 'terminal', env: false, marker: 'beside-log' } })
    try {
      await run(h, 'go')
      expect(h.asked[0]?.questions[0]?.question).toBe(`Run this in a terminal once, then continue: ${process.execPath} ${fakeAgent} --login`)
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('gives up on a terminal sign-in nobody answers', async () => {
    const h = await harness([], {}, {
      questions: async () => { throw new Error('no chat is reachable for the question') },
    }, { auth: { method: 'terminal', marker: 'beside-log' } })
    try {
      const agent = await run(h, 'go')
      const ending = agent.session.events.at(-1)
      const message = ending?.type === 'turn/end' && ending.data.reason.kind === 'error' ? ending.data.reason.error.message : ''
      expect(message).toContain('(auth): the terminal sign-in "Setup" was not completed')
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('fails the turn, naming the program to run, when nobody can ask', async () => {
    const h = await harness([], {}, {}, { auth: { method: 'terminal', marker: 'beside-log' } })
    try {
      const agent = await run(h, 'go')
      const ending = agent.session.events.at(-1)
      const message = ending?.type === 'turn/end' && ending.data.reason.kind === 'error' ? ending.data.reason.error.message : ''
      expect(message).toContain(`(auth): the agent only offers interactive terminal sign-in (setup); run \`${process.execPath} ${fakeAgent} --login\` once, outside the harness`)
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })
})

describe('what an answer may be', () => {
  const fields = {
    type: 'object',
    properties: { note: { type: 'string' }, count: { type: 'number' }, flag: { type: 'boolean' }, tags: { type: 'array', items: { enum: ['a', 'b'] } } },
  }
  const answerOf = (h: Harness): unknown => h.log().find(entry => entry.method === 'question-answer')?.answer

  it('reads free text, a number, no, and several picks, and leaves out an optional field nobody answered', async () => {
    const h = await harness([{ updates: [chunk('a')], question: { message: 'Details?', requestedSchema: fields } }], {}, {
      questions: async () => ({ answers: [{ id: 'note', selected: [], custom: ' free text ' }, { id: 'count', selected: [], custom: '2.5' }, { id: 'flag', selected: ['No'] }, { id: 'tags', selected: ['b', 'a'] }] }),
    })
    try {
      await run(h, 'go')
      expect(answerOf(h)).toEqual({ action: 'accept', content: { note: 'free text', count: 2.5, flag: false, tags: ['b', 'a'] } })
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('takes a picked label as the option it names, and free text as it was typed', async () => {
    const schema = { type: 'object', properties: { kind: { type: 'string', oneOf: [{ const: 'x', title: 'Ex', description: 'The x kind' }] } } }
    const picked = await harness([{ updates: [chunk('a')], question: { message: 'Which?', requestedSchema: schema } }], {}, {
      questions: async () => ({ answers: [{ id: 'kind', selected: ['Ex'] }] }),
    })
    try {
      await run(picked, 'go')
      expect(answerOf(picked)).toEqual({ action: 'accept', content: { kind: 'x' } })
    } finally {
      await picked.ctx.fiber.dispose()
      dispose(picked)
    }
    const typed = await harness([{ updates: [chunk('a')], question: { message: 'Which?', requestedSchema: schema } }], {}, {
      questions: async () => ({ answers: [{ id: 'kind', selected: [], custom: 'raw' }] }),
    })
    try {
      await run(typed, 'go')
      expect(answerOf(typed)).toEqual({ action: 'accept', content: { kind: 'raw' } })
    } finally {
      await typed.ctx.fiber.dispose()
      dispose(typed)
    }
  })

  it('declines a number that is not one, and a yes-or-no that is neither', async () => {
    const cases: { readonly answer: AskUserQuestionAnswer['answers'][number]; readonly declined: boolean }[] = [
      { answer: { id: 'count', selected: [], custom: 'abc' }, declined: true },
      { answer: { id: 'flag', selected: [], custom: 'maybe' }, declined: true },
      { answer: { id: 'note', selected: [], custom: 'text' }, declined: false },
    ]
    for (const { answer, declined } of cases) {
      const h = await harness([{ updates: [chunk('a')], question: { message: 'Details?', requestedSchema: fields } }], {}, {
        questions: async () => ({ answers: [answer] }),
      })
      try {
        await run(h, 'go')
        expect(answerOf(h)).toEqual(declined ? { action: 'decline' } : { action: 'accept', content: { note: 'text' } })
      } finally {
        await h.ctx.fiber.dispose()
        dispose(h)
      }
    }
  })

  it('is declined when the person cannot be asked at all', async () => {
    const h = await harness([{ updates: [chunk('a')], question }], {}, {
      questions: async () => { throw new Error('no chat is reachable for the question') },
    })
    try {
      await run(h, 'go')
      expect(answerOf(h)).toEqual({ action: 'decline' })
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })
})

describe('a credential the agent reads from its environment', () => {
  const envAt = (h: Harness): Record<string, string> => (h.log().find(entry => entry.method === 'initialize')?.env ?? {}) as Record<string, string>

  it('is resolved at every start and never written into the row', async () => {
    const h = await harness([{ updates: [chunk('ok')] }], { credentialEnv: { FAKE_TOKEN: 'FAKE_TOKEN' } }, { credentials: true })
    try {
      await run(h, 'go')
      expect(envAt(h)).toEqual({ FAKE_TOKEN: 'secret:FAKE_TOKEN' })
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('comes from the launching environment when no credentials service is mounted', async () => {
    const previous = process.env.FAKE_TOKEN
    process.env.FAKE_TOKEN = 'from-env'
    try {
      const h = await harness([{ updates: [chunk('ok')] }], { credentialEnv: { FAKE_TOKEN: 'FAKE_TOKEN' } })
      try {
        await run(h, 'go')
        expect(envAt(h)).toEqual({ FAKE_TOKEN: 'from-env' })
      } finally {
        await h.ctx.fiber.dispose()
        dispose(h)
      }
    } finally {
      if (previous === undefined) delete process.env.FAKE_TOKEN
      else process.env.FAKE_TOKEN = previous
    }
  })

  it('fails the turn by the reference\'s name when nobody stored it', async () => {
    const h = await harness([{ updates: [chunk('ok')] }], { credentialEnv: { FAKE_TOKEN: 'FAKE_TOKEN' } }, { emptyCredentials: true })
    try {
      const agent = await run(h, 'go')
      const ending = agent.session.events.at(-1)
      expect(ending?.type === 'turn/end' && ending.data.reason.kind === 'error' ? ending.data.reason.error : undefined).toMatchObject({
        code: 'ACP_CREDENTIAL',
        message: 'agent-acp: no value for credential "FAKE_TOKEN" (environment FAKE_TOKEN)',
      })
      expect(methods(h)).toEqual([])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })
})

describe('a known agent', () => {
  it('launches under the catalog\'s command when the row names it and sets no command', async () => {
    const h = await harness([], { agent: 'codex-acp' }, { recordSpawns: true, bare: true })
    try {
      await run(h, 'go')
      expect(h.spawns.map(spawn => spawn.argv)).toEqual([['npx', '-y', '@agentclientprotocol/codex-acp']])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('launches with no arguments when the row names neither an agent nor any', async () => {
    const h = await harness([], { args: null, env: {} }, { recordSpawns: true })
    try {
      await run(h, 'go')
      expect(h.spawns.map(spawn => spawn.argv)).toEqual([[process.execPath]])
    } finally {
      await h.ctx.fiber.dispose()
      dispose(h)
    }
  })

  it('is refused by name when the catalog does not know it, as is a row that names no command at all', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    ctx.provide('subprocess', { spawn: () => { throw new Error('no process') } })
    await expect(ctx.plugin(acp, { agent: 'nobody', env: {}, credentialEnv: {}, permission: 'ask' })).rejects.toThrow('agent-acp: no known agent is named "nobody" (known: claude-acp, codex-acp, gemini, antigravity-acp)')
    await expect(ctx.plugin(acp, { env: {}, credentialEnv: {}, permission: 'ask' })).rejects.toThrow('agent-acp: config command is required, or name a known agent with agent (claude-acp, codex-acp, gemini, antigravity-acp)')
    await ctx.fiber.dispose()
  })
})

/**
 * The `acp` commands over a scripted view: what they print, what they refuse,
 * and what they switch.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AcpError } from '@deepseek-ai/dsh-acp-client'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { AcpDriverView } from '../src/driver.ts'
import { registerCommands, type DriverLookup } from '../src/commands.ts'

const agent = { id: 'a' } as Agent

/** A view whose fields a test may reassign between commands. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }
interface Scripted extends Mutable<Omit<AcpDriverView, 'setMode' | 'setConfigOption'>> {
  readonly switches: unknown[]
  setMode(modeId: string): Promise<void>
  setConfigOption(configId: string, value: string | boolean): Promise<void>
}

/** A view whose fields a test sets and whose switches it records. */
function view(overrides: Partial<AcpDriverView> = {}): Scripted {
  const switches: unknown[] = []
  const state: Scripted = {
    agent: 'fake-external',
    protocol: 1,
    session: { id: 'external-1', reached: 'new' },
    modes: { current: 'default', available: [{ id: 'default', name: 'Manual' }, { id: 'plan', name: 'Plan' }] },
    configOptions: [
      { id: 'model', name: 'Model', type: 'select', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }] },
      { id: 'fast', name: 'Fast mode', type: 'boolean', currentValue: false },
    ],
    commands: [{ name: '/compact', description: 'Summarize' }],
    ...overrides,
    switches,
    setMode: async (modeId) => {
      switches.push(['mode', modeId])
      state.modes = { current: modeId, available: state.modes?.available ?? [] }
    },
    setConfigOption: async (configId, value) => {
      switches.push(['option', configId, value])
      state.configOptions = (state.configOptions ?? [])
        .map(candidate => candidate.id === configId ? { ...candidate, currentValue: value } : candidate)
    },
  }
  return state
}

function commands(lookup: DriverLookup) {
  const definitions = new Map<string, CommandDefinition>()
  const registry = { register: (definition: CommandDefinition) => { definitions.set(definition.name, definition) } }
  const ctx = { commands: registry } as unknown as Context
  registerCommands(ctx, lookup)
  const run = (line: string): Promise<{ kind: string; text?: string }> => {
    const space = line.indexOf(' ')
    const name = (space < 0 ? line : line.slice(0, space)).replace(/^\//, '')
    const definition = definitions.get(name)
    if (definition === undefined) throw new Error(`no command "${name}"`)
    return Promise.resolve(definition.handler({ agent, rawInput: space < 0 ? '' : line.slice(space + 1) } as CommandInvocation))
  }
  return { definitions, run }
}

describe('the acp commands', () => {
  it('are acp, acp-mode, and acp-option, and each refuses a session no driver runs', async () => {
    const { definitions, run } = commands(() => undefined)
    expect([...definitions.keys()].sort()).toEqual(['acp', 'acp-mode', 'acp-option'])
    for (const line of ['/acp', '/acp-mode plan', '/acp-option model opus']) {
      expect(await run(line)).toEqual({ kind: 'error', text: 'this session does not run on an external ACP agent' })
    }
  })

  it('acp: prints the agent, its session, its mode, every option, and its commands', async () => {
    const scripted = view()
    const { run } = commands(() => scripted)
    expect(await run('/acp')).toEqual({ kind: 'success', text: [
      'external agent: fake-external (ACP v1)',
      'external session: external-1 (new)',
      'mode: default — available: *default (Manual), plan (Plan)',
      'options:',
      '  model = opus (opus | sonnet)',
      '  fast = false (true | false)',
      'agent commands: /compact',
    ].join('\n') })
    expect(await run('/acp-mode plan ')).toEqual({ kind: 'success', text: 'plan — available: default (Manual), *plan (Plan)' })
    expect(await run('/acp-option fast off')).toEqual({ kind: 'success', text: 'fast = false (true | false)' })
    expect(scripted.switches).toEqual([['mode', 'plan'], ['option', 'fast', false]])
  })

  it('acp: says what a bare session has, and names a reattached session', async () => {
    const bare = view({ protocol: undefined, session: undefined, modes: undefined, configOptions: undefined, commands: undefined })
    const { run } = commands(() => bare)
    expect(await run('/acp')).toEqual({ kind: 'success', text: 'external agent: fake-external\nexternal session: none yet — send a message first' })
    bare.session = { id: 'external-9', reached: 'resumed' }
    bare.configOptions = [
      { id: 'pick', name: 'Pick', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A', group: 'First' }, { value: 'b', name: 'B' }] },
      { id: 'bare', name: 'Bare', type: 'select', currentValue: 'x' },
    ]
    bare.commands = []
    expect(await run('/acp')).toEqual({
      kind: 'success',
      text: 'external agent: fake-external\nexternal session: external-9 (reattached)\noptions:\n  pick = a (First: a | b)\n  bare = x',
    })
  })

  it('acp-mode: lists, marks the one in effect, switches, and reports a refused switch', async () => {
    const scripted = view({ modes: { current: 'plan', available: [] } })
    const { run } = commands(() => scripted)
    expect(await run('/acp-mode')).toEqual({ kind: 'success', text: 'plan — available: plan' })
    await run('/acp-mode   ')
    expect(scripted.switches).toEqual([])
    scripted.modes = { current: 'default', available: [{ id: 'default', name: 'Manual' }, { id: 'plan', name: 'Plan' }] }
    expect(await run('/acp-mode plan')).toEqual({ kind: 'success', text: 'plan — available: default (Manual), *plan (Plan)' })
    scripted.modes = undefined
    expect(await run('/acp-mode')).toEqual({ kind: 'error', text: 'the agent offers no session mode' })
    expect(await run('/acp-mode plan')).toEqual({ kind: 'success', text: 'plan — available: plan' })
    // A switch the agent does not confirm reads as asked.
    scripted.modes = undefined
    scripted.setMode = async (modeId) => { scripted.switches.push(['mode', modeId]) }
    expect(await run('/acp-mode plan')).toEqual({ kind: 'success', text: 'mode plan' })
    scripted.modes = { current: 'default', available: [] }
    scripted.setMode = async () => { throw new AcpError('protocol', 'no such mode', { code: -32602 }) }
    const refused = await run('/acp-mode turbo')
    expect(refused.kind).toBe('error')
    expect(refused.text).toContain('no such mode')
  })

  it('acp-option: lists, finds an option by id or by name, and sets a select by value or by name', async () => {
    const scripted = view()
    const { run } = commands(() => scripted)
    expect(await run('/acp-option')).toEqual({ kind: 'success', text: 'model = opus (opus | sonnet)\nfast = false (true | false)' })
    expect(await run('/acp-option Model')).toEqual({ kind: 'success', text: 'model = opus (opus | sonnet)' })
    await run('/acp-option MODEL Sonnet')
    expect(scripted.switches).toEqual([['option', 'model', 'sonnet']])
    // What it prints afterwards is the option as the agent now reports it.
    expect(await run('/acp-option model sonnet')).toEqual({ kind: 'success', text: 'model = sonnet (opus | sonnet)' })
    expect(await run('/acp-option fast YES')).toEqual({ kind: 'success', text: 'fast = true (true | false)' })
    expect(scripted.switches.at(-1)).toEqual(['option', 'fast', true])
  })

  it('acp-option: refuses what the agent does not offer', async () => {
    const scripted = view()
    const { run } = commands(() => scripted)
    expect(await run('/acp-option nope x')).toEqual({ kind: 'error', text: 'no option "nope" (model, fast)' })
    expect(await run('/acp-option model turbo')).toEqual({ kind: 'error', text: '"turbo" is not a value "model" takes: model = opus (opus | sonnet)' })
    expect(await run('/acp-option fast maybe')).toEqual({ kind: 'error', text: '"maybe" is not a value "fast" takes: fast = false (true | false)' })
    scripted.configOptions = []
    expect(await run('/acp-option')).toEqual({ kind: 'error', text: 'the agent offers no option' })
    scripted.configOptions = [{ id: 'bare', name: 'Bare', type: 'select', currentValue: 'x' }]
    expect(await run('/acp-option bare x')).toEqual({ kind: 'error', text: '"x" is not a value "bare" takes: bare = x' })
    scripted.configOptions = undefined
    expect(await run('/acp-option')).toEqual({ kind: 'error', text: 'the agent offers no option' })
    expect(await run('/acp-option model opus')).toEqual({ kind: 'error', text: 'no option "model" ()' })
    // An agent that drops the option it just set leaves the command the value it asked for.
    scripted.configOptions = [{ id: 'gone', name: 'Gone', type: 'boolean', currentValue: false }]
    scripted.setConfigOption = async () => { scripted.configOptions = [] }
    expect(await run('/acp-option gone true')).toEqual({ kind: 'success', text: 'gone = true (true | false)' })
    expect(scripted.switches).toEqual([])
  })
})

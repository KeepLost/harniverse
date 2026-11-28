/**
 * The `acp` commands: what the person reads about the external agent of a
 * session, and how they switch its mode, its options, and the agent itself.
 * @module @deepseek-ai/dsh-agent-acp/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands/types'
import type { AgentContextEventData } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { AcpConfigOption, AcpSessionModes } from '@deepseek-ai/dsh-acp-client'
import type { AcpDriverView } from './driver.ts'

/** The driver of a driven session, by the agent that runs it. */
export type DriverLookup = (agent: Agent) => AcpDriverView | undefined

const NO_DRIVER = 'this session does not run on an external ACP agent'

function text(lines: readonly string[]): CommandResult {
  return { kind: 'success', text: lines.join('\n') }
}

/** One mode per choice, with the one in effect marked. */
function describeModes(modes: AcpSessionModes): string {
  const choices = modes.available.length === 0
    ? modes.current
    : modes.available.map(mode => `${mode.id === modes.current ? '*' : ''}${mode.id} (${mode.name})`).join(', ')
  return `${modes.current} — available: ${choices}`
}

/** An option as one line: its name, the value in effect, and what else it takes. */
function describeOption(option: AcpConfigOption): string {
  const head = `${option.id} = ${String(option.currentValue)}`
  if (option.type === 'boolean') return `${head} (true | false)`
  const names = (option.options ?? []).map(choice => (choice.group === undefined ? '' : `${choice.group}: `) + choice.value)
  return names.length === 0 ? head : `${head} (${names.join(' | ')})`
}

/** A count with thousands separators, whatever the locale. */
function count(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** One context report: the fill of the window, and the cost so far. */
function describeContext(context: AgentContextEventData): string {
  const fill = context.size === undefined
    ? ''
    : ` (${Math.round((context.used / context.size) * 100)}% of ${count(context.size)})`
  const cost = context.cost === undefined ? '' : `, cost ${context.cost.amount} ${context.cost.currency}`
  return `context: ${count(context.used)} tokens in use${fill}${cost}`
}

/** The agents a person can pick, with the one in effect marked. */
function describeAgents(view: AcpDriverView): string {
  return view.agents.map(name => (name === view.current ? `*${name}` : name)).join(', ')
}

/** The whole status of a driven session. */
function status(view: AcpDriverView): string {
  const lines = [
    `external agent: ${view.agent}${view.agents.length === 0 ? '' : ` [${view.current}]`}${view.protocol === undefined ? '' : ` (ACP v${view.protocol})`}`,
    view.session === undefined
      ? 'external session: none yet — send a message first'
      : `external session: ${view.session.id} (${view.session.reached === 'resumed' ? 'reattached' : 'new'})`,
  ]
  if (view.agents.length > 1) lines.push(`agents: ${describeAgents(view)}`)
  if (view.modes !== undefined) lines.push(`mode: ${describeModes(view.modes)}`)
  if ((view.configOptions ?? []).length > 0) lines.push('options:')
  for (const option of view.configOptions ?? []) lines.push(`  ${describeOption(option)}`)
  if ((view.commands ?? []).length > 0) {
    lines.push(`agent commands: ${view.commands?.map(command => command.name).join(', ')}`)
  }
  if (view.context !== undefined) lines.push(describeContext(view.context))
  return lines.join('\n')
}

/** Whether a typed value names a boolean option's value. */
function booleanValue(value: string): boolean | undefined {
  const word = value.toLowerCase()
  if (word === 'true' || word === 'on' || word === 'yes') return true
  return word === 'false' || word === 'off' || word === 'no' ? false : undefined
}

/** The option a person named, by its id or, failing that, by its name. */
function optionNamed(view: AcpDriverView, id: string): AcpConfigOption | undefined {
  const options = view.configOptions ?? []
  return options.find(option => option.id === id) ?? options.find(option => option.name.toLowerCase() === id.toLowerCase())
}

/** The value a person typed for a select option: its id, or the name it is shown under. */
function selectValue(option: AcpConfigOption, value: string): string | undefined {
  const word = value.toLowerCase()
  const choice = (option.options ?? []).find(candidate => candidate.value.toLowerCase() === word)
    ?? (option.options ?? []).find(candidate => candidate.name.toLowerCase() === word)
  return choice?.value
}

/**
 * Register the commands on the plugin's context. They answer only for a
 * session the plugin drives.
 * @param ctx - a context that provides the command registry.
 * @param lookup - the driver of a driven session.
 */
export function registerCommands(ctx: Context, lookup: DriverLookup): void {
  /** What a command found: lines to show, or one line naming what went wrong. */
  type Found = string | { readonly error: string }
  const run = async (agent: Agent, body: (view: AcpDriverView) => Found | Promise<Found>): Promise<CommandResult> => {
    const view = lookup(agent)
    if (view === undefined) return { kind: 'error', text: NO_DRIVER }
    try {
      const found = await body(view)
      return typeof found === 'string' ? text([found]) : { kind: 'error', text: found.error }
    } catch (error: unknown) {
      return { kind: 'error', text: errorChain(error) }
    }
  }
  const commands: readonly CommandDefinition[] = [
    {
      name: 'acp',
      description: 'Show the external agent of this session, its session, modes, and options',
      handler: ({ agent }) => run(agent, status),
    },
    {
      name: 'acp-mode',
      description: 'Show the external agent\'s session modes, or switch one',
      input: { hint: '<mode>' },
      handler: ({ agent, rawInput }) => run(agent, async (view) => {
        const id = rawInput.trim()
        if (id === '') {
          if (view.modes === undefined) return { error: 'the agent offers no session mode' }
          return describeModes(view.modes)
        }
        await view.setMode(id)
        // The agent confirms a mode through its next report; the switch itself reads as asked.
        return view.modes === undefined ? `mode ${id}` : describeModes({ ...view.modes, current: id })
      }),
    },
    {
      name: 'acp-agent',
      description: 'Show the external agents this session can run on, or choose the one the next messages run on',
      input: { hint: '<name>' },
      handler: ({ agent, rawInput }) => run(agent, async (view) => {
        if (view.agents.length === 0) {
          return { error: 'this preset drives one external agent: name several under agents to choose one' }
        }
        const name = rawInput.trim()
        if (name === '') return `agents: ${describeAgents(view)}`
        if (!(await view.select(name))) return `this session already runs on ${name}`
        return `the next message runs on ${name}: it continues the external session ${name} opened in this session while the agent still holds one, and opens a fresh one otherwise`
      }),
    },
    {
      name: 'acp-option',
      description: 'Show one option of the external agent, or set it',
      input: { hint: '<option> [value]' },
      handler: ({ agent, rawInput }) => run(agent, async (view) => {
        const [id = '', ...rest] = rawInput.trim().split(/\s+/)
        if (id === '') return (view.configOptions ?? []).map(describeOption).join('\n') || { error: 'the agent offers no option' }
        const option = optionNamed(view, id)
        if (option === undefined) return { error: `no option "${id}" (${(view.configOptions ?? []).map(candidate => candidate.id).join(', ')})` }
        const typed = rest.join(' ')
        if (typed === '') return describeOption(option)
        const value = option.type === 'boolean' ? booleanValue(typed) : selectValue(option, typed)
        if (value === undefined) return { error: `"${typed}" is not a value "${option.id}" takes: ${describeOption(option)}` }
        await view.setConfigOption(option.id, value)
        // What it prints afterwards is the option as the agent now reports it.
        return describeOption({ ...optionNamed(view, option.id) ?? option, currentValue: value })
      }),
    },
  ]
  for (const command of commands) ctx.commands.register(command)
}

/**
 * ACP mode: an agent whose turns are turns of an external Agent Client Protocol
 * agent. The row registers the step driver for every agent whose scope
 * descends from its own, so a preset names ACP mode by composing this row and
 * nothing else. This plugin uses named exports only; a default would hide its
 * loader metadata (see `docs/postmortem/0001-acp-default-export-drops-inject.md`).
 * @module @deepseek-ai/dsh-agent-acp
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { KNOWN_AGENTS, knownAgent } from '@deepseek-ai/dsh-acp-client'
import type {
  AcpProtocol,
  AcpQuestionAnswer,
  AcpQuestionAnswerer,
  AcpQuestionField,
  AcpQuestionValue,
  AcpSignInHooks,
} from '@deepseek-ai/dsh-acp-client'
import type { AgentHost } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import type { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import { registerCommands } from './commands.ts'
import { AcpStepDriver, permissionAnswerer, type AcpLaunch, type AcpPermissionMode, type LaunchDefinition } from './driver.ts'
import { installPlanProjection } from './plan.ts'

export type { AcpDriverOptions, AcpDriverView, AcpLaunch, AcpPermissionMode, LaunchDefinition } from './driver.ts'
export type { AcpSessionEventData, AcpTitleEventData } from './session.ts'

export const name = 'agent-acp'
export const inject = ['agents', 'subprocess']

/** The known agents `agent` may name. */
const KNOWN_IDS = KNOWN_AGENTS.map(agent => agent.id).join(', ')

/** The name of the one agent a row without `agents` drives; it is never shown. */
const SINGLE = 'default'

/** The launch fields of one external agent. */
export interface AgentConfig {
  /**
   * A known external agent: one of `claude-acp`, `codex-acp`, `gemini`, or
   * `antigravity-acp`. It fills in `command` and `args` the entry leaves unset.
   */
  agent?: string
  /** Executable that serves the external ACP agent over stdio. Required unless `agent` names a known one. */
  command?: string
  /**
   * Arguments passed to {@link AgentConfig.command}; a known agent's own when
   * `agent` names one and this is left unset or `null`.
   */
  args?: string[] | null
  /** Environment variables added on top of the subprocess seam's scrubbed parent environment. */
  env?: Record<string, string>
  /**
   * Environment variable → credential reference. Each reference is resolved
   * through the credentials service at every start and handed to the agent as
   * that variable, so no key is written into this file.
   */
  credentialEnv?: Record<string, string>
  /** ACP version requested at the handshake: `1`, the stable protocol, or `2`, the Preview protocol with a v1 fallback. */
  protocol?: AcpProtocol
  /**
   * Id of the sign-in method this entry completes when the agent demands
   * sign-in. Absent, the first agent-driven method the agent advertises is
   * completed, and the first terminal one when it advertises none.
   */
  authMethod?: string
}

/** Config: how to start and sign in to the external agent, and how to answer its requests. */
export interface Config extends AgentConfig {
  /**
   * Named external agents this row can drive, each with the launch fields the
   * top level carries for one agent. A session runs `default` until the person
   * picks another with `/acp-agent`, and a reopened session continues with the
   * one it last talked to. Not together with a top-level `agent` or `command`.
   */
  agents?: Record<string, AgentConfig>
  /** The entry of `agents` a session runs until the person picks another; the first entry when omitted. */
  default?: string
  /**
   * Working directory of the external process and of its session. Must be
   * non-empty; a relative path resolves against the harness launch directory
   * at load. When omitted, each session's own workspace is used, and starting
   * one from a session that has no workspace fails.
   */
  cwd?: string
  /**
   * Whether a reopened harness session reattaches to the external session
   * its own log records. `false` opens a fresh external session at every
   * harness start; the harness transcript stays either way.
   */
  resume?: boolean
  /**
   * How to answer the external agent's permission requests: `ask` (default)
   * routes each one through the approval seam and fails closed without an
   * answerer; `allow` takes the agent's first allow option; `reject` declines
   * every request.
   */
  permission: AcpPermissionMode
}

/** The launch fields of one agent under `agents`, with the defaults the top level applies to its own. */
const agentFields = {
  agent: z.string(),
  command: z.string(),
  // A bare array would materialize as empty, which cannot be told from an omitted one.
  args: z.union([z.array(z.string()), z.const(null)]),
  env: z.dict(z.string()).default({}),
  credentialEnv: z.dict(z.string()).default({}),
  protocol: z.number().default(1),
  authMethod: z.string(),
}

export const Config: z<Config> = z.object({
  // The seven launch keys repeat `agentFields` plainly: the config catalog reads literal keys only.
  agent: z.string(),
  command: z.string(),
  args: z.union([z.array(z.string()), z.const(null)]),
  env: z.dict(z.string()).default({}),
  credentialEnv: z.dict(z.string()).default({}),
  protocol: z.number().default(1),
  authMethod: z.string(),
  agents: z.dict(z.object(agentFields)),
  default: z.string(),
  cwd: z.string(),
  resume: z.boolean().default(true),
  permission: z.union(['ask', 'allow', 'reject'] as const).default('ask'),
}) as z<Config>

/** One agent's launch fields once schemastery applied the defaults. */
type ResolvedAgent = AgentConfig & Required<Pick<AgentConfig, 'env' | 'credentialEnv' | 'protocol'>>

/** What resolving one agent's launch needs of its fields. */
type LaunchFields = AgentConfig & Required<Pick<AgentConfig, 'env' | 'protocol'>>

/** The shape after schemastery applied the defaults; an omitted `agents` is an empty one. */
type ResolvedConfig = Required<Pick<Config, 'env' | 'credentialEnv' | 'protocol' | 'permission' | 'resume'>>
  & Pick<Config, 'agent' | 'command' | 'cwd' | 'authMethod' | 'default'> & {
    args: string[] | null | undefined
    agents: Record<string, ResolvedAgent>
  }

/** One agent the row resolved, with the credential references its start resolves. */
interface ResolvedLaunch extends AcpLaunch {
  /** Environment variable → credential reference. */
  readonly credentials: Record<string, string>
}

/**
 * Reject a protocol version this client cannot request.
 * @param protocol - the configured value.
 */
function assertProtocol(protocol: number): void {
  if (protocol !== 1 && protocol !== 2) {
    throw new Error(`agent-acp: protocol must be 1 or 2, got ${protocol}`)
  }
}

/**
 * Resolve the configured working directory at load: a relative path belongs to
 * the harness launch directory, and an empty one is a misconfiguration.
 * @param cwd - the configured value, when set.
 * @returns the absolute working directory, or `undefined` to use each session's own.
 */
function resolveCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  if (cwd === '') {
    throw new Error('agent-acp: config cwd must not be empty — omit the key to use each session\'s workspace')
  }
  return resolve(cwd)
}

/**
 * Resolve how one external agent is launched: a known agent fills in what the
 * entry leaves unset.
 * @param config - the launch fields of one entry, defaults applied.
 * @returns the agent definition every driven session starts for it.
 */
function launchOf(config: LaunchFields): LaunchDefinition {
  const known = config.agent === undefined ? undefined : knownAgent(config.agent)
  if (config.agent !== undefined && known === undefined) {
    throw new Error(`agent-acp: no known agent is named "${config.agent}" (known: ${KNOWN_IDS})`)
  }
  const command = config.command ?? known?.command
  if (command === undefined || command === '') {
    throw new Error(`agent-acp: config command is required, or name a known agent with agent (${KNOWN_IDS})`)
  }
  assertProtocol(config.protocol)
  const { authMethod, protocol, env } = config
  return {
    command,
    args: config.args ?? known?.args ?? [],
    env,
    protocol,
    ...authMethod === undefined ? {} : { authMethod },
  }
}

/**
 * Resolve every agent the row can drive: the entries named under `agents`, or
 * the one the top level describes. Naming both is a misconfiguration, as is a
 * `default` that names no entry. The agent a session runs until the person
 * picks another is `default`, else the first entry.
 * @param config - the resolved configuration.
 * @returns one launch per agent, in configuration order, and the name of the default.
 */
function launchesOf(config: ResolvedConfig): { readonly launches: readonly ResolvedLaunch[]; readonly defaultAgent: string } {
  // schemastery materializes an omitted dict as an empty one, so an empty `agents` is the single form.
  const entries = Object.entries(config.agents)
  if (entries.length === 0) {
    const { agent, command, args, authMethod } = config
    return {
      launches: [{
        name: SINGLE,
        definition: launchOf({
          env: config.env,
          protocol: config.protocol,
          ...agent === undefined ? {} : { agent },
          ...command === undefined ? {} : { command },
          ...args === undefined ? {} : { args },
          ...authMethod === undefined ? {} : { authMethod },
        }),
        credentials: config.credentialEnv,
      }],
      defaultAgent: SINGLE,
    }
  }
  if (config.agent !== undefined || config.command !== undefined) {
    throw new Error('agent-acp: name several agents under agents, or configure one at the top level, not both')
  }
  const launches: ResolvedLaunch[] = []
  let first = ''
  for (const [name, entry] of entries) {
    if (first === '') first = name
    launches.push({ name, definition: launchOf(entry), credentials: entry.credentialEnv })
  }
  if (config.default !== undefined && config.agents[config.default] === undefined) {
    throw new Error(`agent-acp: default names no entry of agents: "${config.default}" (named: ${launches.map(launch => launch.name).join(', ')})`)
  }
  return { launches, defaultAgent: config.default ?? first }
}

/**
 * Resolve the credential-backed environment of one start. A reference nobody
 * stored fails that start by name; the value itself never reaches a message.
 * @param ctx - the plugin's context.
 * @param refs - environment variable → credential reference.
 * @returns the resolver, or `undefined` when no variable is bound.
 */
function credentialResolver(ctx: Context, refs: Record<string, string>): (() => Promise<Record<string, string>>) | undefined {
  const entries = Object.entries(refs)
  if (entries.length === 0) return undefined
  return async () => {
    const credentials = ctx.get('credentials')
    const env: Record<string, string> = {}
    for (const [name, ref] of entries) {
      const value = credentials === undefined
        ? launchEnvironmentOf(ctx).get(ref)?.value
        : (await credentials.resolve(credentialRef(ref)))?.value
      if (value === undefined || value === '') {
        throw new LlmError(`agent-acp: no value for credential "${ref}" (environment ${name})`, 'ACP_CREDENTIAL')
      }
      env[name] = value
    }
    return env
  }
}

/** The answer an ACP question gets when the person gave nothing usable. */
const DECLINE: AcpQuestionAnswer = { action: 'decline' }

/** Whether a field ended without a value. */
function isEmpty(value: AcpQuestionValue | undefined): value is undefined | '' | readonly [] {
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
}

/**
 * Read the person's answer field by field. A required field without a value,
 * or one whose answer does not fit, declines the whole question.
 * @param fields - what the agent asked.
 * @param answer - what the person answered.
 * @returns the answer sent to the agent.
 */
function answered(fields: readonly AcpQuestionField[], answer: AskUserQuestionAnswer): AcpQuestionAnswer {
  const content: Record<string, AcpQuestionValue> = {}
  for (const field of fields) {
    const item = answer.answers.find(candidate => candidate.id === field.name)
    const picked = item?.selected ?? []
    const custom = item?.custom?.trim() ?? ''
    let value: AcpQuestionValue | undefined
    if (field.type === 'text') {
      value = custom !== '' ? custom : picked[0]
    } else if (field.type === 'number') {
      const raw = custom !== '' ? custom : picked[0]
      if (raw !== undefined) {
        const number = Number(raw)
        if (!Number.isFinite(number)) return DECLINE
        value = number
      }
    } else if (field.type === 'boolean') {
      const word = (custom !== '' ? custom : picked[0] ?? '').toLowerCase()
      if (word !== '') {
        if (word === 'yes' || word === 'true') value = true
        else if (word === 'no' || word === 'false') value = false
        else return DECLINE
      }
    } else {
      // A picked label names an option; free text passes through as it was typed.
      const labels = [...picked, ...custom === '' ? [] : [custom]]
      const values = labels.map(label => field.options.find(option => option.label === label)?.value ?? label)
      value = field.multi ? values : values[0]
    }
    if (isEmpty(value)) {
      if (field.required) return DECLINE
      continue
    }
    content[field.name] = value
  }
  return { action: 'accept', content }
}


/**
 * Ask the person what the agent wants to know, through the user-questions
 * seam. Without that seam, or when nobody can answer, the question is declined.
 * @param host - the agent whose session the question belongs to.
 * @returns the answerer the connection uses.
 */
function questionAnswerer(questions: UserQuestionService, host: AgentHost): AcpQuestionAnswerer {
  return async (request) => {
    try {
      const single = request.fields.length === 1 ? request.fields[0] : undefined
      const answer = await questions.ask({
        agent: host.agent,
        signal: request.signal,
        questions: request.fields.map((field) => {
          const options = field.type === 'choice'
            ? field.options.map(choice => ({
              label: choice.label,
              ...choice.description === undefined ? {} : { description: choice.description },
            }))
            : field.type === 'boolean' ? [{ label: 'Yes' }, { label: 'No' }] : undefined
          // One field is the agent's question itself; several are grouped under it.
          return {
            id: field.name,
            question: single === undefined ? field.label : request.message,
            ...single === undefined ? { header: request.message } : {},
            ...options === undefined ? {} : { options },
            ...field.type === 'choice' && field.multi ? { multiSelect: true } : {},
          }
        }),
      })
      return answered(request.fields, answer)
    } catch {
      // Nobody could answer: a question with no provider, a caller that is not the live agent, or a withdrawn request.
      return DECLINE
    }
  }
}

/**
 * Ask the person to complete a terminal sign-in and to say when it is done.
 * @param host - the agent whose turn waits for the sign-in.
 * @returns the hook the connection uses.
 */
function terminalSignIn(questions: UserQuestionService, host: AgentHost): NonNullable<AcpSignInHooks['terminal']> {
  return async (signIn, signal) => {
    const env = Object.entries(signIn.method.env ?? {}).map(([name, value]) => `${name}=${value}`)
    try {
      const answer = await questions.ask({
        agent: host.agent,
        // A command never reaches a sign-in: it has no session yet to be refused, so the signal is a turn's.
        /* v8 ignore next -- the hook is reached only from a turn, which always carries its signal */
        ...signal === undefined ? {} : { signal },
        questions: [{
          id: 'sign-in',
          header: signIn.method.name,
          question: `Run this in a terminal once, then continue: ${[...env, signIn.command, ...signIn.args].join(' ')}`,
          options: [{ label: 'Continue' }, { label: 'Cancel' }],
        }],
      })
      return answer.answers[0]?.selected[0] === 'Continue'
    } catch {
      // Nobody could answer; the sign-in is not completed.
      return false
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  const { launches, defaultAgent } = launchesOf(resolved)
  const agents: readonly AcpLaunch[] = launches.map((launch) => {
    const resolveEnv = credentialResolver(ctx, launch.credentials)
    const { credentials: _bound, definition } = launch
    return resolveEnv === undefined ? { name: launch.name, definition } : { name: launch.name, definition, resolveEnv }
  })
  const subprocess = ctx.subprocess
  const cwd = resolveCwd(resolved.cwd)
  installPlanProjection(ctx)
  const drivers = new Map<SessionId, AcpStepDriver>()
  ctx.agents.registerDriver((host) => {
    // Without the seam nobody can answer: a question is declined and a terminal
    // sign-in names, in the turn's failure, the program to run outside.
    const questions = host.ownerCtx.get('userQuestions')
    const driver = new AcpStepDriver(host, {
      agents,
      defaultAgent,
      cwd,
      spawn: spec => subprocess.spawn(spec),
      permission: permissionAnswerer(resolved.permission, host),
      ...questions === undefined ? {} : { questions: questionAnswerer(questions, host), terminalSignIn: terminalSignIn(questions, host) },
      resume: resolved.resume,
    })
    drivers.set(host.id, driver)
    host.ctx.effect(() => () => {
      // A driver replaced for the same session unwinds after its replacement registered.
      /* v8 ignore next -- a replacement outliving the replaced driver is a disposal-order race no test can stage */
      if (drivers.get(host.id) === driver) drivers.delete(host.id)
    }, 'agent-acp.driver()')
    return driver
  })
  ctx.inject(['commands'], (commandsCtx) => {
    registerCommands(commandsCtx, agent => drivers.get(agent.id)?.view())
  })
}

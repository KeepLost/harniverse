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
  AcpAgentDefinition,
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
import { AcpStepDriver, permissionAnswerer, type AcpPermissionMode } from './driver.ts'
import { installPlanProjection } from './plan.ts'

export type { AcpDriverOptions, AcpDriverView, AcpPermissionMode } from './driver.ts'
export type { AcpSessionEventData } from './session.ts'

export const name = 'agent-acp'
export const inject = ['agents', 'subprocess']

/** The known agents `agent` may name. */
const KNOWN_IDS = KNOWN_AGENTS.map(agent => agent.id).join(', ')

/** Config: how to start and sign in to the external agent, and how to answer its requests. */
export interface Config {
  /**
   * A known external agent: one of `claude-acp`, `codex-acp`, `gemini`, or
   * `antigravity-acp`. It fills in `command` and `args` the row leaves unset.
   */
  agent?: string
  /** Executable that serves the external ACP agent over stdio. Required unless `agent` names a known one. */
  command?: string
  /**
   * Arguments passed to {@link command}; a known agent's own when `agent`
   * names one and this is left unset or `null`.
   */
  args?: string[] | null
  /** Environment variables added on top of the subprocess seam's scrubbed parent environment. */
  env: Record<string, string>
  /**
   * Environment variable → credential reference. Each reference is resolved
   * through the credentials service at every start and handed to the agent as
   * that variable, so no key is written into this file.
   */
  credentialEnv: Record<string, string>
  /**
   * Working directory of the external process and of its session. Must be
   * non-empty; a relative path resolves against the harness launch directory
   * at load. When omitted, each session's own workspace is used, and starting
   * one from a session that has no workspace fails.
   */
  cwd?: string
  /** ACP version requested at the handshake: `1`, the stable protocol, or `2`, the Preview protocol with a v1 fallback. */
  protocol?: AcpProtocol
  /**
   * Id of the sign-in method this row completes when the agent demands
   * sign-in. Absent, the first agent-driven method the agent advertises is
   * completed, and the first terminal one when it advertises none.
   */
  authMethod?: string
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

export const Config: z<Config> = z.object({
  agent: z.string(),
  command: z.string(),
  // A bare array would materialize as empty, which cannot be told from an omitted one.
  args: z.union([z.array(z.string()), z.const(null)]),
  env: z.dict(z.string()).default({}),
  credentialEnv: z.dict(z.string()).default({}),
  cwd: z.string(),
  protocol: z.number().default(1),
  authMethod: z.string(),
  resume: z.boolean().default(true),
  permission: z.union(['ask', 'allow', 'reject'] as const).default('ask'),
}) as z<Config>

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Pick<Config, 'env' | 'credentialEnv' | 'protocol' | 'permission' | 'resume'>>
  & Pick<Config, 'agent' | 'command' | 'cwd' | 'authMethod'> & { args: string[] | null | undefined }

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
 * Resolve how the external agent is launched: a known agent fills in what the
 * row leaves unset.
 * @param config - the resolved configuration.
 * @returns the agent definition every driven session starts.
 */
function launchOf(config: ResolvedConfig): AcpAgentDefinition {
  const known = config.agent === undefined ? undefined : knownAgent(config.agent)
  if (config.agent !== undefined && known === undefined) {
    throw new Error(`agent-acp: no known agent is named "${config.agent}" (known: ${KNOWN_IDS})`)
  }
  const command = config.command ?? known?.command
  if (command === undefined || command === '') {
    throw new Error(`agent-acp: config command is required, or name a known agent with agent (${KNOWN_IDS})`)
  }
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
  assertProtocol(resolved.protocol)
  const definition = launchOf(resolved)
  const subprocess = ctx.subprocess
  const cwd = resolveCwd(resolved.cwd)
  installPlanProjection(ctx)
  const drivers = new Map<SessionId, AcpStepDriver>()
  ctx.agents.registerDriver((host) => {
    // Without the seam nobody can answer: a question is declined and a terminal
    // sign-in names, in the turn's failure, the program to run outside.
    const questions = host.ownerCtx.get('userQuestions')
    const driver = new AcpStepDriver(host, {
      definition,
      cwd,
      spawn: spec => subprocess.spawn(spec),
      permission: permissionAnswerer(resolved.permission, host),
      ...questions === undefined ? {} : { questions: questionAnswerer(questions, host), terminalSignIn: terminalSignIn(questions, host) },
      ...(() => {
        const resolveEnv = credentialResolver(ctx, resolved.credentialEnv)
        return resolveEnv === undefined ? {} : { resolveEnv }
      })(),
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

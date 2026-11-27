/**
 * The agent-acp test harness: the real factory (session store, agent registry,
 * agent loop, local subprocess seam) with the ACP row mounted, driving a
 * scripted external agent in a real child process. A harness can be reopened:
 * a second one on the same files simulates the harness restarting.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as acp from '../src/index.ts'

export const fakeAgent = fileURLToPath(new URL('./fake-agent.ts', import.meta.url))

/** One scripted turn of the external agent. */
export interface Turn {
  updates?: Record<string, unknown>[]
  stopReason?: string
  question?: { message: string; requestedSchema: Record<string, unknown> }
  settle?: number
  exit?: number
  /** Never answer the prompt until it is cancelled. */
  hang?: boolean
}

/** The script every process of the fake agent follows. */
export interface Scenario {
  turns: Turn[]
  name?: string | null
  resumable?: boolean
  auth?: { method: 'agent' | 'terminal'; url?: string; twice?: boolean; env?: boolean; marker?: 'beside-log' }
  options?: { modes?: unknown; configOptions?: Record<string, unknown>[] }
  loadFails?: boolean
  /** Advertise image prompts. */
  imagePrompts?: boolean
}

/** What a harness mounts beside the factory every harness mounts. */
export interface Mounts {
  approval?: boolean
  title?: boolean
  projections?: boolean
  commands?: boolean
  /** Registers a question provider answering through `answer`. */
  questions?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>
  /** Mounts a JSONL persistence under the harness directory, so a later harness reopens what this one wrote. */
  persist?: boolean
  /** Replaces the subprocess seam with one that records every spawn and fails it. */
  recordSpawns?: boolean
  /** Provides a credentials service whose every reference resolves to `secret:<reference>`. */
  credentials?: boolean
  /** Provides a credentials service that holds no reference at all. */
  emptyCredentials?: boolean
  /** Leaves the fake agent's command out of the row, so the config names every launch field itself. */
  bare?: boolean
  /** Mounts the local attachment store under the harness directory. */
  attachments?: boolean
}

export interface Harness {
  readonly ctx: Context
  readonly dir: string
  readonly scenario: Scenario
  readonly log: () => Record<string, unknown>[]
  /** What the question provider was asked, in order. */
  readonly asked: AskUserQuestionRequest[]
  /** Every spawn spec the recording seam received. */
  readonly spawns: { argv: readonly string[]; env: Record<string, string | undefined> }[]
}

interface Files {
  readonly dir: string
  readonly scenario: string
  readonly log: string
  readonly eof: string
}

async function mount(config: Partial<acp.Config>, mounts: Mounts, files: Files): Promise<Harness> {
  const ctx = new Context()
  const asked: AskUserQuestionRequest[] = []
  const spawns: Harness['spawns'] = []
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  if (mounts.persist === true) await ctx.plugin(JsonlSessionPersistence, { root: join(files.dir, 'persisted') })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (mounts.approval === true) await ctx.plugin(ApprovalService)
  if (mounts.title === true) {
    await ctx.plugin(SessionTitleService, { fallbackMaxWords: 4, fallbackMaxBytes: 64, maxTitleBytes: 256 })
  }
  if (mounts.projections === true) await ctx.plugin(SessionProjectionRegistry)
  if (mounts.commands === true) await ctx.plugin(CommandRuntime)
  if (mounts.attachments === true) await ctx.plugin(LocalAttachmentStore, { dshHome: files.dir })
  if (mounts.questions !== undefined) {
    await ctx.plugin(UserQuestionService)
    const answer = mounts.questions
    ctx.userQuestions.registerProvider({ ask: async (request) => { asked.push(request); return answer(request) } })
  }
  if (mounts.credentials === true || mounts.emptyCredentials === true) {
    const empty = mounts.emptyCredentials === true
    ctx.provide('credentials', {
      resolve: async (ref: { toString(): string }) => (empty ? undefined : { value: `secret:${String(ref)}`, source: 'test' }),
      describe: async () => ({ configured: !empty, writable: false }),
      set: async () => {},
      unset: async () => {},
    })
  }
  if (mounts.recordSpawns === true) {
    ctx.provide('subprocess', {
      spawn: (spec: SubprocessSpawnSpec) => {
        spawns.push({ argv: spec.argv, env: spec.env ?? {} })
        throw new Error('the recording seam starts no process')
      },
    })
  } else {
    await ctx.plugin(LocalSubprocessRuntime)
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(acp, {
    ...(mounts.bare === true ? {} : { command: process.execPath, args: [fakeAgent] }),
    env: { ACP_FAKE_SCENARIO: files.scenario, ACP_FAKE_LOG: files.log, ACP_FAKE_EOF: files.eof },
    credentialEnv: {},
    permission: 'reject',
    ...config,
  })
  return {
    ctx,
    dir: files.dir,
    scenario: JSON.parse(readFileSync(files.scenario, 'utf8')) as Scenario,
    asked,
    spawns,
    log: () => existsSync(files.log) ? readFileSync(files.log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [],
  }
}

/** A fresh harness on a fresh directory, with its script written. */
export async function harness(
  turns: Turn[],
  config: Partial<acp.Config> = {},
  mounts: Mounts = {},
  extra: Partial<Scenario> = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-acp-'))
  const files: Files = { dir, scenario: join(dir, 'scenario.json'), log: join(dir, 'log.jsonl'), eof: join(dir, 'eof') }
  writeFileSync(files.scenario, JSON.stringify({ turns, ...extra }))
  return mount(config, mounts, files)
}

/** A harness on the files a disposed one left: the same script position, log, and persisted sessions. */
export async function reopen(previous: Harness, config: Partial<acp.Config> = {}, mounts: Mounts = {}): Promise<Harness> {
  return mount(config, mounts, {
    dir: previous.dir,
    scenario: join(previous.dir, 'scenario.json'),
    log: join(previous.dir, 'log.jsonl'),
    eof: join(previous.dir, 'eof'),
  })
}

export function dispose(h: Harness): void {
  rmSync(h.dir, { recursive: true, force: true })
}

export function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const off = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        off()
        resolve()
      }
    })
  })
}

/** The events of a session that are its durable content. */
export function say(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Send one message in a session whose workspace is the harness directory, and wait for the turn. */
export async function run(h: Harness, text: string, sessionId = SessionId('acp')): Promise<Agent> {
  const agent = h.ctx.agentLoop.create(sessionId, {}, { cwd: h.dir })
  agent.followup(say(text))
  await waitForIdle(h.ctx, agent)
  return agent
}

/** Restore the session a disposed harness persisted, as the harness does when it starts again. */
export async function restore(h: Harness, sessionId = SessionId('acp')): Promise<Agent> {
  const handle = await h.ctx.agentLoop.resume(h.ctx, { resumeSessionId: sessionId })
  return handle.agent
}

export const chunk = (value: string): Record<string, unknown> => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })

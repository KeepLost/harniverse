// Proves the yml-facing `maxFiles` and the turn-boundary dependency are real
// composition facts: the tool boots through the real Loader against a
// Loader-mounted session-projection registry carrying the agent-loop
// turn-boundary unit, and both config faces it controls — the accepted input
// and the durable declaration — follow the cordis.yml.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { type Agent, Inbox } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import * as ToolPresent from '../src/index.ts'

// A stand-in module the yml mounts between the projection registry and the
// tool: the production composition reaches the same unit through
// `dsh-agent-loop`'s own registration.
const TurnBoundaryRegistrant = {
  name: 'present-test-turn-boundary',
  inject: ['sessionProjections'],
  apply(ctx: Context): void {
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  },
}

let root = ''
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== '') await rm(root, { recursive: true, force: true })
  root = ''
})

function agent(ctx: Context, followup: (message: UserMessage) => void = () => {}): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('present-loader-agent')
  const session = ctx.sessions.create(id, { meta: { cwd: root } })
  const value: Agent = {
    id, options: {}, session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle', ctx: scope.ctx,
    followup, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml carrying the given tool-present config block.
 * @param configLines - YAML lines nested under the tool's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-present-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-fs-local'",
    '  config:',
    '    cwd: ' + JSON.stringify(root),
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: 'present-test-turn-boundary'",
    "- name: '@deepseek-ai/dsh-tool-present'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['present-test-turn-boundary', TurnBoundaryRegistrant],
    ['@deepseek-ai/dsh-tool-present', ToolPresent],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('tool-present real Loader composition through cordis.yml', () => {
  it('maxFiles: 1 bounds the call and one file declares deliverables end to end', async () => {
    const ctx = await boot(['    maxFiles: 1'])
    const description = ctx.tools.schemas().find(s => s.name === 'present')?.description ?? ''
    expect(description).toContain('final deliverables')

    await writeFile(join(root, 'a.txt'), 'A')
    await writeFile(join(root, 'b.txt'), 'B')
    const owner = agent(ctx)
    owner.session.append('turn/start', { turn: 1 })

    const overflow = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('overflow'),
      name: 'present',
      arguments: { files: [{ path: 'a.txt' }, { path: 'b.txt' }] },
      agent: owner,
    })
    expect(overflow.isError).toBe(true)
    expect(resultText(overflow)).toContain('present accepts 1 to 1 files')
    expect(owner.session.events.some(event => event.type === 'deliverables/presented')).toBe(false)

    const files = [{ path: 'a.txt', description: 'the answer' }]
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('single'),
      name: 'present',
      arguments: { files },
      agent: owner,
    })
    expect(result.isError).toBe(false)
    const event = owner.session.events.findLast(event => event.type === 'deliverables/presented')
    expect(event?.data).toEqual({ turn: 1, callId: CallId('single'), files })
  }, 30_000)

  it('fails loading when maxFiles is not a positive integer', async () => {
    await expect(boot(['    maxFiles: 0'])).rejects.toThrow('present requires a positive integer maxFiles')
  }, 30_000)
})

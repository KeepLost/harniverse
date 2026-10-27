import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { Inbox } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectoryService, { effectiveCwd } from '@deepseek-ai/dsh-working-directory'

const signal = new AbortController().signal

/** Build one live agent whose injections enter a recording inbox. */
function stubAgent(cwd?: string): { agent: Agent; session: Session; injected: SessionEvent[] } {
  const id = SessionId('s1')
  const session = Session.create(id, [], cwd === undefined ? undefined : { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd })
  const injected: SessionEvent[] = []
  const status: AgentStatus = 'running'
  const agent: Agent = {
    id: SessionId('a1'),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status,
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: (message) => {
      injected.push(session.append('user/message', message, { surfaceOp: 'append' }))
    },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session, injected }
}

async function boot(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(WorkingDirectoryService, config)
  return ctx
}

/** Drive the projection registry for a session the test created outside any store. */
function syncProjection(ctx: Context, session: Session, before: number): void {
  for (const event of session.events.slice(before)) ctx.emit('session/event', session, event)
}

const roots: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'working-directory-spec-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('working directory service', () => {
  it('falls back to the header cwd and the deployment default before any change', async () => {
    const home = await tempDir()
    const ctx = await boot({ defaultDirectory: home })
    try {
      const withHeader = stubAgent(home)
      expect(ctx.workingDirectory.get(withHeader.session)).toBe(home)

      const headerless = stubAgent()
      expect(ctx.workingDirectory.get(headerless.session)).toBe(home)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records the implicit starting directory when ensure validates an unchanged session', async () => {
    const root = await tempDir()
    const ctx = await boot()
    try {
      const { agent, session, injected } = stubAgent(root)
      let before = session.events.length
      // ensure returns the stored directory as-is; only changes canonicalize.
      await expect(ctx.workingDirectory.ensure(agent)).resolves.toBe(root)
      syncProjection(ctx, session, before)
      expect(session.events.filter(event => event.type === 'working-directory/change')).toHaveLength(1)
      expect(injected).toHaveLength(0)
      // A second ensure neither re-appends nor notices.
      before = session.events.length
      await ctx.workingDirectory.ensure(agent)
      expect(session.events.filter(event => event.type === 'working-directory/change')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('commits a directory change with its notice and folds the projection', async () => {
    const root = await tempDir()
    const target = join(root, 'nested')
    const ctx = await boot()
    try {
      await mkdir(target)
      const { agent, session, injected } = stubAgent(root)
      const before = session.events.length
      const canonical = await ctx.workingDirectory.set(agent, 'nested')
      syncProjection(ctx, session, before)
      expect(canonical).toBe(await realpath(target))
      expect(ctx.workingDirectory.get(session)).toBe(canonical)
      expect(ctx.sessionProjections.snapshot(session).values.workingDirectory).toBe(canonical)
      const change = session.events.findLast(event => event.type === 'working-directory/change')
      expect(change?.type).toBe('working-directory/change')
      if (change?.type !== 'working-directory/change') throw new Error('expected change event')
      expect(change.data.cwd).toBe(canonical)
      expect(injected).toHaveLength(1)
      const notice = injected[0]
      if (notice === undefined || notice.type !== 'user/message') throw new Error('expected a user message notice')
      expect(notice.data.source).toEqual({ kind: 'working-directory' })
      expect(JSON.stringify(notice.data)).toContain('The working directory changed from')
      // Setting the same directory again is a no-op.
      await ctx.workingDirectory.set(agent, canonical)
      expect(session.events.filter(event => event.type === 'working-directory/change')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('recovers to the original project when the current directory disappears', async () => {
    const root = await tempDir()
    const moved = join(root, 'elsewhere')
    const ctx = await boot()
    try {
      await mkdir(moved)
      const { agent, session, injected } = stubAgent(root)
      let before = session.events.length
      await ctx.workingDirectory.set(agent, moved)
      syncProjection(ctx, session, before)
      await rm(moved, { recursive: true, force: true })
      before = session.events.length
      const recovered = await ctx.workingDirectory.ensure(agent)
      syncProjection(ctx, session, before)
      expect(recovered).toBe(await realpath(root))
      expect(ctx.workingDirectory.get(session)).toBe(recovered)
      expect(JSON.stringify(injected.at(-1)?.data)).toContain('is unavailable')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a change to a missing or non-directory path and an empty cd', async () => {
    const root = await tempDir()
    const ctx = await boot()
    try {
      const { agent, session } = stubAgent(root)
      await expect(ctx.workingDirectory.set(agent, join(root, 'missing'))).rejects.toThrow('directory does not exist')
      const file = join(root, 'file')
      await (await import('node:fs/promises')).writeFile(file, 'x')
      await expect(ctx.workingDirectory.set(agent, 'file')).rejects.toThrow('directory does not exist')
      await expect(ctx.workingDirectory.set(agent, '')).rejects.toThrow('cd must not be empty')
      expect(session.events.filter(event => event.type === 'working-directory/change')).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('recovers a headerless session to the deployment default', async () => {
    const home = await tempDir()
    const moved = join(home, 'moved')
    const ctx = await boot({ defaultDirectory: home })
    try {
      await mkdir(moved)
      const { agent, session } = stubAgent()
      const before = session.events.length
      await ctx.workingDirectory.set(agent, moved)
      syncProjection(ctx, session, before)
      await rm(moved, { recursive: true, force: true })
      await expect(ctx.workingDirectory.ensure(agent)).resolves.toBe(await realpath(home))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails ensure when neither the current nor the original directory exists', async () => {
    const root = await tempDir()
    const ctx = await boot()
    try {
      const { agent } = stubAgent(root)
      await rm(root, { recursive: true, force: true })
      await expect(ctx.workingDirectory.ensure(agent)).rejects.toThrow('directory does not exist')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serializes concurrent changes per session in submission order', async () => {
    const root = await tempDir()
    const first = join(root, 'first')
    const second = join(root, 'second')
    const ctx = await boot()
    try {
      await mkdir(first)
      await mkdir(second)
      const { agent, session } = stubAgent(root)
      const before = session.events.length
      const one = ctx.workingDirectory.set(agent, first)
      const two = ctx.workingDirectory.set(agent, second)
      await one.catch(() => {})
      await two.catch(() => {})
      syncProjection(ctx, session, before)
      await expect(one).resolves.toBe(await realpath(first))
      await expect(two).resolves.toBe(await realpath(second))
      expect(ctx.workingDirectory.get(session)).toBe(await realpath(second))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('surfaces the committed directory through the prompt contexts plane', async () => {
    const root = await tempDir()
    const ctx = await boot()
    try {
      const { agent } = stubAgent(root)
      const assembly = await ctx.systemPrompt.assemble({ agent, signal })
      const contribution = assembly.contexts.find(entry => entry.name === 'working-directory:current')
      expect(contribution?.text).toBe(`Current working directory: ${JSON.stringify(root)}.`)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits the context for agentless assembly and rejects a relative default', async () => {
    const ctx = await boot()
    try {
      const assembly = await ctx.systemPrompt.assemble({ signal })
      const entry = assembly.contexts.find(candidate => candidate.name === 'working-directory:current')
      expect(entry === undefined || entry.text === '').toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
    const relative = new Context()
    await relative.plugin(LocalFileSystem)
    await relative.plugin(SessionProjectionRegistry)
    let failure: unknown
    await relative.plugin(WorkingDirectoryService, { defaultDirectory: 'relative/dir' })
      .then(() => {}, (error: unknown) => { failure = error })
    expect(failure instanceof Error && failure.message.includes('must be absolute')).toBe(true)
    await relative.fiber.dispose()
  })

  it('recovers the committed directory from a restored session log', async () => {
    const root = await tempDir()
    const target = join(root, 'restored')
    const ctx = await boot()
    try {
      await mkdir(target)
      const { agent, session } = stubAgent(root)
      const before = session.events.length
      const canonical = await ctx.workingDirectory.set(agent, target)
      syncProjection(ctx, session, before)
      const restored = Session.fromRestore(session.id, session.events, session.header)
      expect(ctx.workingDirectory.get(restored)).toBe(canonical)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('warns instead of reverting when the notice queue rejects a committed change', async () => {
    const root = await tempDir()
    const target = join(root, 'notified')
    const ctx = await boot()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      await mkdir(target)
      const { agent, session } = stubAgent(root)
      agent.inject = () => { throw new Error('inbox closed') }
      const before = session.events.length
      await expect(ctx.workingDirectory.set(agent, target)).resolves.toBe(await realpath(target))
      syncProjection(ctx, session, before)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(ctx.workingDirectory.get(agent.session)).toBe(await realpath(target))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('derives the effective cwd with and without the owner mounted', async () => {
    const root = await tempDir()
    const target = join(root, 'effective')
    const ctx = await boot()
    try {
      await mkdir(target)
      const { agent, session } = stubAgent(root)
      const before = session.events.length
      const canonical = await ctx.workingDirectory.set(agent, 'effective')
      syncProjection(ctx, session, before)
      expect(canonical).toBe(await realpath(target))
      expect(effectiveCwd(agent)).toBe(canonical)
      expect(effectiveCwd(undefined)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
    // Without the service mounted, the immutable header cwd remains.
    const bare = stubAgent(root)
    expect(effectiveCwd(bare.agent)).toBe(root)
  })

  it('carries an explicit caller signal through serialization', async () => {
    const root = await tempDir()
    const target = join(root, 'signaled')
    const ctx = await boot()
    try {
      await mkdir(target)
      const { agent } = stubAgent(root)
      const control = new AbortController()
      await expect(ctx.workingDirectory.set(agent, target, control.signal)).resolves.toBe(await realpath(target))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses new operations after disposal', async () => {
    const root = await tempDir()
    const ctx = await boot()
    const service = ctx.workingDirectory
    const { agent } = stubAgent(root)
    await ctx.fiber.dispose()
    await expect(service.set(agent, root)).rejects.toThrow()
  })
})

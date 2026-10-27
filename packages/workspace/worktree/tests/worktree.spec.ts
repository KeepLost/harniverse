import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import WorktreeService, { runCommand } from '@deepseek-ai/dsh-worktree'

const execFileAsync = promisify(execFile)
const signal = new AbortController().signal
const roots: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'worktree-spec-'))
  roots.push(dir)
  return dir
}

/** Identity sandbox: records the wrapped argv and runs it unchanged. */
class RecordingSandbox extends Service implements SandboxProvider {
  confinements: readonly string[][] = []

  constructor(ctx: Context) {
    super(ctx, 'sandbox')
  }
  get sandboxMode(): 'read-only' | 'workspace-write' | 'danger-full-access' | undefined {
    return undefined
  }

  async confine(argv: readonly string[]): Promise<{ argv: string[]; enforcement: 'full'; denialSignatures: readonly string[]; runnerFailureRules: readonly [] }> {
    this.confinements = [...this.confinements, [...argv]]
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

function stubAgent(cwd: string): Agent {
  const id = SessionId('s1')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd })
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
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return agent
}

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  return stdout
}

/** One committed repository with two commits on `main`. */
async function tempRepo(): Promise<string> {
  const root = await tempDir()
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.email', 'spec@example.com')
  await git(root, 'config', 'user.name', 'Worktree Spec')
  await writeFile(join(root, 'first.txt'), 'first\n')
  await git(root, 'add', '.')
  await git(root, 'commit', '-m', 'first')
  await writeFile(join(root, 'second.txt'), 'second\n')
  await git(root, 'add', '.')
  await git(root, 'commit', '-m', 'second')
  return root
}

async function boot(config: Record<string, unknown> = {}, mode: 'read-only' | 'danger-full-access' = 'read-only'): Promise<{ ctx: Context; sandbox: RecordingSandbox }> {
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(RecordingSandbox)
  const sandbox = ctx.get('sandbox') as RecordingSandbox
  await ctx.plugin(SandboxPolicyService, { mode })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(WorkingDirectoryService)
  await ctx.plugin(WorktreeService, config)
  return { ctx, sandbox }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('worktree runCommand', () => {
  it('returns bounded stdout for an allowed exit and confines under a non-danger policy', async () => {
    const repo = await tempRepo()
    const { ctx, sandbox } = await boot()
    try {
      const policy = ctx.sandboxPolicy.resolve()
      const result = await runCommand(ctx, { timeoutMs: 30_000, graceMs: 3_000, maxOutputBytes: 65_536 }, policy,
        repo, [process.execPath, '-e', 'process.stdout.write("ok")'], signal)
      expect(result).toEqual({ stdout: 'ok', exitCode: 0 })
      expect(sandbox.confinements).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a failing command with empty captured output and an abort before spawn', async () => {
    const repo = await tempRepo()
    const { ctx } = await boot({}, 'danger-full-access')
    const limits = { timeoutMs: 30_000, graceMs: 3_000, maxOutputBytes: 65_536 }
    try {
      const policy = ctx.sandboxPolicy.resolve()
      let failure: unknown
      await runCommand(ctx, limits, policy, repo, [process.execPath, '-e', 'process.exit(1)'], signal)
        .then(() => {}, (error: unknown) => { failure = error })
      expect(String(failure)).toContain('worktree command failed with exit code 1')
      const aborted = AbortSignal.abort(new Error('before spawn'))
      let abortFailure: unknown
      await runCommand(ctx, limits, policy, repo, [process.execPath, '-e', ''], aborted)
        .then(() => {}, (error: unknown) => { abortFailure = error })
      expect(String(abortFailure)).toContain('before spawn')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('worktree service', () => {
  it('creates a retained worktree from HEAD and enters it', async () => {
    const repo = await tempRepo()
    const { ctx, sandbox } = await boot()
    try {
      const agent = stubAgent(repo)
      const created = await ctx.worktrees.create(agent, { name: 'feature' }, signal)
      expect(created.branch).toBe('feature')
      expect(created.repositoryRoot).toBe((await git(repo, 'rev-parse', '--show-toplevel')).trim())
      expect(created.baseCommit).toBe((await git(repo, 'rev-parse', 'HEAD')).trim())
      expect((await readFile(join(created.path, 'second.txt'), 'utf8')).trimEnd()).toBe('second')
      // The checkout pool carries a self-ignoring .gitignore from first allocation.
      expect(await readFile(join(repo, '.agents/worktrees/.gitignore'), 'utf8')).toBe('*\n')
      // The session entered the new checkout (drive the projection for the
      // standalone session, as the bound session store would).
      for (const event of agent.session.events) ctx.emit('session/event', agent.session, event)
      expect(ctx.workingDirectory.get(agent.session)).toBe(created.path)
      // One implicit start event from validation, one entry into the checkout.
      expect(agent.session.events.filter(event => event.type === 'working-directory/change')).toHaveLength(2)
      // The sandbox wrapped every non-interactive git invocation.
      expect(sandbox.confinements.length).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('pins an explicit local revision and disables configured filters during checkout', async () => {
    const repo = await tempRepo()
    const first = (await git(repo, 'rev-parse', 'HEAD~1')).trim()
    const { ctx } = await boot()
    try {
      await git(repo, 'config', 'filter.dummy.clean', 'sed s/first/filtered/')
      await git(repo, 'config', 'filter.dummy.smudge', 'sed s/filtered/first/')
      await writeFile(join(repo, '.gitattributes'), 'first.txt filter=dummy\n')
      await git(repo, 'add', '.gitattributes')
      await git(repo, 'commit', '-m', 'attributes')
      const agent = stubAgent(repo)
      const created = await ctx.worktrees.create(agent, { name: 'pinned', from: first }, signal)
      expect(created.baseCommit).toBe(first)
      expect((await readFile(join(created.path, 'first.txt'), 'utf8')).trimEnd()).toBe('first')
      // The pinned checkout excludes the later commit entirely.
      await expect(readFile(join(created.path, 'second.txt'), 'utf8')).rejects.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs commands without confinement only under danger-full-access', async () => {
    const repo = await tempRepo()
    const { ctx, sandbox } = await boot({}, 'danger-full-access')
    try {
      const agent = stubAgent(repo)
      await ctx.worktrees.create(agent, { name: 'unconfined' }, signal)
      expect(sandbox.confinements).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails on an existing branch, an existing path, traversal names, and non-repositories', async () => {
    const repo = await tempRepo()
    const { ctx } = await boot()
    try {
      const agent = stubAgent(repo)
      await ctx.worktrees.create(agent, { name: 'taken' }, signal)
      await expect(ctx.worktrees.create(agent, { name: 'taken' }, signal)).rejects.toThrow('worktree branch already exists')

      for (const name of ['../escape', 'a/../b', 'weird:name', '-leading-dash']) {
        await expect(ctx.worktrees.create(agent, { name }, signal)).rejects.toThrow('relative Git branch name')
      }
      await expect(ctx.worktrees.create(agent, { from: '' }, signal)).rejects.toThrow('from must name a local commit')

      const plain = await tempDir()
      await expect(ctx.worktrees.create(stubAgent(plain), {}, signal)).rejects.toThrow('worktree command failed')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retains partial artifacts and reports the failing operation', async () => {
    const repo = await tempRepo()
    const { ctx } = await boot()
    try {
      const agent = stubAgent(repo)
      // A pre-created destination is refused before any allocation.
      await mkdir(join(repo, '.agents/worktrees/collide'), { recursive: true })
      await expect(ctx.worktrees.create(agent, { name: 'collide' }, signal)).rejects.toThrow('worktree path already exists')
      // An allocation command that fails inside the guarded block leaves the
      // created branch retained and reports the wrapped failure.
      const failing = await boot({ nodeCommand: 'git' })
      try {
        await expect(failing.ctx.worktrees.create(stubAgent(repo), { name: 'wrapped' }, signal))
          .rejects.toThrow('Could not finish worktree wrapped')
      } finally {
        await failing.ctx.fiber.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects invalid service configuration at mount', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(RecordingSandbox)
    await ctx.plugin(SandboxPolicyService)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(WorkingDirectoryService)
    for (const [config, message] of [
      [{ directory: '../escape' }, 'relative directory'],
      [{ namePrefix: '-x' }, 'relative branch name'],
      [{ gitCommand: '  ' }, 'gitCommand'],
      [{ timeoutMs: 0 }, 'timeoutMs'],
      [{ maxOutputBytes: Number.NaN }, 'maxOutputBytes'],
    ] as [Record<string, unknown>, string][]) {
      let failure: unknown
      await ctx.plugin(WorktreeService, config).then(() => {}, (error: unknown) => { failure = error })
      expect(failure instanceof Error && failure.message.includes(message), JSON.stringify(config)).toBe(true)
    }
    await ctx.fiber.dispose()
  })

  it('refuses operations after disposal and honors an aborted signal', async () => {
    const repo = await tempRepo()
    const { ctx } = await boot()
    const service = ctx.worktrees
    const agent = stubAgent(repo)
    const aborted = AbortSignal.abort(new Error('cancelled'))
    await expect(service.create(agent, {}, aborted)).rejects.toThrow('cancelled')
    await ctx.fiber.dispose()
    await expect(service.create(agent, { name: 'after-dispose' })).rejects.toThrow()
  })
})

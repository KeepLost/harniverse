/**
 * Router unit tests: default-family resolution, per-request family routing,
 * spec tagging, mount degradation, and availability — over fake family
 * executors with a stubbed probe. A real-composition tail runs the actual
 * bash family end to end; loader-level composition evidence lives with the
 * web-app bundle tests.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import { ShellRouter, resolveDefaultFamily, ROUTED_FAMILY } from '../src/index.ts'
import type { FamilyExecutorPlugin } from '../src/index.ts'

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-shell-router-spec-'))

/** Deterministic output block for fake run results. */
const output = (text: string) => ({ text, truncated: false })

/** A passthrough sandbox confine: the caller's argv unchanged, unconfined. */
class PassthroughSandbox extends SandboxProvider {
  override confine(argv: readonly string[], _policy: SandboxPolicy, _signal?: AbortSignal): ConfinedArgv {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

/** One fake family executor: records resolve/run/start and answers canned results. */
class FakeFamilyExecutor extends ShellExecutor {
  readonly resolved: ShellExecRequest[] = []
  readonly ran: ShellExecSpec[] = []
  started = 0

  resolve(request: ShellExecRequest): ShellExecSpec {
    this.resolved.push(request)
    return {
      command: request.command,
      workdir: '/tmp',
      timeoutMs: 1000,
      stdoutMaxBytes: 1024,
      sandboxPolicy: undefined,
      ...request.shellPath !== undefined ? { shellPath: request.shellPath } : {},
    }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.ran.push(spec)
    return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, stdout: output(`${this.family}-ran`), stderr: output('') }
  }

  start(_spec: ShellExecSpec): ShellProcess {
    this.started += 1
    return {
      status: 'running',
      exitCode: null,
      signal: null,
      done: Promise.resolve(),
      readOutput: () => ({ delta: `${this.family}-started`, lossy: false }),
      kill: () => true,
    }
  }

  /** Family label stamped by the plugin wrapper; distinguishes the two fakes. */
  declare readonly family: 'bash' | 'pwsh'
}

/** A family plugin whose construction always fails, for degradation paths. */
class BrokenFamilyExecutor extends ShellExecutor {
  constructor(ctx: ConstructorParameters<typeof ShellExecutor>[0]) {
    super(ctx)
    throw new Error('broken family')
  }

  resolve(_request: ShellExecRequest): ShellExecSpec { throw new Error('unreachable') }
  override run(_spec: ShellExecSpec): Promise<ShellRunResult> { throw new Error('unreachable') }
  override start(_spec: ShellExecSpec): ShellProcess { throw new Error('unreachable') }
}

/** A family plugin that mounts cleanly without ever registering `ctx.shell`. */
const SilentFamilyPlugin = class {
  readonly kind = 'silent'
  constructor(ctx: Context) { void ctx }
}

/**
 * Build a family plugin that records its instance under `key` and labels the
 * executor's canned results with it.
 * @param key - family label the fake answers with.
 * @param instances - shared instance registry across one setup.
 */
function labeledFake(key: 'bash' | 'pwsh', instances: Map<'bash' | 'pwsh', FakeFamilyExecutor>): FamilyExecutorPlugin {
  return class extends FakeFamilyExecutor {
    constructor(ctx: ConstructorParameters<typeof ShellExecutor>[0]) {
      super(ctx)
      Object.assign(this, { family: key })
      instances.set(key, this)
    }
  }
}

/**
 * Boot a router over the given families with the binary probe stubbed.
 * @param families - the plugin table; `undefined` selects the labeled fake.
 * @param probe - which families the probe answers for (default: all).
 * @param config - extra router config.
 */
async function setupRouter(
  families: { bash?: FamilyExecutorPlugin; pwsh?: FamilyExecutorPlugin },
  probe: readonly ('bash' | 'pwsh')[] = ['bash', 'pwsh'],
  config: { defaultFamily?: 'bash' | 'pwsh'; families?: { bash?: unknown; pwsh?: unknown } } = {},
): Promise<{ ctx: Context; router: ShellRouter; fake: (family: 'bash' | 'pwsh') => FakeFamilyExecutor | undefined }> {
  const ctx = new Context()
  await ctx.plugin(PassthroughSandbox)
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only' })
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  vi.spyOn(ctx.subprocess, 'resolveExecutable').mockImplementation(async (command: string) => {
    const family = command === 'pwsh' ? 'pwsh' : 'bash'
    if (probe.includes(family)) return command
    throw new Error(`${command} not found`)
  })
  const instances = new Map<'bash' | 'pwsh', FakeFamilyExecutor>()
  const table = {
    bash: families.bash ?? labeledFake('bash', instances),
    pwsh: families.pwsh ?? labeledFake('pwsh', instances),
  }
  class TestRouter extends ShellRouter {
    protected override readonly familyPlugins = table
  }
  await ctx.plugin(TestRouter, config)
  return { ctx, router: ctx.shell as ShellRouter, fake: family => instances.get(family) }
}

describe('default-family resolution', () => {
  it('prefers explicit config over the published flag and the platform default', () => {
    expect(resolveDefaultFamily({ defaultFamily: 'pwsh' }, { DSH_SHELL_BACKEND: 'bash' }, 'linux')).toBe('pwsh')
  })

  it('reads the published boot flag before the platform split', () => {
    expect(resolveDefaultFamily({}, { DSH_SHELL_BACKEND: 'pwsh' }, 'linux')).toBe('pwsh')
    expect(resolveDefaultFamily({}, { DSH_SHELL_BACKEND: 'bash' }, 'win32')).toBe('bash')
  })

  it('falls back to the platform default when nothing is published', () => {
    expect(resolveDefaultFamily({}, {}, 'win32')).toBe('pwsh')
    expect(resolveDefaultFamily({}, {}, 'linux')).toBe('bash')
  })
})

describe('per-request family routing', () => {
  it('routes stamped requests to their family and tags the spec', async () => {
    const { router, fake } = await setupRouter({})
    const bashSpec = router.resolve({ command: 'echo one', family: 'bash' })
    const pwshSpec = router.resolve({ command: 'echo two', family: 'pwsh' })
    expect(bashSpec[ROUTED_FAMILY]).toBe('bash')
    expect(pwshSpec[ROUTED_FAMILY]).toBe('pwsh')
    await expect(router.run(bashSpec)).resolves.toMatchObject({ stdout: { text: 'bash-ran' } })
    await expect(router.run(pwshSpec)).resolves.toMatchObject({ stdout: { text: 'pwsh-ran' } })
    expect(fake('bash')?.ran.length).toBe(1)
    expect(fake('pwsh')?.ran.length).toBe(1)
  })

  it('resolves each family with the request it received', async () => {
    const { router, fake } = await setupRouter({})
    router.resolve({ command: 'echo tagged', family: 'pwsh', timeoutMs: 40_000 })
    expect(fake('pwsh')?.resolved).toEqual([{ command: 'echo tagged', family: 'pwsh', timeoutMs: 40_000 }])
  })

  it('addresses unstamped requests to the effective default family', async () => {
    const { router } = await setupRouter({}, ['bash', 'pwsh'], { defaultFamily: 'pwsh' })
    const spec = router.resolve({ command: 'echo default' })
    expect(spec[ROUTED_FAMILY]).toBe('pwsh')
    await expect(router.run(spec)).resolves.toMatchObject({ stdout: { text: 'pwsh-ran' } })
  })

  it('starts background specs on their tagged family', async () => {
    const { router, fake } = await setupRouter({})
    const spec = router.resolve({ command: 'sleep 1', family: 'pwsh' })
    const handle = router.start(spec)
    expect(fake('pwsh')?.started).toBe(1)
    expect((handle as ShellProcess).readOutput().delta).toBe('pwsh-started')
  })

  it('denies a family that never mounted with an error naming it', async () => {
    const { router } = await setupRouter({}, ['bash'])
    expect(() => router.resolve({ command: 'x', family: 'pwsh' })).toThrow('pwsh shell family is unavailable')
  })
})

/** A minimal shell-registry service double the router probes entries through. */
class FakeRegistryService extends Service {
  constructor(ctx: Context, private readonly doc: { default: string; entries: { id: string; path: string; label?: string }[] }) {
    super(ctx, 'shellRegistry')
  }
  document(): { default: string; entries: { id: string; path: string; label?: string }[] } { return this.doc }
}

/**
 * Boot a router over fake families with a registry document and a probe that
 * answers for exactly the given executables.
 */
async function setupRegistryRouter(
  doc: { default: string; entries: { id: string; path: string; label?: string }[] },
  probedPaths: readonly string[],
  plugins: { bash?: FamilyExecutorPlugin; pwsh?: FamilyExecutorPlugin } = {},
): Promise<{ ctx: Context; router: ShellRouter }> {
  const ctx = new Context()
  await ctx.plugin(PassthroughSandbox)
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only' })
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  vi.spyOn(ctx.subprocess, 'resolveExecutable').mockImplementation(async (command: string) => {
    if (probedPaths.includes(command)) return command
    throw new Error(`${command} not found`)
  })
  await ctx.plugin(FakeRegistryService, doc)
  class TestRouter extends ShellRouter {
    protected override readonly familyPlugins = {
      bash: plugins.bash ?? labeledFake('bash', new Map()),
      pwsh: plugins.pwsh ?? labeledFake('pwsh', new Map()),
    }
  }
  await ctx.plugin(TestRouter)
  return { ctx, router: ctx.shell as ShellRouter }
}

describe('registry entries', () => {
  it('probes registry entries alongside the builtins and publishes their status', async () => {
    const { ctx, router } = await setupRegistryRouter(
      { default: 'platform-default', entries: [{ id: 'my-zsh', path: '/opt/homebrew/bin/zsh' }] },
      ['bash', '/opt/homebrew/bin/zsh'],
    )
    const availability = router.availability()
    expect(availability.entries.find(entry => entry.id === 'my-zsh')).toMatchObject({
      stack: 'bash', available: true, resolvedPath: '/opt/homebrew/bin/zsh',
    })
    expect(availability.entries.find(entry => entry.id === 'pwsh')?.available).toBe(false)
    expect(availability.defaultEntry).toBe('posix')
    await ctx.fiber.dispose()
  })

  it('serves a family through a probed registry entry when its builtin probe fails', async () => {
    const { ctx, router } = await setupRegistryRouter(
      { default: 'platform-default', entries: [{ id: 'my-zsh', path: '/opt/homebrew/bin/zsh' }] },
      ['/opt/homebrew/bin/zsh', 'pwsh'],
    )
    expect(router.availability().families).toEqual({ bash: true, pwsh: true })
    await ctx.fiber.dispose()
  })

  it('adopts a probed registry default as the default entry and materializes it on unstamped specs', async () => {
    const { ctx, router } = await setupRegistryRouter(
      { default: 'my-zsh', entries: [{ id: 'my-zsh', path: '/opt/homebrew/bin/zsh' }] },
      ['bash', 'pwsh', '/opt/homebrew/bin/zsh'],
    )
    expect(router.availability().defaultEntry).toBe('my-zsh')
    expect(router.resolve({ command: 'x' }).shellPath).toBe('/opt/homebrew/bin/zsh')
    await ctx.fiber.dispose()
  })

  it('falls back to the platform builtin when the registry default probes unavailable', async () => {
    const { ctx, router } = await setupRegistryRouter(
      { default: 'my-zsh', entries: [{ id: 'my-zsh', path: '/opt/homebrew/bin/zsh' }] },
      ['bash', 'pwsh'],
    )
    expect(router.availability().defaultEntry).toBe('posix')
    expect(router.resolve({ command: 'x' }).shellPath).toBe('bash')
    await ctx.fiber.dispose()
  })

  it('probes a PowerShell-class custom entry and adopts it as the default', async () => {
    const { ctx, router } = await setupRegistryRouter(
      { default: 'preview', entries: [{ id: 'preview', path: '/usr/local/bin/pwsh-preview', label: 'pwsh preview' }] },
      ['bash', 'pwsh', '/usr/local/bin/pwsh-preview'],
    )
    const availability = router.availability()
    expect(availability.entries.find(entry => entry.id === 'preview')).toMatchObject({
      stack: 'pwsh', available: true, label: 'pwsh preview',
    })
    expect(availability.defaultEntry).toBe('preview')
    await ctx.fiber.dispose()
  })

  it('falls back to the platform builtin when the registry default\'s family fails to mount', async () => {
    const { ctx, router } = await setupRegistryRouter(
      { default: 'preview', entries: [{ id: 'preview', path: 'pwsh' }] },
      ['bash', 'pwsh'],
      { pwsh: BrokenFamilyExecutor },
    )
    expect(router.availability().defaultEntry).toBe('posix')
    await ctx.fiber.dispose()
  })

  it('keeps a caller-stamped executable over the default entry and skips non-default families', async () => {
    const { ctx, router } = await setupRegistryRouter(
      { default: 'platform-default', entries: [] },
      ['bash', 'pwsh'],
    )
    expect(router.resolve({ command: 'x', shellPath: '/custom/zsh' }).shellPath).toBe('/custom/zsh')
    expect(router.resolve({ command: 'x', family: 'pwsh' }).shellPath).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('folds a legacy family value as the registry default', async () => {
    const { ctx, router } = await setupRegistryRouter(
      { default: 'bash', entries: [] },
      ['bash', 'pwsh'],
    )
    expect(router.availability().defaultEntry).toBe('posix')
    await ctx.fiber.dispose()
  })

  it('skips probing an index-missing entry (an unclassifiable document bypassed validation)', async () => {
    const { ctx, router } = await setupRegistryRouter(
      { default: 'platform-default', entries: [{ id: 'fishy', path: '/usr/bin/fish' }, { id: 'my-zsh', path: '/opt/homebrew/bin/zsh' }] },
      ['bash', 'pwsh', '/opt/homebrew/bin/zsh'],
    )
    const ids = router.availability().entries.map(entry => entry.id)
    expect(ids).toContain('my-zsh')
    expect(ids).not.toContain('fishy')
    await ctx.fiber.dispose()
  })

  it('keeps the pinned stack builtin as the default entry under an explicit env pin', async () => {
    vi.stubEnv('DSH_SHELL_BACKEND', 'pwsh')
    try {
      const { ctx, router } = await setupRegistryRouter(
        { default: 'my-zsh', entries: [{ id: 'my-zsh', path: '/opt/homebrew/bin/zsh' }] },
        ['bash', 'pwsh', '/opt/homebrew/bin/zsh'],
      )
      expect(router.availability().defaultEntry).toBe('pwsh')
      expect(router.resolve({ command: 'x', family: 'pwsh' }).shellPath).toBe('pwsh')
      await ctx.fiber.dispose()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('mount degradation', () => {
  it('keeps the probed families serving while an unprobed one stays unavailable', async () => {
    const { router } = await setupRouter({}, ['bash'])
    expect(router.availability()).toMatchObject({ default: 'bash', defaultEntry: 'posix', families: { bash: true, pwsh: false } })
    expect(router.availability().entries.find(entry => entry.id === 'posix')).toMatchObject({ available: true, resolvedPath: 'bash' })
    expect(router.availability().entries.find(entry => entry.id === 'pwsh')?.available).toBe(false)
    await expect(router.run(router.resolve({ command: 'x' }))).resolves.toMatchObject({ stdout: { text: 'bash-ran' } })
  })

  it('falls back to the mounted alternative when the default family is unprobed', async () => {
    const { router } = await setupRouter({}, ['pwsh'], { defaultFamily: 'bash' })
    expect(router.availability().default).toBe('pwsh')
    expect(router.resolve({ command: 'x' })[ROUTED_FAMILY]).toBe('pwsh')
  })

  it('skips a family whose executor mount fails after a passing probe', async () => {
    const { router } = await setupRouter({ pwsh: BrokenFamilyExecutor }, ['bash', 'pwsh'])
    expect(router.availability()).toMatchObject({ default: 'bash', families: { bash: true, pwsh: false } })
  })

  it('skips a family that mounts without registering ctx.shell', async () => {
    const { router } = await setupRouter({ pwsh: SilentFamilyPlugin as unknown as FamilyExecutorPlugin }, ['bash', 'pwsh'])
    expect(router.availability()).toMatchObject({ default: 'bash', families: { bash: true, pwsh: false } })
  })

  it('routes a foreign untagged spec to the effective default family', async () => {
    // The default family is pinned: this pins ROUTING, not the platform's
    // default resolution (its own tests own that).
    const { router } = await setupRouter({}, ['bash', 'pwsh'], { defaultFamily: 'bash' })
    const foreign: ShellExecSpec = { command: 'echo foreign', workdir: '/tmp', timeoutMs: 1000, stdoutMaxBytes: 1024, sandboxPolicy: undefined }
    await expect(router.run(foreign)).resolves.toMatchObject({ stdout: { text: 'bash-ran' } })
  })

  it('reports the configured default before any family mounts', async () => {
    const ctx = new Context()
    const router = new ShellRouter(ctx, { defaultFamily: 'pwsh' })
    expect(router.availability()).toMatchObject({ default: 'pwsh', defaultEntry: 'pwsh', families: { bash: false, pwsh: false } })
    expect(router.availability().entries).toEqual([])
  })

  it('mounts the default family unprobed when the environment probes nothing', async () => {
    const { router } = await setupRouter({}, [], { defaultFamily: 'bash' })
    expect(router.availability()).toMatchObject({ default: 'bash', families: { bash: true, pwsh: false } })
    // Nothing probed, so no materialized default executable rides the spec.
    expect(router.resolve({ command: 'x' }).shellPath).toBeUndefined()
    const pwshHost = await setupRouter({}, [], { defaultFamily: 'pwsh' })
    expect(pwshHost.router.availability()).toMatchObject({ default: 'pwsh', families: { bash: false, pwsh: true } })
  })

  it('fails loud only when no family could mount', async () => {
    const ctx = new Context()
    await ctx.plugin(PassthroughSandbox)
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only' })
    await ctx.plugin(LocalSubprocessRuntime)
    vi.spyOn(ctx.subprocess, 'resolveExecutable').mockRejectedValue(new Error('nothing resolves'))
    await expect(ctx.plugin(ShellRouter, { families: { bash: {} } })).resolves.toBeDefined()
    const failing = new Context()
    await failing.plugin(PassthroughSandbox)
    await failing.plugin(SandboxPolicyService, { mode: 'read-only' })
    await failing.plugin(LocalSubprocessRuntime)
    vi.spyOn(failing.subprocess, 'resolveExecutable').mockRejectedValue(new Error('nothing resolves'))
    // Both families' plugin stacks throw in their constructors: even the
    // unprobed default mount fails, so the routed host cannot boot.
    class AllBrokenRouter extends ShellRouter {
      protected override readonly familyPlugins = { bash: BrokenFamilyExecutor, pwsh: BrokenFamilyExecutor } as never
    }
    await expect(failing.plugin(AllBrokenRouter)).rejects.toThrow('no shell family could mount')
    await failing.fiber.dispose()
  })
})

describe('the real bash family end to end', () => {
  it('runs a command through the routed sandboxed bash executor', async () => {
    const { router } = await setupRouter({ bash: SandboxBashExecutor }, ['bash'])
    expect(router.sandboxMode).toBe('read-only')
    const result = await router.run(router.resolve({ command: 'printf "%s" routed' }))
    expect(result.stdout.text).toBe('routed')
    expect(result.sandbox?.denied).toBe(false)
  })
  it('forwards the family composition entry to its mounted executor', async () => {
    const { router } = await setupRouter({ bash: SandboxBashExecutor }, ['bash'], { defaultFamily: 'bash', families: { bash: { timeoutMs: 45000 } } })
    const spec = router.resolve({ command: 'printf "%s" routed' })
    // The composed entry reaches the real executor's resolve: its timeout
    // overrides the class default (120s), proving the router forwarded it.
    expect(spec.timeoutMs).toBe(45000)
  })

})

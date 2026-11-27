import { generateKeyPairSync } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { Context } from '@deepseek-ai/cordis'
import { createEnrollmentRequest } from '@deepseek-ai/dsh-authentication-local'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireHomeOwnership, boot, loadOverlayPatches, loadProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { INSTALL_ANCHOR, runProfile } from '../src/profile-boot.ts'

const disposeProxy = vi.fn(async () => {})
vi.mock('@deepseek-ai/dsh-app-boot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>()
  return { ...actual, boot: vi.fn(actual.boot) }
})
vi.mock('@deepseek-ai/dsh-http-proxy', () => ({
  installProxyFromEnvironment: vi.fn(async () => disposeProxy),
}))

const previousHome = process.env.DSH_HOME
const previousExitCode = process.exitCode
let root: string | undefined

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  disposeProxy.mockClear()
  vi.restoreAllMocks()
  process.exitCode = previousExitCode
})

it('releases home, proxy and process listeners when profile preparation fails', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-profile-owner-'))
  const home = join(root, 'home')
  process.env.DSH_HOME = home
  const dir = join(home, 'profiles', 'empty')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), '{}')
  const beforeTerm = process.listenerCount('SIGTERM')
  const beforeInt = process.listenerCount('SIGINT')
  const beforeRejection = process.listenerCount('unhandledRejection')
  await expect(runProfile({
    environment: createLaunchEnvironmentSnapshot([]),
    profile: 'empty', patchFiles: [join(root, 'missing.patch.yml')], args: [],
  })).rejects.toThrow(/missing.patch.yml/)
  expect(disposeProxy).toHaveBeenCalledOnce()
  expect(process.listenerCount('SIGTERM')).toBe(beforeTerm)
  expect(process.listenerCount('SIGINT')).toBe(beforeInt)
  expect(process.listenerCount('unhandledRejection')).toBe(beforeRejection)
  const owner = await acquireHomeOwnership(home)
  await owner.release()
  const profileOwner = await acquireHomeOwnership(home, { profile: 'empty' })
  await profileOwner.release()
})

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const sourceBin = join(repoRoot, 'apps/cli/src/bin.ts')

async function invoke(home: string, args: string[]) {
  if (root === undefined) throw new Error('invocation requires an isolated working directory')
  const result = await execa(process.execPath, ['--import', import.meta.resolve('tsx/esm'), sourceBin, ...args], {
    cwd: root,
    env: {
      DSH_HOME: home, DSH_AGENTS_HOME: join(home, '.agents'),
      TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json'),
    },
    input: '', timeout: 20_000, killSignal: 'SIGKILL', reject: false,
  })
  expect(result.timedOut, result.stderr).toBe(false)
  expect(result.signal, result.stderr).toBeUndefined()
  return result
}

it.each([
  { args: ['auth', 'device', 'list'], output: 'ownership-test-device' },
  { args: ['auth', '--help'], output: 'Usage:' },
])('runs the real $args composition beside an exclusive home owner', async ({ args, output }) => {
  root = await mkdtemp(join(tmpdir(), 'dsh-auth-coexist-'))
  const home = join(root, 'home')
  const owner = await acquireHomeOwnership(home)
  const lease = join(home, 'runtime', 'instance.lease')
  const before = await readdir(lease)
  try {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const enrollment = await createEnrollmentRequest({
      name: 'ownership-test-device', kind: 'device',
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    }, { dshHome: home })
    const result = await invoke(home, args)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain(output)
    if (args.includes('list')) {
      expect(result.stdout).toBe(`${enrollment.id}\t${enrollment.approvalCode}\townership-test-device\tdevice\t${enrollment.expiresAt}`)
    }
    expect(existsSync(join(home, 'profiles', 'node_modules'))).toBe(false)
    expect(await readdir(lease)).toEqual(before)
    await expect(acquireHomeOwnership(home)).rejects.toThrow(/already running/)
  } finally {
    await owner.release()
  }
}, 25_000)

it('runs the real chat composition beside an exclusive home owner', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-chat-coexist-'))
  const home = join(root, 'home')
  const owner = await acquireHomeOwnership(home)
  try {
    const result = await invoke(home, ['chat', 'status', '--origin', 'http://127.0.0.1:9'])
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain('signing key: missing')
    expect(result.stdout).toContain('harniverse http://127.0.0.1:9: unreachable')
    await expect(acquireHomeOwnership(home)).rejects.toThrow(/already running/)
  } finally {
    await owner.release()
  }
}, 25_000)

it.each(Object.keys(PROFILE_TEMPLATES))('loads the shipped %s profile from this installation', async (profile) => {
  root = await mkdtemp(join(tmpdir(), 'dsh-shipped-profile-'))
  const loaded = loadProfile('t', profile, INSTALL_ANCHOR, root, { readOnly: true, userLayer: false })
  // Management profiles run beside the home owner; the serving profiles take the exclusive lease.
  expect(loaded.homeOwnership).toBe(['auth', 'chat', 'peer'].includes(profile) ? 'shared' : 'exclusive')
  expect(existsSync(join(root, 'profiles'))).toBe(false)
})

it('declares every plugin row of its shared bundles as a dependency of this installation', () => {
  const app = JSON.parse(readFileSync(INSTALL_ANCHOR, 'utf8')) as { dependencies: Record<string, string> }
  const installation = createRequire(INSTALL_ANCHOR)
  for (const bundles of Object.values(PROFILE_TEMPLATES)) {
    for (const bundle of bundles) {
      const dir = dirname(installation.resolve(`${bundle}/package.json`))
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        dsh?: { bundle?: { patch?: string; homeOwnership?: string } }
      }
      // Shared compositions resolve their rows from the installation instead of the profile fallback.
      if (manifest.dsh?.bundle?.homeOwnership !== 'shared') continue
      const rows = loadOverlayPatches('t', join(dir, manifest.dsh.bundle.patch!)).flatMap(patch => patch.insert ?? [])
      for (const row of rows) {
        // Only a bare package name resolves from the installation; relative and URL names stay config-relative.
        if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(row.name)) continue
        const packageName = row.name.split('/').slice(0, 2).join('/')
        expect(app.dependencies, `${bundle} mounts ${row.name}`).toHaveProperty(packageName)
      }
    }
  }
})

it('runs the real peer composition beside an exclusive home owner', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-peer-coexist-'))
  const home = join(root, 'home')
  const owner = await acquireHomeOwnership(home)
  try {
    const list = await invoke(home, ['peer', 'list'])
    expect(list.exitCode, list.stderr).toBe(0)
    expect(list.stdout).toBe('')
    const outbox = await invoke(home, ['peer', 'outbox'])
    expect(outbox.exitCode, outbox.stderr).toBe(0)
    expect(outbox.stdout).toBe('')
    expect(existsSync(join(home, 'profiles', 'node_modules'))).toBe(false)
    await expect(acquireHomeOwnership(home)).rejects.toThrow(/already running/)
  } finally {
    await owner.release()
  }
}, 45_000)

it.each(['web', 'headless'])('refuses a second %s before profile writes', async (profile) => {
  root = await mkdtemp(join(tmpdir(), 'dsh-profile-refused-'))
  const home = join(root, 'home')
  const owner = await acquireHomeOwnership(home)
  try {
    const result = await invoke(home, ['--profile', profile, '--help'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('already running')
    expect(existsSync(join(home, 'profiles'))).toBe(false)
  } finally {
    await owner.release()
  }
}, 25_000)

it('excludes a second shared invocation of the same profile before rewriting its root', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-shared-profile-'))
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', 'auth')
  await mkdir(profileDir, { recursive: true })
  const config = join(profileDir, 'cordis.yml')
  await writeFile(config, '# held by the first invocation\n[]\n')
  const owner = await acquireHomeOwnership(home, { profile: 'auth' })
  try {
    const result = await invoke(home, ['auth', '--help'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('already running')
    expect(await readFile(config, 'utf8')).toContain('held by the first invocation')
    expect(existsSync(join(profileDir, 'package.json'))).toBe(false)
  } finally {
    await owner.release()
  }
}, 25_000)

it('derives sharing from a custom profile bundle list and excludes mixed compositions before writes', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-custom-ownership-'))
  const home = join(root, 'home')
  const dir = join(home, 'profiles', 'management')
  await mkdir(dir, { recursive: true })
  const manifest = join(dir, 'package.json')
  await writeFile(manifest, JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-auth-app'] } } }))
  const owner = await acquireHomeOwnership(home)
  try {
    const shared = await invoke(home, ['--profile', 'management', '--help'])
    expect(shared.exitCode, shared.stderr).toBe(0)
    expect(shared.stdout).toContain('Usage:')
    await writeFile(manifest, JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-auth-app', '@deepseek-ai/dsh-base'] } } }))
    const config = join(dir, 'cordis.yml')
    await writeFile(config, '# do not rewrite\n[]\n')
    const mixed = await invoke(home, ['--profile', 'management', '--help'])
    expect(mixed.exitCode).not.toBe(0)
    expect(mixed.stderr).toContain('already running')
    expect(await readFile(config, 'utf8')).toBe('# do not rewrite\n[]\n')
    expect(existsSync(join(home, 'profiles', 'node_modules'))).toBe(false)
  } finally {
    await owner.release()
  }
}, 45_000)

it('holds the home until the actual root tree has finished draining', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-draining-owner-'))
  const home = join(root, 'home')
  process.env.DSH_HOME = home
  const dir = join(home, 'profiles', 'empty')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), '{}')
  const { ctx, shutdown } = await runProfile({
    environment: createLaunchEnvironmentSnapshot([]), profile: 'empty', patchFiles: [], args: [],
  })
  const started = Promise.withResolvers<undefined>()
  const drained = Promise.withResolvers<undefined>()
  ctx.effect(() => async () => {
    started.resolve(undefined)
    await drained.promise
  })
  const closing = shutdown.shutdown(0)
  try {
    await started.promise
    await expect(acquireHomeOwnership(home)).rejects.toThrow(/already running/)
  } finally {
    drained.resolve(undefined)
    await closing
  }
  const successor = await acquireHomeOwnership(home)
  await successor.release()
})

it('retains ownership when startup teardown cannot establish quiescence', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-failed-quiescence-'))
  const home = join(root, 'home')
  process.env.DSH_HOME = home
  const profileDir = join(home, 'profiles', 'empty')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), '{}')
  const ctx = new Context()
  const failedDispose = vi.spyOn(ctx.fiber, 'dispose').mockRejectedValue(new Error('still active'))
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  const emitter: EventEmitter = process
  const listeners = new Map(['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'].map(event => [event, emitter.listeners(event)]))
  vi.mocked(boot).mockImplementationOnce(async (_name, _config, _patches, prepare) => {
    await prepare?.(ctx)
    throw new Error('startup failed')
  })
  try {
    await expect(runProfile({
      environment: createLaunchEnvironmentSnapshot([]), profile: 'empty', patchFiles: [], args: [],
    })).rejects.toThrow('startup failed')
    expect(exit).toHaveBeenCalledWith(1)
    await expect(acquireHomeOwnership(home)).rejects.toThrow(/already running/)
  } finally {
    failedDispose.mockRestore()
    await ctx.fiber.dispose()
    for (const [event, previous] of listeners) {
      for (const listener of emitter.listeners(event)) {
        if (!previous.includes(listener)) emitter.off(event, listener as (...args: unknown[]) => void)
      }
    }
  }
})

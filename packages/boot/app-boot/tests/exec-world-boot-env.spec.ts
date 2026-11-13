/** Exec-world boot-env publication: document resolution, override precedence, provider degrade. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyExecWorldBootEnv, EXEC_WORLD_ENV } from '../src/index.ts'
import type { EnsureAssetsResult } from '@deepseek-ai/dsh-vm-qemu-local'
import { DEFAULT_HOST_IMPORT_MAX_BYTES } from '@deepseek-ai/dsh-vm-qemu-local'
import { HOST_WORKSPACE_ROOT_ENV } from '@deepseek-ai/dsh-vm'
import type { ExecWorldAvailability } from '@deepseek-ai/dsh-vm'

const homes: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** A fresh temp home optionally seeded with a settings document. */
function seededHome(document?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-exec-world-boot-'))
  homes.push(home)
  if (document !== undefined) writeFileSync(join(home, 'settings.yaml'), document)
  return home
}

const healthy: ExecWorldAvailability = { providerVersion: 'QEMU 8.1.3', assetsReady: true }
const unhealthy: ExecWorldAvailability = { providerVersion: undefined, assetsReady: false }

describe('applyExecWorldBootEnv', () => {
  it('publishes local when no document exists', async () => {
    const env: Record<string, string | undefined> = {}
    await applyExecWorldBootEnv({ env, home: seededHome(), probe: () => healthy })
    expect(env[EXEC_WORLD_ENV]).toBe('local')
  })

  it('publishes vm for a stored vm preference with a healthy provider', async () => {
    const env: Record<string, string | undefined> = {}
    const notices: string[] = []
    await applyExecWorldBootEnv({ env, home: seededHome('exec-world:\n  world: vm\n'), probe: () => healthy, scanWorkspace: async () => 0, warn: line => notices.push(line) })
    expect(env[EXEC_WORLD_ENV]).toBe('vm')
    expect(env[HOST_WORKSPACE_ROOT_ENV]).toBe(process.cwd())
    expect(notices).toEqual([])
  })

  it('degrades a stored vm preference to local when the provider probe is unhealthy', async () => {
    const env: Record<string, string | undefined> = {}
    const notices: string[] = []
    await applyExecWorldBootEnv({ env, home: seededHome('exec-world:\n  world: vm\n'), probe: () => unhealthy, warn: line => notices.push(line) })
    expect(env[EXEC_WORLD_ENV]).toBe('local')
    expect(notices).toEqual(['app boot: exec-world prefers vm but the VM provider probe is unhealthy; composing the local family\n'])
  })

  it('keeps an explicit env override, treating blank as unset', async () => {
    const home = seededHome('exec-world:\n  world: vm\n')
    const explicit: Record<string, string | undefined> = { [EXEC_WORLD_ENV]: 'local' }
    await applyExecWorldBootEnv({ env: explicit, home, probe: () => healthy })
    expect(explicit[EXEC_WORLD_ENV]).toBe('local')
    expect(explicit[HOST_WORKSPACE_ROOT_ENV]).toBeUndefined()
    const explicitVm: Record<string, string | undefined> = { [EXEC_WORLD_ENV]: 'vm' }
    await applyExecWorldBootEnv({ env: explicitVm, home, probe: () => healthy })
    expect(explicitVm[EXEC_WORLD_ENV]).toBe('vm')
    expect(explicitVm[HOST_WORKSPACE_ROOT_ENV]).toBe(process.cwd())
    const blank: Record<string, string | undefined> = { [EXEC_WORLD_ENV]: '  ' }
    await applyExecWorldBootEnv({ env: blank, home, probe: () => healthy, scanWorkspace: async () => 0 })
    expect(blank[EXEC_WORLD_ENV]).toBe('vm')
  })

  it('falls back to local on a malformed document', async () => {
    const env: Record<string, string | undefined> = {}
    await applyExecWorldBootEnv({ env, home: seededHome('exec-world: [unterminated\n'), probe: () => healthy })
    expect(env[EXEC_WORLD_ENV]).toBe('local')
  })

  it('takes the local default from documents that do not shape a preference', async () => {
    for (const document of ['other:\n  key: 1\n', '42\n', 'exec-world: 5\n', 'exec-world:\n  world: vmm\n']) {
      const env: Record<string, string | undefined> = {}
      await applyExecWorldBootEnv({ env, home: seededHome(document), probe: () => healthy })
      expect(env[EXEC_WORLD_ENV], document).toBe('local')
    }
  })

  it('skips the provider probe unless the stored preference is vm', async () => {
    const env: Record<string, string | undefined> = {}
    let probed = 0
    await applyExecWorldBootEnv({ env, home: seededHome(), probe: () => { probed += 1; return healthy } })
    expect(probed).toBe(0)
  })

  it('acts on this process when given no options', async () => {
    vi.stubEnv('DSH_HOME', seededHome())
    vi.stubEnv(EXEC_WORLD_ENV, '')
    await applyExecWorldBootEnv()
    expect(process.env[EXEC_WORLD_ENV]).toBe('local')
  })

  it('probes the real provider when none is injected, degrading deterministically without a resolvable binary', async () => {
    // An empty PATH makes the provider's spawnSync probe fail on every host,
    // so the default probe path and its degrade notice run unconditionally.
    vi.stubEnv('PATH', '')
    const env: Record<string, string | undefined> = { PATH: '' }
    await applyExecWorldBootEnv({ env, home: seededHome('exec-world:\n  world: vm\n') })
    expect(env[EXEC_WORLD_ENV]).toBe('local')
  })
})

describe('applyExecWorldBootEnv asset materialization', () => {
  const qemuOnly: ExecWorldAvailability = { providerVersion: 'QEMU 8.1.3', assetsReady: false }

  it('materializes assets for a stored vm preference and composes vm after the re-probe', async () => {
    const env: Record<string, string | undefined> = {}
    const notices: string[] = []
    let assetsReady = false
    const ensure = vi.fn(async (): Promise<EnsureAssetsResult> => {
      assetsReady = true
      return { status: 'downloaded', assetsDir: '/staged' }
    })
    await applyExecWorldBootEnv({
      env,
      home: seededHome('exec-world:\n  world: vm\n'),
      probe: () => ({ providerVersion: 'QEMU 8.1.3', assetsReady }),
      ensureAssets: ensure,
      scanWorkspace: async () => 0,
      warn: line => notices.push(line),
    })
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(env[EXEC_WORLD_ENV]).toBe('vm')
    expect(env[HOST_WORKSPACE_ROOT_ENV]).toBe(process.cwd())
    expect(notices).toEqual([])
  })

  it('degrades with the reason when the download reports unavailable', async () => {
    const env: Record<string, string | undefined> = {}
    const notices: string[] = []
    const ensure = vi.fn(async (): Promise<EnsureAssetsResult> => ({ status: 'unavailable', reason: 'HTTP 503', assetsDir: '/staged' }))
    await applyExecWorldBootEnv({
      env,
      home: seededHome('exec-world:\n  world: vm\n'),
      probe: () => qemuOnly,
      ensureAssets: ensure,
      warn: line => notices.push(line),
    })
    expect(env[EXEC_WORLD_ENV]).toBe('local')
    expect(notices).toEqual(['app boot: VM asset download failed (HTTP 503); composing the local family\n'])
  })

  it('does not attempt a download when the QEMU binary itself is missing', async () => {
    const env: Record<string, string | undefined> = {}
    const notices: string[] = []
    const ensure = vi.fn()
    await applyExecWorldBootEnv({
      env,
      home: seededHome('exec-world:\n  world: vm\n'),
      probe: () => unhealthy,
      ensureAssets: ensure,
      warn: line => notices.push(line),
    })
    expect(ensure).not.toHaveBeenCalled()
    expect(env[EXEC_WORLD_ENV]).toBe('local')
    expect(notices).toEqual(['app boot: exec-world prefers vm but the VM provider probe is unhealthy; composing the local family\n'])
  })

  it('degrades on the generic notice when the re-probe stays unhealthy after a download', async () => {
    const env: Record<string, string | undefined> = {}
    const notices: string[] = []
    const ensure = vi.fn(async (): Promise<EnsureAssetsResult> => ({ status: 'downloaded', assetsDir: '/staged' }))
    await applyExecWorldBootEnv({
      env,
      home: seededHome('exec-world:\n  world: vm\n'),
      probe: () => qemuOnly,
      ensureAssets: ensure,
      warn: line => notices.push(line),
    })
    expect(env[EXEC_WORLD_ENV]).toBe('local')
    expect(notices).toEqual(['app boot: exec-world prefers vm but the VM provider probe is unhealthy; composing the local family\n'])
  })
})

describe('applyExecWorldBootEnv default seams', () => {
  it('uses the real ensureAssets and the stderr notice writer when none is injected', async () => {
    vi.stubEnv('DSH_VM_ASSETS_URL', '')
    vi.stubEnv('DSH_HOME', seededHome('exec-world:\n  world: vm\n'))
    vi.stubEnv(EXEC_WORLD_ENV, '')
    const writes: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    try {
      const env: Record<string, string | undefined> = {}
      await applyExecWorldBootEnv({ env, probe: () => ({ providerVersion: 'QEMU 8.1.3', assetsReady: false }) })
      expect(env[EXEC_WORLD_ENV]).toBe('local')
      // Host-dependent middle step: a cold host's real ensureAssets answers
      // the disabled-env unavailable; a host with staged assets answers
      // present and the re-probe keeps the unhealthy verdict. Both write one
      // default-writer notice and degrade.
      expect(writes.join('')).toMatch(/VM asset download failed \(asset download disabled\)|provider probe is unhealthy/)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('applyExecWorldBootEnv host-workspace pre-scan', () => {
  it('composes vm when the anchor stays under the import bound', async () => {
    const env: Record<string, string | undefined> = {}
    const notices: string[] = []
    await applyExecWorldBootEnv({
      env,
      home: seededHome('exec-world:\n  world: vm\n'),
      probe: () => healthy,
      scanWorkspace: async () => 1024,
      warn: line => notices.push(line),
    })
    expect(env[EXEC_WORLD_ENV]).toBe('vm')
    expect(env[HOST_WORKSPACE_ROOT_ENV]).toBe(process.cwd())
    expect(notices).toEqual([])
  })

  it('degrades with both sizes named when the workspace passes the bound', async () => {
    const env: Record<string, string | undefined> = {}
    const notices: string[] = []
    const scanned: string[] = []
    await applyExecWorldBootEnv({
      env,
      home: seededHome('exec-world:\n  world: vm\n'),
      probe: () => healthy,
      scanWorkspace: async (root) => {
        scanned.push(root)
        return DEFAULT_HOST_IMPORT_MAX_BYTES + 1
      },
      warn: line => notices.push(line),
    })
    expect(scanned).toEqual([process.cwd()])
    expect(env[EXEC_WORLD_ENV]).toBe('local')
    expect(env[HOST_WORKSPACE_ROOT_ENV]).toBeUndefined()
    expect(notices).toEqual([
      `app boot: the host workspace carries ${DEFAULT_HOST_IMPORT_MAX_BYTES + 1} bytes, over the `
        + `${DEFAULT_HOST_IMPORT_MAX_BYTES}-byte VM import bound (raise $DSH_VM_IMPORT_MAX_BYTES or slim the tree); composing the local family\n`,
    ])
  })

  it('never scans on the explicit-env path', async () => {
    const env: Record<string, string | undefined> = { [EXEC_WORLD_ENV]: 'vm' }
    const scan = vi.fn()
    await applyExecWorldBootEnv({ env, home: seededHome(), scanWorkspace: scan })
    expect(scan).not.toHaveBeenCalled()
    expect(env[EXEC_WORLD_ENV]).toBe('vm')
  })
})

describe('applyExecWorldBootEnv anchor precedence', () => {
  it('keeps an explicit anchor over the launch directory', async () => {
    const env: Record<string, string | undefined> = {
      [EXEC_WORLD_ENV]: 'vm',
      [HOST_WORKSPACE_ROOT_ENV]: '/explicit/anchor',
    }
    await applyExecWorldBootEnv({ env, home: seededHome(), scanWorkspace: async () => 0 })
    expect(env[HOST_WORKSPACE_ROOT_ENV]).toBe('/explicit/anchor')
  })

  it('re-anchors a blank explicit value to the launch directory', async () => {
    const env: Record<string, string | undefined> = {
      [EXEC_WORLD_ENV]: 'vm',
      [HOST_WORKSPACE_ROOT_ENV]: '  ',
    }
    await applyExecWorldBootEnv({ env, home: seededHome(), scanWorkspace: async () => 0 })
    expect(env[HOST_WORKSPACE_ROOT_ENV]).toBe(process.cwd())
  })
})

describe('applyExecWorldBootEnv default notice writers', () => {
  it('writes the oversize degrade to stderr when no warn is injected', async () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    try {
      const env: Record<string, string | undefined> = {}
      await applyExecWorldBootEnv({
        env,
        home: seededHome('exec-world:\n  world: vm\n'),
        probe: () => healthy,
        scanWorkspace: async () => DEFAULT_HOST_IMPORT_MAX_BYTES + 1,
      })
      expect(env[EXEC_WORLD_ENV]).toBe('local')
      expect(writes.join('')).toContain('over the')
      expect(writes.join('')).toContain('-byte VM import bound')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('applyExecWorldBootEnv default scan', () => {
  it('scans the real launch directory when no scan is injected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-exec-world-scan-'))
    writeFileSync(join(dir, 'payload.txt'), '0123456789')
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
    try {
      const env: Record<string, string | undefined> = {}
      await applyExecWorldBootEnv({
        env,
        home: seededHome('exec-world:\n  world: vm\n'),
        probe: () => healthy,
      })
      expect(env[EXEC_WORLD_ENV]).toBe('vm')
      expect(env[HOST_WORKSPACE_ROOT_ENV]).toBe(dir)
    } finally {
      cwdSpy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

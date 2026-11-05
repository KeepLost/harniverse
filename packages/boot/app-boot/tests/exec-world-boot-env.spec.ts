/** Exec-world boot-env publication: document resolution, override precedence, provider degrade. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyExecWorldBootEnv, EXEC_WORLD_ENV } from '../src/index.ts'
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
  it('publishes local when no document exists', () => {
    const env: Record<string, string | undefined> = {}
    applyExecWorldBootEnv({ env, home: seededHome(), probe: () => healthy })
    expect(env[EXEC_WORLD_ENV]).toBe('local')
  })

  it('publishes vm for a stored vm preference with a healthy provider', () => {
    const env: Record<string, string | undefined> = {}
    const notices: string[] = []
    applyExecWorldBootEnv({ env, home: seededHome('exec-world:\n  world: vm\n'), probe: () => healthy, warn: line => notices.push(line) })
    expect(env[EXEC_WORLD_ENV]).toBe('vm')
    expect(notices).toEqual([])
  })

  it('degrades a stored vm preference to local when the provider probe is unhealthy', () => {
    const env: Record<string, string | undefined> = {}
    const notices: string[] = []
    applyExecWorldBootEnv({ env, home: seededHome('exec-world:\n  world: vm\n'), probe: () => unhealthy, warn: line => notices.push(line) })
    expect(env[EXEC_WORLD_ENV]).toBe('local')
    expect(notices).toEqual(['app boot: exec-world prefers vm but the VM provider probe is unhealthy; composing the local family\n'])
  })

  it('keeps an explicit env override, treating blank as unset', () => {
    const home = seededHome('exec-world:\n  world: vm\n')
    const explicit: Record<string, string | undefined> = { [EXEC_WORLD_ENV]: 'local' }
    applyExecWorldBootEnv({ env: explicit, home, probe: () => healthy })
    expect(explicit[EXEC_WORLD_ENV]).toBe('local')
    const blank: Record<string, string | undefined> = { [EXEC_WORLD_ENV]: '  ' }
    applyExecWorldBootEnv({ env: blank, home, probe: () => healthy })
    expect(blank[EXEC_WORLD_ENV]).toBe('vm')
  })

  it('falls back to local on a malformed document', () => {
    const env: Record<string, string | undefined> = {}
    applyExecWorldBootEnv({ env, home: seededHome('exec-world: [unterminated\n'), probe: () => healthy })
    expect(env[EXEC_WORLD_ENV]).toBe('local')
  })

  it('takes the local default from documents that do not shape a preference', () => {
    for (const document of ['other:\n  key: 1\n', '42\n', 'exec-world: 5\n', 'exec-world:\n  world: vmm\n']) {
      const env: Record<string, string | undefined> = {}
      applyExecWorldBootEnv({ env, home: seededHome(document), probe: () => healthy })
      expect(env[EXEC_WORLD_ENV], document).toBe('local')
    }
  })

  it('skips the provider probe unless the stored preference is vm', () => {
    const env: Record<string, string | undefined> = {}
    let probed = 0
    applyExecWorldBootEnv({ env, home: seededHome(), probe: () => { probed += 1; return healthy } })
    expect(probed).toBe(0)
  })

  it('acts on this process when given no options', () => {
    vi.stubEnv('DSH_HOME', seededHome())
    vi.stubEnv(EXEC_WORLD_ENV, '')
    applyExecWorldBootEnv()
    expect(process.env[EXEC_WORLD_ENV]).toBe('local')
  })

  it('probes the real provider when none is injected, degrading deterministically without a resolvable binary', () => {
    // An empty PATH makes the provider's spawnSync probe fail on every host,
    // so the default probe path and its degrade notice run unconditionally.
    vi.stubEnv('PATH', '')
    const env: Record<string, string | undefined> = { PATH: '' }
    applyExecWorldBootEnv({ env, home: seededHome('exec-world:\n  world: vm\n') })
    expect(env[EXEC_WORLD_ENV]).toBe('local')
  })
})

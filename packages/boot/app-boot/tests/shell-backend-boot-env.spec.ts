/** Shell-backend boot-env publication: document resolution, override precedence, fallbacks. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyShellBackendBootEnv, SHELL_BACKEND_ENV } from '../src/index.ts'
import { resolveShellBackend } from '@deepseek-ai/dsh-shell'

const homes: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** A fresh temp home optionally seeded with a settings document. */
function seededHome(document?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-shell-backend-boot-'))
  homes.push(home)
  if (document !== undefined) writeFileSync(join(home, 'settings.yaml'), document)
  return home
}

describe('applyShellBackendBootEnv', () => {
  it('publishes the platform split when no document exists', () => {
    const win32: Record<string, string | undefined> = {}
    applyShellBackendBootEnv({ env: win32, home: seededHome(), platform: 'win32' })
    expect(win32[SHELL_BACKEND_ENV]).toBe('pwsh')
    const linux: Record<string, string | undefined> = {}
    applyShellBackendBootEnv({ env: linux, home: seededHome(), platform: 'linux' })
    expect(linux[SHELL_BACKEND_ENV]).toBe('bash')
  })

  it('resolves the stored git-bash preference against the platform', () => {
    const home = seededHome('shell-backend:\n  backend: git-bash\n')
    const env: Record<string, string | undefined> = {}
    applyShellBackendBootEnv({ env, home, platform: 'win32' })
    expect(env[SHELL_BACKEND_ENV]).toBe('bash')
    // Off win32 the preference is inert: bash composes regardless.
    const other: Record<string, string | undefined> = {}
    applyShellBackendBootEnv({ env: other, home, platform: 'linux' })
    expect(other[SHELL_BACKEND_ENV]).toBe('bash')
  })

  it('keeps an explicit env override, treating blank as unset', () => {
    const home = seededHome('shell-backend:\n  backend: git-bash\n')
    const explicit: Record<string, string | undefined> = { [SHELL_BACKEND_ENV]: 'pwsh' }
    applyShellBackendBootEnv({ env: explicit, home, platform: 'win32' })
    expect(explicit[SHELL_BACKEND_ENV]).toBe('pwsh')
    const blank: Record<string, string | undefined> = { [SHELL_BACKEND_ENV]: '  ' }
    applyShellBackendBootEnv({ env: blank, home, platform: 'win32' })
    expect(blank[SHELL_BACKEND_ENV]).toBe('bash')
  })

  it('falls back to the platform default on a malformed document', () => {
    const home = seededHome('shell-backend: [unterminated\n')
    const env: Record<string, string | undefined> = {}
    applyShellBackendBootEnv({ env, home, platform: 'win32' })
    expect(env[SHELL_BACKEND_ENV]).toBe('pwsh')
  })

  it('takes the platform default from documents that do not shape a preference', () => {
    for (const document of ['other:\n  key: 1\n', '42\n', 'shell-backend: 5\n', 'shell-backend:\n  backend: cmd\n']) {
      const env: Record<string, string | undefined> = {}
      applyShellBackendBootEnv({ env, home: seededHome(document), platform: 'win32' })
      expect(env[SHELL_BACKEND_ENV], document).toBe('pwsh')
    }
  })

  it('acts on this process when given no options', () => {
    vi.stubEnv('DSH_HOME', seededHome('shell-backend:\n  backend: git-bash\n'))
    vi.stubEnv(SHELL_BACKEND_ENV, '')
    applyShellBackendBootEnv()
    expect(process.env[SHELL_BACKEND_ENV]).toBe(resolveShellBackend(process.platform, 'git-bash'))
  })
})

/** Shell-registry boot-env publication: document resolution, override precedence, fallbacks. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyShellBackendBootEnv, SHELL_BACKEND_ENV, SHELL_DEFAULT_PATH_ENV } from '../src/index.ts'
import { resolveShellBackend } from '@deepseek-ai/dsh-shell'

const homes: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** A fresh temp home optionally seeded with a settings document. */
function seededHome(document?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-shell-registry-boot-'))
  homes.push(home)
  if (document !== undefined) writeFileSync(join(home, 'settings.yaml'), document)
  return home
}

describe('applyShellBackendBootEnv', () => {
  it('publishes the platform split when no document exists', () => {
    const win32: Record<string, string | undefined> = {}
    applyShellBackendBootEnv({ env: win32, home: seededHome(), platform: 'win32' })
    expect(win32[SHELL_BACKEND_ENV]).toBe('pwsh')
    expect(win32[SHELL_DEFAULT_PATH_ENV]).toBeUndefined()
    const linux: Record<string, string | undefined> = {}
    applyShellBackendBootEnv({ env: linux, home: seededHome(), platform: 'linux' })
    expect(linux[SHELL_BACKEND_ENV]).toBe('bash')
    expect(linux[SHELL_DEFAULT_PATH_ENV]).toBeUndefined()
  })

  it('resolves a stored builtin or custom default on every platform', () => {
    const posixDefault = seededHome('shell-registry:\n  default: posix\n')
    const win32: Record<string, string | undefined> = {}
    applyShellBackendBootEnv({ env: win32, home: posixDefault, platform: 'win32' })
    expect(win32[SHELL_BACKEND_ENV]).toBe('bash')
    const pwshDefault = seededHome('shell-registry:\n  default: pwsh\n')
    const linux: Record<string, string | undefined> = {}
    applyShellBackendBootEnv({ env: linux, home: pwshDefault, platform: 'linux' })
    expect(linux[SHELL_BACKEND_ENV]).toBe('pwsh')
    expect(linux[SHELL_DEFAULT_PATH_ENV]).toBeUndefined()
  })

  it('publishes a custom default entry stack and its executable', () => {
    const home = seededHome('shell-registry:\n'
      + '  default: my-zsh\n'
      + '  entries:\n'
      + '    - id: my-zsh\n'
      + '      path: /opt/homebrew/bin/zsh\n'
      + '      label: Work zsh\n')
    const env: Record<string, string | undefined> = {}
    applyShellBackendBootEnv({ env, home, platform: 'darwin' })
    expect(env[SHELL_BACKEND_ENV]).toBe('bash')
    expect(env[SHELL_DEFAULT_PATH_ENV]).toBe('/opt/homebrew/bin/zsh')
  })

  it('omits the default executable when the custom entry routes to another stack', () => {
    const home = seededHome('shell-registry:\n'
      + '  default: preview\n'
      + '  entries:\n'
      + '    - id: preview\n'
      + '      path: /usr/local/bin/pwsh-preview\n')
    const env: Record<string, string | undefined> = { [SHELL_BACKEND_ENV]: 'bash' }
    applyShellBackendBootEnv({ env, home, platform: 'linux' })
    expect(env[SHELL_DEFAULT_PATH_ENV]).toBeUndefined()
  })

  it('keeps an explicit env override, treating blank as unset', () => {
    const home = seededHome('shell-registry:\n  default: pwsh\n')
    const explicit: Record<string, string | undefined> = { [SHELL_BACKEND_ENV]: 'bash' }
    applyShellBackendBootEnv({ env: explicit, home, platform: 'win32' })
    expect(explicit[SHELL_BACKEND_ENV]).toBe('bash')
    expect(explicit[SHELL_DEFAULT_PATH_ENV]).toBeUndefined()
    const blank: Record<string, string | undefined> = { [SHELL_BACKEND_ENV]: '  ' }
    applyShellBackendBootEnv({ env: blank, home, platform: 'win32' })
    expect(blank[SHELL_BACKEND_ENV]).toBe('pwsh')
  })

  it('folds a stored legacy bash default to the posix builtin', () => {
    const home = seededHome('shell-registry:\n  default: bash\n')
    const env: Record<string, string | undefined> = {}
    applyShellBackendBootEnv({ env, home, platform: 'linux' })
    expect(env[SHELL_BACKEND_ENV]).toBe('bash')
    expect(env[SHELL_DEFAULT_PATH_ENV]).toBeUndefined()
  })

  it('drops malformed entry rows and a non-array entries field without failing the boot', () => {
    const home = seededHome('shell-registry:\n'
      + '  default: my-zsh\n'
      + '  entries:\n'
      + '    - id: my-zsh\n'
      + '      path: /opt/homebrew/bin/zsh\n'
      + '    - null\n'
      + '    - 7\n'
      + '    - id: 9\n'
      + '      path: /bin/never\n')
    const env: Record<string, string | undefined> = {}
    applyShellBackendBootEnv({ env, home, platform: 'darwin' })
    expect(env[SHELL_DEFAULT_PATH_ENV]).toBe('/opt/homebrew/bin/zsh')

    const stringEntries = seededHome('shell-registry:\n  default: posix\n  entries: oops\n')
    const env2: Record<string, string | undefined> = {}
    applyShellBackendBootEnv({ env: env2, home: stringEntries, platform: 'linux' })
    expect(env2[SHELL_BACKEND_ENV]).toBe('bash')
  })

  it('falls back to the platform default on a malformed document', () => {
    const home = seededHome('shell-registry: [unterminated\n')
    const env: Record<string, string | undefined> = {}
    applyShellBackendBootEnv({ env, home, platform: 'win32' })
    expect(env[SHELL_BACKEND_ENV]).toBe('pwsh')
  })

  it('takes the platform default from documents that do not shape a registry', () => {
    for (const document of [
      'other:\n  key: 1\n',
      '42\n',
      'shell-registry: 5\n',
      'shell-registry:\n  default: ghost\n',
      'shell-registry:\n  entries: not-a-list\n',
      'shell-registry:\n  entries:\n    - id: 7\n',
    ]) {
      const env: Record<string, string | undefined> = {}
      applyShellBackendBootEnv({ env, home: seededHome(document), platform: 'win32' })
      expect(env[SHELL_BACKEND_ENV], document).toBe('pwsh')
      expect(env[SHELL_DEFAULT_PATH_ENV], document).toBeUndefined()
    }
  })

  it('acts on this process when given no options', () => {
    vi.stubEnv('DSH_HOME', seededHome('shell-registry:\n  default: pwsh\n'))
    vi.stubEnv(SHELL_BACKEND_ENV, '')
    applyShellBackendBootEnv()
    expect(process.env[SHELL_BACKEND_ENV]).toBe(resolveShellBackend(process.platform, 'pwsh'))
  })
})

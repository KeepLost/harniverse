/** Shell-backend resolution mapping shared by the boot bridge and the settings namespace. */
import { describe, expect, it } from 'vitest'
import { resolveShellBackend } from '../src/backend.ts'

describe('resolveShellBackend', () => {
  it('keeps bash on every non-win32 platform regardless of preference', () => {
    for (const platform of ['linux', 'darwin', 'freebsd'] as const) {
      expect(resolveShellBackend(platform, 'platform-default')).toBe('bash')
      expect(resolveShellBackend(platform, 'git-bash')).toBe('bash')
    }
  })

  it('selects pwsh on win32 under the platform default and bash only under git-bash', () => {
    expect(resolveShellBackend('win32', 'platform-default')).toBe('pwsh')
    expect(resolveShellBackend('win32', 'git-bash')).toBe('bash')
  })
})

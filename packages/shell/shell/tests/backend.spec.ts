/** Shell-backend resolution mapping shared by the boot bridge and the settings namespace. */
import { describe, expect, it } from 'vitest'
import { resolveRegistryDefaultStack, resolveShellBackend } from '../src/backend.ts'
import { PLATFORM_DEFAULT_ID } from '../src/registry.ts'

describe('resolveShellBackend', () => {
  it('honors an explicit stack on every platform', () => {
    for (const platform of ['linux', 'darwin', 'freebsd', 'win32'] as const) {
      expect(resolveShellBackend(platform, 'bash')).toBe('bash')
      expect(resolveShellBackend(platform, 'pwsh')).toBe('pwsh')
    }
  })

  it('splits the platform default: pwsh on win32, bash elsewhere', () => {
    expect(resolveShellBackend('win32', 'platform-default')).toBe('pwsh')
    for (const platform of ['linux', 'darwin', 'freebsd'] as const) {
      expect(resolveShellBackend(platform, 'platform-default')).toBe('bash')
    }
  })
})

describe('resolveRegistryDefaultStack', () => {
  it('splits the reserved platform default', () => {
    expect(resolveRegistryDefaultStack('win32', { default: PLATFORM_DEFAULT_ID, entries: [] })).toBe('pwsh')
    expect(resolveRegistryDefaultStack('linux', { default: PLATFORM_DEFAULT_ID, entries: [] })).toBe('bash')
  })

  it('addresses builtin ids by their own stack on every platform', () => {
    expect(resolveRegistryDefaultStack('linux', { default: 'pwsh', entries: [] })).toBe('pwsh')
    expect(resolveRegistryDefaultStack('win32', { default: 'posix', entries: [] })).toBe('bash')
  })

  it('routes a custom default entry through its dialect class', () => {
    const entries = [{ id: 'my-zsh', path: '/opt/homebrew/bin/zsh' }]
    expect(resolveRegistryDefaultStack('linux', { default: 'my-zsh', entries })).toBe('bash')
    const pwshEntries = [{ id: 'preview', path: '/usr/local/bin/pwsh-preview' }]
    expect(resolveRegistryDefaultStack('linux', { default: 'preview', entries: pwshEntries })).toBe('pwsh')
  })

  it('falls back to the platform split for unknown or unclassifiable defaults', () => {
    expect(resolveRegistryDefaultStack('linux', { default: 'gone', entries: [] })).toBe('bash')
    expect(resolveRegistryDefaultStack('win32', { default: 'gone', entries: [] })).toBe('pwsh')
    expect(resolveRegistryDefaultStack('linux', { default: 'fishy', entries: [{ id: 'fishy', path: '/usr/bin/fish' }] })).toBe('bash')
  })
})

/** Registry indexing, classification, and the single effective-shell resolver. */
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_POSIX_ID,
  BUILTIN_PWSH_ID,
  classifyShellDialect,
  PLATFORM_DEFAULT_ID,
  registryEntryIndex,
  resolveEffectiveShell,
  shellFactText,
} from '../src/registry.ts'
import type { ShellEntryStatus } from '../src/registry.ts'

const EMPTY = { default: PLATFORM_DEFAULT_ID, entries: [] }

describe('classifyShellDialect', () => {
  it('routes POSIX-family basenames', () => {
    expect(classifyShellDialect('bash')).toBe('posix')
    expect(classifyShellDialect('/bin/zsh')).toBe('posix')
    expect(classifyShellDialect('C:\\tools\\dash.exe')).toBe('posix')
    expect(classifyShellDialect('/usr/bin/ksh')).toBe('posix')
  })

  it('routes PowerShell basenames', () => {
    expect(classifyShellDialect('pwsh')).toBe('pwsh')
    expect(classifyShellDialect('/usr/local/bin/pwsh-preview')).toBe('pwsh')
    expect(classifyShellDialect('powershell.exe')).toBe('pwsh')
  })

  it('rejects unsupported dialect classes', () => {
    expect(classifyShellDialect('/usr/bin/fish')).toBeUndefined()
    expect(classifyShellDialect('/usr/local/bin/nu')).toBeUndefined()
    expect(classifyShellDialect('cmd.exe')).toBeUndefined()
  })
})

describe('registryEntryIndex', () => {
  it('always serves the two builtins', () => {
    const index = registryEntryIndex('linux', EMPTY)
    expect(index.get(BUILTIN_POSIX_ID)).toMatchObject({ stack: 'bash', path: 'bash' })
    expect(index.get(BUILTIN_PWSH_ID)).toMatchObject({ stack: 'pwsh', path: 'pwsh' })
    expect(registryEntryIndex('darwin', EMPTY).get(BUILTIN_POSIX_ID)).toMatchObject({ path: '/bin/zsh' })
  })

  it('labels custom entries with their basename unless a label is given', () => {
    const index = registryEntryIndex('linux', {
      default: PLATFORM_DEFAULT_ID,
      entries: [
        { id: 'a', path: '/opt/bin/zsh' },
        { id: 'b', path: '/opt/bin/zsh', label: 'Work zsh' },
      ],
    })
    expect(index.get('a')?.label).toBe('zsh')
    expect(index.get('b')?.label).toBe('Work zsh')
  })

  it('skips unclassifiable entries so they degrade at resolution', () => {
    const index = registryEntryIndex('linux', {
      default: PLATFORM_DEFAULT_ID,
      entries: [{ id: 'fishy', path: '/usr/bin/fish' }],
    })
    expect(index.has('fishy')).toBe(false)
  })
})

describe('shellFactText', () => {
  it('names the actual shell and tool per stack', () => {
    expect(shellFactText('bash', 'bash', '/bin/bash'))
      .toBe('Current shell for commands: bash (/bin/bash). Run shell commands with the `bash` tool; its syntax is POSIX shell.')
    expect(shellFactText('zsh', 'bash', '/bin/zsh'))
      .toBe('Current shell for commands: zsh (/bin/zsh). Run shell commands with the `bash` tool; its syntax is POSIX-compatible zsh.')
    expect(shellFactText('pwsh', 'pwsh', '/usr/bin/pwsh'))
      .toBe('Current shell for commands: pwsh (PowerShell, /usr/bin/pwsh). Run shell commands with the `pwsh` tool; its syntax is PowerShell.')
    expect(shellFactText('pwsh', 'pwsh'))
      .toBe('Current shell for commands: pwsh (PowerShell). Run shell commands with the `pwsh` tool; its syntax is PowerShell.')
  })
})

/** A probe-table row for the given entry. */
const probed = (id: string, stack: 'bash' | 'pwsh', resolvedPath: string): [string, ShellEntryStatus] =>
  [id, { id, label: id, stack, path: resolvedPath, available: true, resolvedPath }]

describe('resolveEffectiveShell', () => {
  it('resolves the platform default without an override', () => {
    const effective = resolveEffectiveShell({ platform: 'linux', registry: EMPTY, override: null })
    expect(effective).toMatchObject({ entryId: BUILTIN_POSIX_ID, stack: 'bash', executablePath: undefined })
    expect(effective.factText).toContain('Current shell for commands: bash.')
    expect(effective.degraded).toBeUndefined()
  })

  it('stamps no executable for an unprobed bare-name builtin; the executor resolves', () => {
    const availability = new Map<string, ShellEntryStatus>([
      [BUILTIN_PWSH_ID, { id: BUILTIN_PWSH_ID, label: 'pwsh', stack: 'pwsh', path: 'pwsh', available: false, reason: 'not found on PATH' }],
    ])
    const effective = resolveEffectiveShell({ platform: 'win32', registry: EMPTY, override: null, availability })
    expect(effective).toMatchObject({ entryId: BUILTIN_PWSH_ID, stack: 'pwsh' })
    expect(effective.executablePath).toBeUndefined()
    expect(effective.degraded).toBeUndefined()
  })

  it('resolves a custom override with its materialized probe path', () => {
    const registry = { default: PLATFORM_DEFAULT_ID, entries: [{ id: 'my-zsh', path: '/opt/homebrew/bin/zsh' }] }
    const availability = new Map([probed('my-zsh', 'bash', '/opt/homebrew/bin/zsh')])
    const effective = resolveEffectiveShell({ platform: 'darwin', registry, override: 'my-zsh', availability })
    expect(effective).toMatchObject({ entryId: 'my-zsh', stack: 'bash', executablePath: '/opt/homebrew/bin/zsh' })
    expect(effective.factText).toContain('zsh (/opt/homebrew/bin/zsh)')
    expect(effective.factText).toContain('POSIX-compatible zsh')
  })

  it('degrades an unavailable custom override to the platform builtin with a reason', () => {
    const registry = { default: PLATFORM_DEFAULT_ID, entries: [{ id: 'gone', path: '/usr/local/bin/zsh' }] }
    const availability = new Map<string, ShellEntryStatus>([
      ['gone', { id: 'gone', label: 'zsh', stack: 'bash', path: '/usr/local/bin/zsh', available: false, reason: 'ENOENT' }],
    ])
    const effective = resolveEffectiveShell({ platform: 'linux', registry, override: 'gone', availability })
    expect(effective.entryId).toBe(BUILTIN_POSIX_ID)
    expect(effective.degraded).toContain('"gone" is unavailable')
  })

  it('degrades an orphan override (deleted entry) to the platform builtin', () => {
    const effective = resolveEffectiveShell({ platform: 'linux', registry: EMPTY, override: 'deleted-id' })
    expect(effective.entryId).toBe(BUILTIN_POSIX_ID)
    expect(effective.degraded).toContain('"deleted-id" is not registered')
  })

  it('uses entry paths verbatim on unprobed hosts (no availability table)', () => {
    const registry = { default: 'preview', entries: [{ id: 'preview', path: '/usr/local/bin/pwsh-preview' }] }
    const effective = resolveEffectiveShell({ platform: 'linux', registry, override: null })
    expect(effective).toMatchObject({ entryId: 'preview', stack: 'pwsh', executablePath: '/usr/local/bin/pwsh-preview' })
    expect(effective.degraded).toBeUndefined()
  })

  it('folds the legacy family ids onto the builtins', () => {
    const asPwsh = resolveEffectiveShell({ platform: 'linux', registry: EMPTY, override: 'pwsh' })
    expect(asPwsh.entryId).toBe(BUILTIN_PWSH_ID)
    const asPosix = resolveEffectiveShell({ platform: 'win32', registry: EMPTY, override: 'bash' })
    expect(asPosix.entryId).toBe(BUILTIN_POSIX_ID)
  })
})

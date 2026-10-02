import { describe, expect, it } from 'vitest'
import type { Config } from '@deepseek-ai/dsh-terminal-bash/src/config.ts'
import { validateConfig } from '@deepseek-ai/dsh-terminal-bash/src/config.ts'
import { defaultInteractiveShell, defaultShellName } from '@deepseek-ai/dsh-shell'

function config(overrides: Partial<Config> = {}): Config {
  return {
    backendType: 'shell', shellPath: '/bin/bash', shellArgs: [], rows: 40, cols: 160,
    scrollbackLines: 100, scrollbackMaxBytes: 1024, maxReadBytes: 512,
    pollIntervalMs: 10, exactProbeAfterMs: 20, idleSilenceMs: 100, handoffGraceMs: 50, promptTailGraceMs: 0, timeoutMs: 1000,
    disposeGraceMs: 100,
    ...overrides,
  }
}

describe('terminal-bash config', () => {
  it('uses zsh directly as the macOS interactive default without changing Linux', () => {
    expect(defaultInteractiveShell('darwin')).toEqual({ path: '/bin/zsh', args: ['-f', '-i'] })
    expect(defaultInteractiveShell('linux')).toEqual({ path: '/bin/bash', args: ['--noprofile', '--norc', '-i'] })
    expect(defaultShellName('darwin')).toBe('zsh')
    expect(defaultShellName('linux')).toBe('bash')
  })

  it('accepts resolved positive bounds', () => {
    expect(() => { validateConfig(config()) }).not.toThrow()
  })

  it('rejects empty names, invalid numbers, and a read cap above retention', () => {
    expect(() => { validateConfig(config({ backendType: '' })) }).toThrow('backendType')
    expect(() => { validateConfig(config({ shellPath: '' })) }).toThrow('shellPath')
    expect(() => { validateConfig(config({ rows: 0 })) }).toThrow('rows')
    expect(() => { validateConfig(config({ rows: 1.5 })) }).toThrow('rows')
    expect(() => { validateConfig(config({ maxReadBytes: 2048 })) }).toThrow('must not exceed')
  })

  it('rejects a handoff grace shorter than one readiness poll', () => {
    expect(() => { validateConfig(config({ handoffGraceMs: 9, pollIntervalMs: 10 })) }).toThrow('handoffGraceMs must be at least pollIntervalMs')
    expect(() => { validateConfig(config({ handoffGraceMs: 10, pollIntervalMs: 10 })) }).not.toThrow()
  })

  it('accepts the prompt tail grace at zero and rejects negative or fractional values', () => {
    expect(() => { validateConfig(config({ promptTailGraceMs: 0 })) }).not.toThrow()
    expect(() => { validateConfig(config({ promptTailGraceMs: 2_000 })) }).not.toThrow()
    expect(() => { validateConfig(config({ promptTailGraceMs: -1 })) }).toThrow('promptTailGraceMs must be a non-negative safe integer')
    expect(() => { validateConfig(config({ promptTailGraceMs: 1.5 })) }).toThrow('promptTailGraceMs must be a non-negative safe integer')
  })

  it('accepts the prompt tail grace at zero or at least one readiness poll', () => {
    expect(() => { validateConfig(config({ promptTailGraceMs: 5, pollIntervalMs: 10 })) }).toThrow('promptTailGraceMs must be zero or at least pollIntervalMs')
    expect(() => { validateConfig(config({ promptTailGraceMs: 10, pollIntervalMs: 10 })) }).not.toThrow()
    expect(() => { validateConfig(config({ promptTailGraceMs: 0, pollIntervalMs: 10 })) }).not.toThrow()
  })

})

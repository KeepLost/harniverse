import { describe, expect, it } from 'vitest'
import {
  commandShellArgv,
  defaultCommandShellPath,
  defaultInteractiveShell,
  defaultShellName,
  isZshShell,
} from '../src/platform.ts'

describe('platform shell defaults', () => {
  it('selects zsh for macOS and Bash for other POSIX hosts', () => {
    expect(defaultCommandShellPath('darwin')).toBe('/bin/zsh')
    expect(defaultCommandShellPath('linux')).toBe('bash')
    expect(commandShellArgv('printf ok', 'darwin')).toEqual(['/bin/zsh', '-c', 'printf ok'])
    expect(commandShellArgv('printf ok', 'linux')).toEqual(['bash', '-c', 'printf ok'])
    expect(defaultInteractiveShell('darwin')).toEqual({ path: '/bin/zsh', args: ['-f', '-i'] })
    expect(defaultInteractiveShell('linux')).toEqual({ path: '/bin/bash', args: ['--noprofile', '--norc', '-i'] })
    expect(defaultShellName('darwin')).toBe('zsh')
    expect(defaultShellName('linux')).toBe('bash')
  })

  it('uses the current host by default and recognizes configured zsh paths', () => {
    const commandPath = process.platform === 'darwin' ? '/bin/zsh' : 'bash'
    const interactive = process.platform === 'darwin'
      ? { path: '/bin/zsh', args: ['-f', '-i'] }
      : { path: '/bin/bash', args: ['--noprofile', '--norc', '-i'] }
    expect(defaultCommandShellPath()).toBe(commandPath)
    expect(commandShellArgv('true')).toEqual([commandPath, '-c', 'true'])
    expect(defaultInteractiveShell()).toEqual(interactive)
    expect(defaultShellName()).toBe(process.platform === 'darwin' ? 'zsh' : 'bash')
    expect(isZshShell('/opt/homebrew/bin/zsh')).toBe(true)
    expect(isZshShell('/bin/bash')).toBe(false)
  })
})

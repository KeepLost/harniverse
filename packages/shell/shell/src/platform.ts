import { basename } from 'node:path'

/**
 * The shell executable used by one-shot local command execution on a host.
 * @param platform - Node platform identifier; defaults to the current host.
 * @returns The direct executable path or command name.
 */
export function defaultCommandShellPath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? '/bin/zsh' : 'bash'
}

/**
 * Build the direct argv for one-shot command execution without an intermediate shell.
 * @param command - Command text passed to the shell's `-c` option.
 * @param platform - Node platform identifier; defaults to the current host.
 * @returns The executable and arguments for direct spawning.
 */
export function commandShellArgv(command: string, platform: NodeJS.Platform = process.platform): readonly [string, '-c', string] {
  return [defaultCommandShellPath(platform), '-c', command]
}

/**
 * Default interactive shell settings for the local PTY backend.
 * @param platform - Node platform identifier; defaults to the current host.
 * @returns The shell path and no-rc interactive arguments.
 */
export function defaultInteractiveShell(platform: NodeJS.Platform = process.platform): { path: string; args: string[] } {
  return platform === 'darwin'
    ? { path: '/bin/zsh', args: ['-f', '-i'] }
    : { path: '/bin/bash', args: ['--noprofile', '--norc', '-i'] }
}

/**
 * Whether an explicitly configured shell path names zsh.
 * @param shellPath - Configured shell executable path.
 * @returns Whether its basename is `zsh`.
 */
export function isZshShell(shellPath: string): boolean {
  return basename(shellPath) === 'zsh'
}

/**
 * The shell dialect used by the platform default.
 * @param platform - Node platform identifier; defaults to the current host.
 * @returns The default shell dialect.
 */
export function defaultShellName(platform: NodeJS.Platform = process.platform): 'bash' | 'zsh' {
  return platform === 'darwin' ? 'zsh' : 'bash'
}

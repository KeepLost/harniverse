/**
 * Shell-backend resolution: the platform-and-preference mapping shared by the
 * boot bridge (which publishes the resolved selection as
 * `$DSH_SHELL_BACKEND` before the config tree mounts) and the `shell-backend`
 * settings namespace owner (`@deepseek-ai/dsh-shell-backend-settings`).
 * @module @deepseek-ai/dsh-shell
 */

/** User-selectable shell backend preference stored under the `shell-backend` settings namespace. */
export type ShellBackendPreference = 'platform-default' | 'git-bash'

/** The shell family a host composes after resolving the preference against the platform. */
export type ShellBackendSelection = 'bash' | 'pwsh'

/**
 * Resolve the composed shell family for one platform and preference: every
 * non-win32 platform composes the bash stack regardless of preference; win32
 * composes pwsh under the platform default and bash only under an explicit
 * `git-bash` preference (Git for Windows provides `bash`).
 * @param platform - Node platform identifier to resolve for.
 * @param preference - Stored user preference.
 * @returns The shell family that platform composes.
 */
export function resolveShellBackend(platform: NodeJS.Platform, preference: ShellBackendPreference): ShellBackendSelection {
  if (platform === 'win32') return preference === 'git-bash' ? 'bash' : 'pwsh'
  return 'bash'
}

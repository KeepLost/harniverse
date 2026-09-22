/** Shell selection and executable verification use the target execution provider. */
import { defaultInteractiveShell } from '@deepseek-ai/dsh-shell'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { TerminalShell } from './types.ts'

/**
 * Resolve the configured shell or the platform's default user shell.
 *
 * These terminals are the USER's own system-user terminals, so the default
 * profile starts the shell exactly as an interactive login session would:
 * bash and zsh load their startup files (`-l -i`), fish runs interactively,
 * PowerShell shows no logo banner while profiles load, and cmd needs no
 * arguments. An explicitly configured shell overrides discovery entirely.
 * @param subprocess - target execution provider.
 * @param configured - optional profile overriding the platform default shell.
 * @param signal - resolution cancellation.
 * @returns one verified shell; a declared default that cannot resolve rejects.
 */
export async function resolveShell(
  subprocess: SubprocessRuntime, configured: TerminalShell | undefined, signal: AbortSignal,
): Promise<TerminalShell> {
  let shell = configured
  if (shell === undefined) {
    shell = profile(defaultInteractiveShell().path)
  }
  const path = await subprocess.resolveExecutable(shell.path, undefined, signal)
  return { ...shell, path }
}

/**
 * Build the user-startup profile for one shell executable: login and
 * interactive arguments for bash/zsh, interactive-only for fish, `-NoLogo`
 * (profiles still load) for PowerShell, and none for cmd.
 * @param path - executable path or PATH name.
 * @returns the shell profile with its user-startup arguments.
 */
function profile(path: string): TerminalShell {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const kind = name.toLowerCase().replace(/\.exe$/u, '')
  return {
    path,
    name,
    args: kind === 'cmd' ? [] : kind === 'pwsh' || kind === 'powershell' ? ['-NoLogo']
      : kind === 'fish' ? ['-i'] : ['-l', '-i'],
  }
}

/**
 * List verified candidates after the configured or platform-default shell.
 * @param subprocess - target execution provider.
 * @param configured - optional default profile.
 * @param candidates - executable names or paths permitted for shell selection.
 * @param signal - discovery cancellation.
 * @returns unique installed shells, with the default first; transport failures reject.
 */
export async function discoverShells(
  subprocess: SubprocessRuntime, configured: TerminalShell | undefined,
  candidates: readonly string[], signal: AbortSignal,
): Promise<TerminalShell[]> {
  const preferred = await resolveShell(subprocess, configured, signal)
  const found = await Promise.all(candidates.map(async (candidate) => {
    try { return await resolveShell(subprocess, profile(candidate), signal) }
    catch {
      // Harniverse's subprocess seam has no typed executable-not-found error,
      // so an absent candidate is indistinguishable from a refused lookup:
      // every resolution failure skips the candidate and only transport-level
      // failures of the PREFERRED shell reject discovery as a whole.
      return undefined
    }
  }))
  const shells = new Map<string, TerminalShell>()
  for (const shell of [preferred, ...found]) {
    if (shell === undefined) continue
    const key = shell.path.includes('\\') ? shell.path.toLowerCase() : shell.path
    if (!shells.has(key)) shells.set(key, shell)
  }
  return [...shells.values()]
}

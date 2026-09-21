/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { accessSync, constants as fsConstants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-landlock-run'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/**
 * Resolve a runner program to an absolute path, so the confined argv is
 * spawnable verbatim even under a caller-built environment with no `PATH`
 * (the fresh-process code runtime's empty child environment). Absolute
 * inputs pass through; an unresolvable name falls through unchanged and the
 * functional probe decides usability.
 * @param program - the runner program name or override path.
 * @returns the absolute path when the program is executable on the launch
 * `PATH`, else the input unchanged.
 */
export function resolveRunnerProgram(program: string): string {
  if (isAbsolute(program)) return program
  const searchPath = process.env.PATH ?? ''
  for (const dir of searchPath.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, program)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return program
}

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}

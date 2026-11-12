/** Shell-backend vocabulary shared by the boot bridge, the router, and the settings namespace. */
import type { ShellRegistryDocument } from './registry.ts'
import { registryEntryIndex } from './registry.ts'

/** Environment variable the boot bridge publishes the resolved stack to. */
export const SHELL_BACKEND_ENV = 'DSH_SHELL_BACKEND'

/** Environment variable the boot bridge publishes the default entry's executable to. */
export const SHELL_DEFAULT_PATH_ENV = 'DSH_SHELL_DEFAULT_PATH'

/** The two composed executor stacks a shell selection can address. */
export type ShellBackendSelection = 'bash' | 'pwsh'

/**
 * Stored stack-level preference: the platform default, or an explicit stack
 * honored on EVERY platform (`bash` selects the POSIX stack — Git Bash on
 * win32; `pwsh` selects the PowerShell stack).
 */
export type ShellBackendPreference = 'platform-default' | 'bash' | 'pwsh'

/**
 * Resolve the stack a platform composes for one stored preference. An explicit
 * stack wins on every platform; the platform default splits win32→pwsh,
 * everything else→bash.
 * @param platform - Node platform identifier to resolve for.
 * @param preference - Stored stack-level preference.
 * @returns The shell family that platform composes.
 */
export function resolveShellBackend(platform: NodeJS.Platform, preference: ShellBackendPreference): ShellBackendSelection {
  if (preference === 'bash' || preference === 'pwsh') return preference
  return platform === 'win32' ? 'pwsh' : 'bash'
}

/**
 * Resolve the stack one registry default addresses, for boot-time composition
 * gating: `platform-default` splits by platform, a builtin id addresses its
 * own stack, and a custom entry id addresses the stack its executable's
 * dialect class routes to.
 * @param platform - Node platform identifier to resolve for.
 * @param document - resolved shell-registry settings document.
 * @returns The stack the registry default composes.
 */
export function resolveRegistryDefaultStack(platform: NodeJS.Platform, document: ShellRegistryDocument): ShellBackendSelection {
  if (document.default === 'platform-default') return resolveShellBackend(platform, 'platform-default')
  const entry = registryEntryIndex(platform, document).get(document.default)
  if (entry === undefined) return resolveShellBackend(platform, 'platform-default')
  return entry.stack
}

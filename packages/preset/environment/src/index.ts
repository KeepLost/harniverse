/**
 * The environment-facts system section: the OS, shell, working machine, and
 * the session-fixed working directory, as static system-prompt prose.
 *
 * The row contributes one prompt section whose text is computed once at mount
 * from process-stable platform facts. Only the working directory stays a
 * `{{cwd}}` reference, resolved per agent at render time from the session
 * header — fixed for the session's lifetime, never refreshed per turn.
 * @module @deepseek-ai/dsh-environment
 */

import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { EnvironmentFacts } from './types.ts'

export type { EnvironmentFacts } from './types.ts'

/** Cordis plugin name. */
export const name = 'environment'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/** The contributed section's registry name. */
export const ENVIRONMENT_SECTION = 'environment:facts'

/** Prompt order: after the harness identity (−100), before tool guidance (100+). */
export const ENVIRONMENT_ORDER = -90

/** Whether this Linux host runs the BusyBox (Alpine) userland rather than GNU. */
const busyboxUserland = (): boolean => existsSync('/etc/alpine-release')

/**
 * Detect the process-stable environment facts for one machine.
 *
 * The shell fact follows the harness's own execution selection: `zsh` on
 * macOS, PowerShell on Windows, `bash` elsewhere.
 * @param platform - Node platform identifier; defaults to the current host.
 * @param machine - working-machine label; defaults to the host name.
 * @param busybox - Linux probe for a BusyBox (Alpine) userland.
 * @returns the coarse OS, shell, optional userland, and machine label.
 */
export function detectEnvironmentFacts(
  platform: NodeJS.Platform = process.platform,
  machine: string = hostname(),
  busybox: () => boolean = busyboxUserland,
): EnvironmentFacts {
  const os = platform === 'darwin' ? 'macOS'
    : platform === 'win32' ? 'Windows'
      : platform === 'linux' ? 'Linux' : platform
  const shell = platform === 'darwin' ? 'zsh' : platform === 'win32' ? 'PowerShell' : 'bash'
  const userland = platform === 'darwin' ? 'BSD'
    : platform === 'linux' ? (busybox() ? 'BusyBox' : 'GNU')
      : undefined
  return { os, shell, ...userland === undefined ? {} : { userland }, machine }
}

/**
 * Render the section prose for one machine's facts.
 * @param facts - the detected environment facts.
 * @returns the section text; `{{cwd}}` interpolates per agent at render time.
 */
export function environmentSectionText(facts: EnvironmentFacts): string {
  const userland = facts.userland === undefined ? '' : ` with a ${facts.userland} userland`
  return `You are working on the machine ${facts.machine} (${facts.os}, ${facts.shell} shell${userland}). `
    + 'The working directory for this session is {{cwd}}; it stays fixed for the session\'s lifetime.'
}

/**
 * Register the environment-facts section for the mounting context's scope.
 * @param ctx - the mounting context; an agent preset scope is the intended seat.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: ENVIRONMENT_SECTION,
    order: ENVIRONMENT_ORDER,
    text: environmentSectionText(detectEnvironmentFacts()),
  }), 'environment.section()')
}

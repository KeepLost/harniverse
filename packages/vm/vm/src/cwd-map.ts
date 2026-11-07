/**
 * Session-cwd world mapping for the vm execution world: a host composition
 * resolves relative tool paths against the session's effective directory, but
 * the world's filesystem only knows its own `/workspace` layout. The boot
 * bridge anchors the host workspace root (the launch directory) through
 * {@link HOST_WORKSPACE_ROOT_ENV}; cwds under it map one-to-one into the
 * world, world-absolute cwds pass through, and any other host path fails
 * closed with an actionable diagnosis instead of an opaque in-world miss.
 * @module @deepseek-ai/dsh-vm/cwd-map
 */

import { normalize, resolve as posixResolve } from 'node:path/posix'

/** Boot-fact env var carrying the host workspace root for the vm world. */
export const HOST_WORKSPACE_ROOT_ENV = 'DSH_VM_HOST_WORKSPACE_ROOT'

/** The world-side workspace mount every vm world provides. */
export const WORLD_WORKSPACE_ROOT = '/workspace'

/** One session-cwd mapping outcome. */
export type WorldCwdResult =
  | { kind: 'world'; path: string }
  | { kind: 'foreign'; cwd: string; hostRoot: string }

/** @returns the anchored host workspace root, or undefined when the boot bridge did not set one. */
export function hostWorkspaceRootFromEnv(env: Record<string, string | undefined>): string | undefined {
  const root = env[HOST_WORKSPACE_ROOT_ENV]?.trim()
  if (root === undefined || root.length === 0) return undefined
  return normalize(root)
}

/**
 * Classify one session cwd against the anchored roots.
 * @param cwd - the session's effective directory, as the host recorded it.
 * @param hostRoot - the anchored host workspace root; undefined keeps every
 *   cwd untouched (a composition without the boot bridge behaves as before).
 * @param worldRoot - the world's workspace mount; overridable for tests.
 * @returns `world` with the in-world path when the cwd is under either root;
 *   `foreign` when an anchored composition cannot honor the host path.
 */
export function mapSessionCwdToWorld(cwd: string, hostRoot: string | undefined, worldRoot = WORLD_WORKSPACE_ROOT): WorldCwdResult {
  if (hostRoot === undefined) return { kind: 'world', path: normalize(cwd) }
  const absolute = posixResolve(normalize(cwd))
  const root = normalize(hostRoot)
  if (absolute === root) return { kind: 'world', path: worldRoot }
  if (absolute.startsWith(`${root}/`)) return { kind: 'world', path: normalize(`${worldRoot}/${absolute.slice(root.length + 1)}`) }
  const mount = normalize(worldRoot)
  if (absolute === mount || absolute.startsWith(`${mount}/`)) return { kind: 'world', path: absolute }
  return { kind: 'foreign', cwd: absolute, hostRoot: root }
}

/** Narrow desktop contracts; Host business capabilities remain in the shared Web client. */

/** The local profile is fixed by the distribution; renderer input cannot configure a process. */
export type ConnectionProfile = { kind: 'local' } | { kind: 'existingHost'; url: string }

/** Only a child created by this shell has owned lifecycle and local-path authority. */
export type HostOwnership = 'owned' | 'external'

/** Unknown observation is never represented as idle. */
export type ShellActivity =
  | { status: 'unknown' }
  | { status: 'idle' | 'active'; sessions: number; tasks: number }

/** Public connection state excludes bootstrap credentials, process arguments and secrets. */
export interface ShellState {
  phase: 'disconnected' | 'connecting' | 'ready' | 'failed'
  profile?: ConnectionProfile
  ownership?: HostOwnership
  activity: ShellActivity
  message?: string
}

/** A selected path belongs only to the shell-owned local Host. */
export type DirectorySelection = { kind: 'selected'; path: string } | { kind: 'cancelled' }

/** Shell-page operations have fixed channels and never accept arbitrary IPC or process commands. */
export interface DesktopBridge {
  state(): Promise<ShellState>
  connect(profile: ConnectionProfile): Promise<void>
  disconnect(): Promise<void>
  quit(): Promise<void>
}

/** Shared Web preload exposes only the native directory capability. */
export interface DesktopDirectoryBridge {
  pickDirectory(): Promise<DirectorySelection>
}

/** Fixed IPC identifiers shared by main and bundled sandbox preloads. */
export const DESKTOP_IPC = {
  state: 'harniverse:desktop:state',
  connect: 'harniverse:desktop:connect',
  disconnect: 'harniverse:desktop:disconnect',
  quit: 'harniverse:desktop:quit',
  pickDirectory: 'harniverse:desktop:pick-directory',
  authWeb: 'harniverse:desktop:auth-web',
} as const

/** The preload bootstrap never exports the private browser key through contextBridge. */
export type AuthWebRequest = { kind: 'inspect' | 'complete' } | { kind: 'enroll'; publicKey: string }

/** One local enrollment is admitted per owned child; existing Hosts use the shared authentication UI. */
export type AuthWebReply = { kind: 'ordinary' } | { kind: 'enroll' } | { kind: 'approved'; grantId: string; name: string }

/**
 * Validate an existing Host origin without inferring filesystem ownership from loopback.
 * @param value - untrusted origin from the connection form.
 * @returns the canonical URL with a root path.
 */
export function validateHostUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/u.test(value)) {
    throw new TypeError('Enter an HTTPS Host origin or a loopback HTTP origin.')
  }
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username !== '' || url.password !== '' || url.pathname !== '/'
    || url.search !== '' || url.hash !== '') {
    throw new TypeError('Use an HTTPS Host origin, or loopback HTTP, without credentials, paths, queries or fragments.')
  }
  return url.href
}

/**
 * Parse the complete renderer connection request; extra fields are rejected.
 * @param value - IPC payload.
 * @returns a validated connection profile.
 */
export function parseConnectionProfile(value: unknown): ConnectionProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid connection profile.')
  const record = value as Record<string, unknown>
  if (record.kind === 'local' && Object.keys(record).length === 1) return { kind: 'local' }
  if (record.kind === 'existingHost' && Object.keys(record).length === 2 && Object.hasOwn(record, 'url')) {
    return { kind: 'existingHost', url: validateHostUrl(record.url) }
  }
  throw new TypeError('Invalid connection profile.')
}

/** Current document authority; file pages use exact URL equality because their origin is opaque. */
export type RendererAuthority = { kind: 'shell'; url: string } | { kind: 'web'; origin: string }

interface FrameIdentity { readonly url: string; readonly origin: string }
interface WindowIdentity { readonly mainFrame: FrameIdentity }

/**
 * Reject non-owned windows, subframes, inherited origins and stale documents.
 * @param event - Electron invoke event.
 * @param owner - the sole live BrowserWindow's WebContents.
 * @param authority - the currently admitted shell document or Host origin.
 */
export function assertShellSender(
  event: { sender: WindowIdentity; senderFrame: FrameIdentity | null },
  owner: WindowIdentity,
  authority: RendererAuthority,
): void {
  const frame = event.senderFrame
  if (event.sender !== owner || frame === null || frame !== owner.mainFrame) throw new Error('Desktop IPC requires the owned main frame.')
  if (authority.kind === 'shell') {
    if (frame.url !== authority.url) throw new Error('Desktop IPC requires the shell page.')
    return
  }
  const url = new URL(frame.url)
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== authority.origin || frame.origin !== authority.origin) {
    throw new Error('Desktop IPC requires the active Host origin.')
  }
}

/**
 * Explain activity loss without claiming that an external Host stops with the shell.
 * @param ownership - lifecycle authority of the active connection.
 * @param activity - latest Host observation.
 * @returns a confirmation detail, or undefined for a known idle connection.
 */
export function quitWarning(ownership: HostOwnership, activity: ShellActivity): string | undefined {
  if (activity.status === 'idle') return undefined
  if (ownership === 'external') return 'The connected Host continues running after this window closes. Active work stays on that Host.'
  if (activity.status === 'unknown') return 'Activity information is unavailable. Quitting will stop the local Host and may interrupt active work.'
  return `The local Host has ${String(activity.sessions)} active sessions and ${String(activity.tasks)} running tasks. Quitting will stop the Host and interrupt that work.`
}

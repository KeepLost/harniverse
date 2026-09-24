/**
 * Browser executable discovery and process launch. The browser is an ordinary
 * metered child of the harness: it goes through the subprocess seam like every
 * other spawn, so process-tree termination, correlation, and environment
 * scrubbing behave exactly as they do for a shell command.
 */
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Executables probed when no path is configured, in preference order. */
export const DEFAULT_BROWSER_CANDIDATES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
] as const

/**
 * The line Chromium prints on stderr once its DevTools endpoint is listening.
 * The terminator is part of the pattern on purpose: `$` under `m` also matches
 * the end of the input, so an unterminated pattern accepts whatever prefix of
 * the endpoint the current stderr chunk happens to carry. The tail of that URL
 * is the browser's own session id, so a half-read endpoint addresses no target
 * and the browser refuses the socket.
 */
const ENDPOINT_PATTERN = /^DevTools listening on (ws:\/\/\S+)\r?\n/mu

/** How many trailing diagnostic characters a failed launch reports. */
const DIAGNOSTIC_LIMIT = 800

/**
 * Sandbox selection. `'auto'` resolves against the harness's own privilege,
 * `'chromium'` demands the sandbox, and `'none'` always passes `--no-sandbox`.
 */
export type BrowserSandbox = 'auto' | 'chromium' | 'none'

/**
 * Decide whether this launch must pass `--no-sandbox`.
 *
 * Chromium's zygote refuses to start as root unless the flag is present, so a
 * root harness has no sandboxed alternative to fall back on: `'auto'` disables
 * the sandbox exactly there and keeps it everywhere else.
 * @param sandbox - operator selection.
 * @param uid - effective user id, or undefined where the platform has none.
 * @returns whether `--no-sandbox` belongs on the command line.
 */
export function sandboxDisabled(sandbox: BrowserSandbox, uid: number | undefined): boolean {
  if (sandbox === 'none') return true
  if (sandbox === 'chromium') return false
  return uid === 0
}

/** A launch that never reported a DevTools endpoint, with what the browser said. */
export class BrowserLaunchFailure extends Error {
  /**
   * @param message - what the launch failed to reach.
   * @param diagnostics - trailing browser diagnostic output, possibly empty.
   */
  constructor(message: string, readonly diagnostics: string) {
    super(diagnostics === '' ? message : `${message}: ${diagnostics}`)
    this.name = 'BrowserLaunchFailure'
  }
}

/** One launched browser process and the endpoint that drives it. */
export interface LaunchedBrowser {
  /** `ws://` DevTools endpoint of the browser target. */
  readonly endpoint: string
  /** Process handle owning the browser's process tree. */
  readonly handle: SubprocessHandle
}

/** Everything one launch needs; the controller resolves each value from config. */
export interface BrowserLaunchSpec {
  readonly subprocess: SubprocessRuntime
  /** Verified executable path. */
  readonly executablePath: string
  /** Working directory for the browser process. */
  readonly cwd: string
  /** Private profile directory; the browser owns it exclusively. */
  readonly profileDir: string
  readonly width: number
  readonly height: number
  /** Whether Chromium's own sandbox stays enabled; see {@link sandboxDisabled}. */
  readonly sandbox: BrowserSandbox
  /** Effective user id of the harness, or undefined where the platform has none. */
  readonly uid: number | undefined
  /** Termination grace for the browser process tree. */
  readonly graceMs: number
  /** Metering identity of the owning Session. */
  readonly sessionId: string
  /** How long to wait for the DevTools endpoint line. */
  readonly launchTimeoutMs: number
  readonly signal: AbortSignal
  /** Retain the tree before endpoint discovery, including when cleanup cannot confirm its exit. */
  readonly onSpawn: (handle: SubprocessHandle) => void
}

/**
 * Resolve the browser executable for this execution environment.
 * @param subprocess - target execution provider.
 * @param configured - operator-configured path, or undefined to probe candidates.
 * @param candidates - executable names or paths probed when nothing is configured.
 * @param signal - resolution cancellation.
 * @returns the verified path, or undefined when no candidate resolves.
 */
export async function resolveBrowserExecutable(
  subprocess: SubprocessRuntime, configured: string | undefined,
  candidates: readonly string[], signal: AbortSignal,
): Promise<string | undefined> {
  const probes = configured === undefined ? candidates : [configured]
  for (const candidate of probes) {
    try {
      return await subprocess.resolveExecutable(candidate, undefined, signal)
    } catch {
      // The subprocess seam has no typed executable-not-found error, so an
      // absent browser is indistinguishable from a refused lookup: every
      // failure moves on to the next candidate and an exhausted list is
      // reported as an unavailable surface rather than a crash.
      continue
    }
  }
  return undefined
}

/**
 * Build the browser's command line. Everything here is either required for
 * remote control (the debugging port and the private profile) or removes a
 * behaviour that makes no sense for a streamed, user-driven page (first-run
 * dialogs, the default-browser prompt, audio, scrollbar chrome).
 * @param spec - resolved launch parameters.
 * @returns the complete argv.
 */
export function browserArgv(spec: BrowserLaunchSpec): string[] {
  return [
    spec.executablePath,
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${spec.profileDir}`,
    `--window-size=${spec.width},${spec.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    // The disposable macOS profile uses a mock keychain instead of prompting
    // for access to the user's Keychain; its cookies are not Keychain-protected.
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    ...(sandboxDisabled(spec.sandbox, spec.uid) ? ['--no-sandbox'] : []),
    'about:blank',
  ]
}

/**
 * Launch one browser process and wait for its DevTools endpoint. Failure stops
 * and drains the tree; the caller retains its handle for a failed exit wait.
 * @param spec - resolved launch parameters.
 * @returns the endpoint and the owning process handle.
 */
export async function launchBrowser(spec: BrowserLaunchSpec): Promise<LaunchedBrowser> {
  const handle = spec.subprocess.spawn({
    argv: browserArgv(spec),
    cwd: spec.cwd,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: spec.graceMs,
    signal: spec.signal,
    // The browser is a harness-owned utility process rather than the user's
    // own shell: it starts from the scrubbed environment so page-facing
    // software never inherits the harness's credentials.
    ambientEnv: 'scrubbed',
    correlation: { sessionId: spec.sessionId, commandId: 'browser-controller', kind: 'other' },
  })
  // A spawn-level failure can settle done before endpoint discovery observes stderr.
  void handle.done.catch(() => undefined)
  try {
    spec.onSpawn(handle)
    const endpoint = await readEndpoint(handle, spec.launchTimeoutMs, spec.signal)
    return { endpoint, handle }
  } catch (error) {
    handle.terminate()
    // The caller retains the handle through onSpawn if tree quiescence fails.
    let exited: boolean
    try {
      exited = await handle.waitForExit()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        `${String(error)}; browser cleanup failed: ${String(cleanupError)}`)
    }
    if (!exited) throw new AggregateError([error], `${String(error)}; browser tree did not exit`)
    await handle.done.catch(() => undefined)
    throw error
  }
}

/**
 * Read the DevTools endpoint from the browser's stderr.
 * @param handle - launched process handle.
 * @param timeoutMs - how long to wait for the endpoint line.
 * @param signal - launch cancellation.
 * @returns the `ws://` endpoint.
 */
function readEndpoint(handle: SubprocessHandle, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const stderr = handle.stderr
  if (stderr === undefined) {
    return Promise.reject(new BrowserLaunchFailure('The browser process exposed no diagnostic stream', ''))
  }
  return new Promise<string>((resolve, reject) => {
    let buffered = ''
    // A refused launch explains itself on stderr and nowhere else, so the tail
    // of that stream is the only actionable part of the failure the user sees.
    const diagnostics = (): string => buffered.trim().slice(-DIAGNOSTIC_LIMIT)
    const timer = setTimeout(() => {
      settle()
      reject(new BrowserLaunchFailure(
        `The browser did not report a DevTools endpoint within ${timeoutMs}ms`, diagnostics(),
      ))
    }, timeoutMs)
    const onData = (chunk: Buffer | string): void => {
      buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const match = ENDPOINT_PATTERN.exec(buffered)
      if (match?.[1] === undefined) return
      settle()
      resolve(match[1])
    }
    const onEnd = (): void => {
      settle()
      reject(new BrowserLaunchFailure(
        'The browser process exited before reporting a DevTools endpoint', diagnostics(),
      ))
    }
    const onAbort = (): void => {
      settle()
      reject(new BrowserLaunchFailure('The browser launch was aborted', ''))
    }
    const settle = (): void => {
      clearTimeout(timer)
      stderr.off('data', onData)
      stderr.off('end', onEnd)
      stderr.off('close', onEnd)
      signal.removeEventListener('abort', onAbort)
    }
    stderr.on('data', onData)
    stderr.on('end', onEnd)
    stderr.on('close', onEnd)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

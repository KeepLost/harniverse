/**
 * System-proxy detection for the network-proxy settings page, in the shape the
 * reference community plugin established: valid HTTP(S) values from the launch
 * environment first (a snapshot, so the proxy this plugin installs never feeds
 * back into detection), then the platform's own settings — the Windows
 * current-user Internet Settings registry keys and macOS `scutil --proxy`.
 * Linux resolves from the environment alone. SOCKS, PAC, and WPAD are not
 * supported and never reported as a detected proxy.
 */
import type { EnvLookup } from '@deepseek-ai/dsh-http-proxy'

/** What detection needs from its host: the platform, the launch environment snapshot, and a command runner. */
export interface DetectDeps {
  /** `process.platform` of the detecting process. */
  readonly platform: NodeJS.Platform
  /** The launch environment snapshot; never the live `process.env`. */
  readonly env: EnvLookup
  /**
   * Run one platform command. Resolves `undefined` when the command is missing or fails —
   * detection then reports no proxy rather than an error, matching the launch policy's
   * skip-don't-fail posture.
   */
  readonly run: (command: string, args: readonly string[]) => Promise<{ stdout: string } | undefined>
}

/** One detection answer: where the proxy URL came from, and the URL when there is one. */
export interface DetectionResult {
  /** `env` for a launch variable, `os` for a platform setting, `none` when nothing usable was found. */
  readonly source: 'env' | 'os' | 'none'
  /** The detected proxy URL; absent when nothing usable was found. */
  readonly url?: string
}

/** Environment names detection reads, uppercase first to mirror the launch policy's own preference. */
const DETECT_ENV_NAMES = [
  'HTTPS_PROXY', 'https_proxy',
  'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy',
] as const

/** A detection candidate is usable only when it parses as an absolute http(s) URL. */
function usableHttpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.href
  } catch {
    return undefined
  }
}

/** First usable HTTP(S) proxy URL in the launch snapshot, in HTTPS → HTTP → ALL order. */
function fromEnvironment(env: EnvLookup): string | undefined {
  for (const name of DETECT_ENV_NAMES) {
    const entry = env.get(name)
    if (entry === undefined) continue
    const url = usableHttpUrl(entry.value)
    if (url !== undefined) return url
  }
  return undefined
}

/**
 * Read one `reg query` value line: `    ProxyEnable    REG_DWORD    0x1`.
 * @returns the trailing token after the type column, or `undefined` when absent.
 */
function regValue(stdout: string, name: string): string | undefined {
  const line = stdout.split(/\r?\n/).find(entry => entry.trimStart().startsWith(name))
  const columns = line?.trim().split(/\s+/)
  return columns !== undefined && columns.length >= 3 ? columns[columns.length - 1] : undefined
}

/** The Windows current-user Internet Settings proxy, from two `reg query` reads. */
async function fromWindows(
  run: DetectDeps['run'],
): Promise<string | undefined> {
  const settings = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'])
  if (settings === undefined) return undefined
  if (regValue(settings.stdout, 'ProxyEnable') !== '0x1') return undefined
  const raw = regValue(settings.stdout, 'ProxyServer')
  if (raw === undefined) return undefined
  // `host:port` serves every protocol; `http=host:port;https=host:port` names one per protocol.
  if (!raw.includes('=')) return usableHttpUrl(`http://${raw}`)
  const perProtocol = raw.split(';').map(entry => entry.split('=') as [string, string])
  const https = perProtocol.find(([scheme]) => scheme === 'https')
  const http = perProtocol.find(([scheme]) => scheme === 'http')
  const chosen = https ?? http
  return chosen === undefined ? undefined : usableHttpUrl(`http://${chosen[1]}`)
}

/** The macOS system proxy, from `scutil --proxy`. */
async function fromMacOS(
  run: DetectDeps['run'],
): Promise<string | undefined> {
  const scutil = await run('scutil', ['--proxy'])
  if (scutil === undefined) return undefined
  const enabled = (key: string): boolean => scutil.stdout.includes(`${key} : 1`)
  const value = (key: string): string | undefined => {
    const line = scutil.stdout.split(/\r?\n/).find(entry => entry.trimStart().startsWith(key))
    const trimmed = line?.trim()
    return trimmed === undefined ? undefined : trimmed.split(/\s*:\s*/)[1]
  }
  if (enabled('HTTPSEnable')) {
    const host = value('HTTPSProxy')
    const port = value('HTTPSPort')
    if (host !== undefined && host !== '' && port !== undefined) return usableHttpUrl(`http://${host}:${port}`)
  }
  if (enabled('HTTPEnable')) {
    const host = value('HTTPProxy')
    const port = value('HTTPPort')
    if (host !== undefined && host !== '' && port !== undefined) return usableHttpUrl(`http://${host}:${port}`)
  }
  return undefined
}

/**
 * Detect the system proxy: launch environment first, then platform settings.
 * @param deps - platform, launch environment snapshot, and command runner.
 * @returns where the answer came from and the proxy URL, or `none`.
 */
export async function detectSystemProxy(deps: DetectDeps): Promise<DetectionResult> {
  const fromEnv = fromEnvironment(deps.env)
  if (fromEnv !== undefined) return { source: 'env', url: fromEnv }
  if (deps.platform === 'win32') {
    const url = await fromWindows(deps.run)
    if (url !== undefined) return { source: 'os', url }
  } else if (deps.platform === 'darwin') {
    const url = await fromMacOS(deps.run)
    if (url !== undefined) return { source: 'os', url }
  }
  return { source: 'none' }
}

/** Interpret the fixed connectivity probe's stdout as a deployable target platform. */
import type { RemoteArchitecture, RemotePlatform } from './types.ts'
import { RemoteHostsError } from './validation.ts'

/** Detected remote platform and architecture. */
export interface DetectedTarget { platform: RemotePlatform; architecture: RemoteArchitecture }

const platforms: Record<string, RemotePlatform> = {
  linux: 'linux', darwin: 'darwin',
  windows: 'win32', win32: 'win32',
}
const architectures: Record<string, RemoteArchitecture> = {
  x86_64: 'x64', amd64: 'x64', x64: 'x64',
  arm64: 'arm64', aarch64: 'arm64',
}

/** Read one probe token as a platform name.
 * @param token - one whitespace-separated lowercase probe token.
 * @returns the platform the token names, when it names one.
 */
function platform(token: string): RemotePlatform | undefined {
  const name = token.replace(/\.exe$/, '')
  if (platforms[name] !== undefined) return platforms[name]
  // `[Environment]::OSVersion.Platform` answers the `Win32NT` family; a Windows
  // POSIX shell answers `MINGW64_NT-10.0`, `MSYS_NT-…` or `CYGWIN_NT-…` instead.
  if (/^win32(nt|windows|s)$/.test(name) || /^(mingw|msys|cygwin)/.test(name)) return 'win32'
  return undefined
}

/** Map one probe answer onto a deployable target.
 * @param output - stdout of the fixed connectivity probe.
 * @returns the platform and architecture the target reported.
 */
export function detect(output: string): DetectedTarget {
  const tokens = output.toLowerCase().split(/\s+/).filter(token => token !== '')
  const platformName = tokens.map(platform).find(candidate => candidate !== undefined)
  const architectureName = tokens.map(token => architectures[token.replace(/\.exe$/, '')])
    .find(candidate => candidate !== undefined)
  if (platformName === undefined || architectureName === undefined) throw new RemoteHostsError('UNSUPPORTED_REMOTE_PLATFORM')
  return { platform: platformName, architecture: architectureName }
}

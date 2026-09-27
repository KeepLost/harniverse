import { posix, win32 } from 'node:path'
import type { RemotePlatform } from './types.ts'
import { RemoteHostsError } from './validation.ts'

export function quote(platform: RemotePlatform, value: string): string {
  if (/\x00/.test(value)) throw new RemoteHostsError('INVALID_REMOTE_PATH')
  return platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
}
export function command(platform: RemotePlatform, script: string): string {
  return platform === 'win32'
    ? `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(`$ErrorActionPreference='Stop'; ${script}`, 'utf16le').toString('base64')}`
    : script
}
export function remoteHome(platform: RemotePlatform, realHome: string, configured?: string): string {
  let home = configured ?? (platform === 'win32' ? `${realHome.replace(/\/$/, '')}/.dsh` : posix.join(realHome, '.dsh'))
  if (platform === 'win32') home = home.replace(/^\/([A-Za-z]:\/)/, '$1').replaceAll('\\', '/')
  const paths = platform === 'win32' ? win32 : posix
  const normalized = paths.normalize(home)
  if (!paths.isAbsolute(home) || normalized === paths.parse(normalized).root || /[\x00-\x1f]/.test(home)) {
    throw new RemoteHostsError('INVALID_REMOTE_HOME')
  }
  return home.replace(/\/$/, '')
}
export function nodeCommand(platform: RemotePlatform, release: string, home: string, script: string, app = false): string {
  const q = (value: string) => quote(platform, value)
  const node = `${release}/${platform === 'win32' ? 'node.exe' : 'node'}`
  return command(platform, platform === 'win32'
    ? `$env:DSH_HOME=${q(home)}; $env:NODE_OPTIONS=''; $env:NODE_PATH=''; $utf8=New-Object Text.UTF8Encoding($false); [Console]::InputEncoding=$utf8; [Console]::OutputEncoding=$utf8; $OutputEncoding=$utf8; $data=[Console]::In.ReadToEnd(); Set-Location -LiteralPath ${q(app ? `${release}/app` : release)}; $data | & ${q(node)} --input-type=module -e ${q(script)}; exit $LASTEXITCODE`
    : `cd ${q(app ? `${release}/app` : release)} && env DSH_HOME=${q(home)} NODE_OPTIONS='' NODE_PATH='' ${q(node)} --input-type=module -e ${q(script)}`)
}

/** Deployment owns files and startup; transport teardown never owns the remote process. */
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { RemoteHostSshConnection } from '@deepseek-ai/dsh-remote-hosts-ssh'
import type { Artifact } from './artifact.ts'
import type { HostRecord, RemoteHostProgress } from './types.ts'
import { command, nodeCommand, quote } from './platform.ts'
import { RemoteHostsError } from './validation.ts'

async function execute(connection: RemoteHostSshConnection, cmd: string, input?: string, signal?: AbortSignal): Promise<string> {
  const result = await connection.exec(cmd, input, signal)
  if (result.exitCode !== 0 || result.signal !== null) throw new RemoteHostsError('REMOTE_COMMAND_FAILED')
  return result.stdout.toString('utf8')
}

const VERIFY = `import {createHash} from 'node:crypto'; import {createReadStream} from 'node:fs';
import {lstat,chmod,readdir} from 'node:fs/promises'; import {resolve,dirname} from 'node:path';
let input=''; for await(const c of process.stdin) input+=c; const files=JSON.parse(input);
const allowed=new Set(files.map(f=>f.path));async function visit(dir=''){for(const e of await readdir(dir||'.',{withFileTypes:true})){
const p=dir?dir+'/'+e.name:e.name;if(e.isDirectory())await visit(p);else if(!e.isFile()||!allowed.has(p))throw Error('unexpected entry');}}
await visit();
for(const f of files){const p=resolve(f.path); for(let d=dirname(p);d!==process.cwd();d=dirname(d)){
if(d===dirname(d)||(await lstat(d)).isSymbolicLink())throw Error('invalid directory');}
const st=await lstat(p); if(!st.isFile()||st.isSymbolicLink()||st.size!==f.bytes)throw Error('invalid file');
const h=createHash('sha256');for await(const c of createReadStream(p))h.update(c);
if(h.digest('hex')!==f.sha256)throw Error('digest mismatch'); if(process.platform!=='win32')await chmod(p,f.mode);}
process.stdout.write('verified');`

function privateDirectories(host: HostRecord, paths: string[], root: string): string {
  const q = (value: string) => quote(host.platform, value)
  const ancestors = new Set<string>()
  for (const path of paths) {
    for (let current = path; current !== '/' && current !== '.' && !/^[A-Za-z]:$/.test(current); current = posix.dirname(current)) {
      ancestors.add(current)
      if (current === root) break
    }
  }
  const ordered = [...ancestors].sort((a, b) => a.length - b.length)
  if (host.platform === 'win32') {
    return command(host.platform, ordered.map(path => `if(Test-Path -LiteralPath ${q(path)}){if((Get-Item -Force -LiteralPath ${q(path)}).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'reparse path'}}`).join('; ')
      + '; ' + paths.map(path => `[IO.Directory]::CreateDirectory(${q(path)})|Out-Null`).join('; ')
      + '; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); '
      + '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; '
      + '$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,\'FullControl\',\'ContainerInherit,ObjectInherit\',\'None\',\'Allow\'); '
      + '$acl.AddAccessRule($rule); '
      + paths.map(path => `Set-Acl -LiteralPath ${q(path)} -AclObject $acl`).join('; '))
  }
  return `umask 077; ${ordered.map(path => `[ ! -L ${q(path)} ]`).join(' && ')} && mkdir -p ${paths.map(q).join(' ')} && chmod 700 ${paths.map(q).join(' ')}`
}

async function verifyNode(
  connection: RemoteHostSshConnection, host: HostRecord, release: string, artifact: Artifact, signal: AbortSignal,
): Promise<void> {
  const file = artifact.files.find(entry => entry.path === artifact.executable)
  /* v8 ignore next -- inspectArtifact guarantees the selected executable is present in a deployable artifact. */
  if (!file) throw new RemoteHostsError('INVALID_ARTIFACT')
  const q = (value: string) => quote(host.platform, value)
  const binary = `${release}/${artifact.executable}`
  const script = host.platform === 'win32'
    ? `if((Get-Item -Force -LiteralPath ${q(binary)}).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'reparse binary'}; if((Get-FileHash -LiteralPath ${q(binary)} -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${file.sha256}'){throw 'node hash'};`
    : `[ ! -L ${q(binary)} ] && [ "$( ${host.platform === 'darwin' ? '/usr/bin/shasum -a 256' : '/usr/bin/sha256sum'} ${q(binary)} | /usr/bin/cut -d ' ' -f 1 )" = '${file.sha256}' ] && chmod 700 ${q(binary)}`
  await execute(connection, command(host.platform, script), undefined, signal)
}

/** Upload and verify one artifact release on the remote host.
 * @param connection - owned SSH connection.
 * @param host - target host platform and path policy.
 * @param home - validated remote Harness home.
 * @param artifact - locally verified artifact.
 * @param signal - cancellation for the deployment.
 * @param progress - optional receiver of bounded upload/verify step progress.
 * @returns the immutable remote release directory.
 */
export async function deploy(
  connection: RemoteHostSshConnection, host: HostRecord, home: string, artifact: Artifact, signal: AbortSignal,
  progress?: (value: RemoteHostProgress) => void,
): Promise<string> {
  const releases = `${home}/server/releases`
  const release = `${releases}/${artifact.digest}`
  await execute(connection, privateDirectories(host, [home, `${home}/server`, releases], home), undefined, signal)
  const q = (value: string) => quote(host.platform, value)
  const exists = await execute(connection, command(host.platform, host.platform === 'win32'
    ? `if(Test-Path -LiteralPath ${q(release)}){Write-Output 'yes'}else{Write-Output 'no'}`
    : `if [ -d ${q(release)} ]; then printf yes; else printf no; fi`), undefined, signal)
  const fresh = exists.trim() === 'no'
  const target = fresh ? `${releases}/.upload-${randomUUID()}` : release
  await execute(connection, privateDirectories(host, [target], home), undefined, signal)
  if (fresh) {
    const directories = new Set<string>()
    for (const file of artifact.files) for (let parent = posix.dirname(file.path); parent !== '.'; parent = posix.dirname(parent)) directories.add(parent)
    for (const path of [...directories].sort((a, b) => a.length - b.length)) await connection.mkdir(`${target}/${path}`, signal)
    const total = Math.max(1, artifact.files.length)
    for (const [index, file] of artifact.files.entries()) {
      progress?.({ phase: 'uploading', current: index, total })
      await connection.upload(file.localPath, `${target}/${file.path}`, signal)
      progress?.({ phase: 'uploading', current: index + 1, total })
    }
  }
  // The copied Node is hashed by the native OS before any copied executable runs.
  progress?.({ phase: 'verifying', current: 1, total: 1 })
  await verifyNode(connection, host, target, artifact, signal)
  const files = artifact.files.map(({ path, sha256, bytes, mode }) => ({ path, sha256, bytes, mode }))
  await execute(connection, nodeCommand(host.platform, target, home, VERIFY), JSON.stringify(files), signal)
  if (fresh) {
    await execute(connection, command(host.platform, host.platform === 'win32'
      ? `if(Test-Path -LiteralPath ${q(release)}){throw 'release exists'}; Move-Item -LiteralPath ${q(target)} -Destination ${q(release)}`
      : `[ ! -e ${q(release)} ] && mv ${q(target)} ${q(release)}`), undefined, signal)
  }
  return release
}

const GRANT = `import {listAuthenticationGrants,createAuthenticationClientGrant,isAuthenticationGrantActive} from '@deepseek-ai/dsh-authentication-local';
let text='';for await(const c of process.stdin)text+=c;const input=JSON.parse(text);const options={dshHome:process.env.DSH_HOME};
let grant=(await listAuthenticationGrants(options)).find(g=>g.name===input.name);
if(grant){if(grant.publicKey!==input.publicKey||grant.kind!=='api-client'||!isAuthenticationGrantActive(grant)||input.capabilities.some(c=>!grant.capabilities.includes(c)))throw Error('grant identity conflict');}
else grant=await createAuthenticationClientGrant(input,options);process.stdout.write(JSON.stringify({id:grant.id}));`

/** Ensure the remote process has the expected authenticated API grant.
 * @param connection - owned SSH connection.
 * @param host - target host platform and path policy.
 * @param home - validated remote Harness home.
 * @param release - verified remote release directory.
 * @param publicKey - public key for the local coordinator grant.
 * @param signal - cancellation for the operation.
 * @returns the stable remote grant identity.
 */
export async function bootstrapGrant(
  connection: RemoteHostSshConnection, host: HostRecord, home: string, release: string, publicKey: string, signal: AbortSignal,
): Promise<string> {
  const output = await execute(connection, nodeCommand(host.platform, release, home, GRANT, true), JSON.stringify({
    name: `remote-host-${host.id}`, publicKey,
    capabilities: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'],
  }), signal)
  const value: unknown = JSON.parse(output)
  if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string' || !value.id) throw new RemoteHostsError('INVALID_GRANT')
  return value.id
}

/** Probe whether the remote process with one PID is still alive.
 * @param connection - owned SSH connection.
 * @param host - target host platform and path policy.
 * @param home - validated remote Harness home.
 * @param release - verified remote release directory.
 * @param pid - remote process identifier.
 * @param signal - cancellation for the operation.
 * @returns whether the process is alive.
 */
export async function processAlive(
  connection: RemoteHostSshConnection, host: HostRecord, home: string, release: string, pid: number, signal: AbortSignal,
): Promise<boolean> {
  const output = await execute(connection, nodeCommand(host.platform, release, home,
    `try{process.kill(${pid},0);process.stdout.write('live')}catch(e){if(e.code==='ESRCH')process.stdout.write('dead');else throw e}`), undefined, signal)
  if (!['live', 'dead'].includes(output)) throw new RemoteHostsError('INVALID_PROCESS_STATUS')
  return output === 'live'
}

/** Start the verified remote server as a detached process.
 * @param connection - owned SSH connection.
 * @param host - target host platform and path policy.
 * @param home - validated remote Harness home.
 * @param release - verified remote release directory.
 * @param signal - cancellation for the operation.
 */
export async function startDetached(
  connection: RemoteHostSshConnection, host: HostRecord, home: string, release: string, signal: AbortSignal,
): Promise<void> {
  const q = (value: string) => quote(host.platform, value)
  const script = host.platform === 'win32'
    ? `$env:DSH_HOME=${q(home)}; $env:NODE_OPTIONS=''; $env:NODE_PATH=''; Start-Process -FilePath ${q(`${release}/node.exe`)} -ArgumentList 'app/lib/bin.js --port 0' -WorkingDirectory ${q(release)} -WindowStyle Hidden -RedirectStandardOutput ${q(`${home}/server/stdout.log`)} -RedirectStandardError ${q(`${home}/server/stderr.log`)} -Wait | Out-Null`
    : `cd ${q(release)} && (umask 077; nohup env DSH_HOME=${q(home)} NODE_OPTIONS='' NODE_PATH='' ${q(`${release}/node`)} app/lib/bin.js --port 0 < /dev/null >> ${q(`${home}/server/stdout.log`)} 2>> ${q(`${home}/server/stderr.log`)} &)`
  // WMI owns the detached bootstrap rather than sshd's kill-on-close process job.
  const detached = host.platform === 'win32'
    ? '$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{CreateFlags=16777216;ShowWindow=0}; '
      + `$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${q(command(host.platform, script))}; CurrentDirectory=${q(release)}; ProcessStartupInformation=$startup}; `
      + 'if($result.ReturnValue -ne 0){throw \'detached process creation failed\'}'
    : script
  await execute(connection, command(host.platform, detached), undefined, signal)
}

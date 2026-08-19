/**
 * Container-friendly Web launcher.
 *
 * Generates a persistent development CA and server certificate, installs the
 * CA into a Linux container trust store when possible, then delegates to the
 * normal authenticated HTTPS Web profile. The certificate authority is kept
 * under DSH_HOME so a recreated server container can reuse the same trust
 * material when that home is mounted as a volume.
 */
import { execFile, spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const defaultHosts = ['localhost', '127.0.0.1', 'host.docker.internal']

function isDnsName(host: string): boolean {
  return host.length <= 253 && host.split('.').every(label => (
    label.length > 0
    && label.length <= 63
    && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/iu.test(label)
  ))
}

export interface DevelopmentTlsPaths {
  caCertificate: string
  caKey: string
  certificate: string
  key: string
  metadata: string
}

/** Return unique DNS/IP SAN values from a comma-separated environment value. */
export function parseTlsHosts(raw = defaultHosts.join(',')): string[] {
  const hosts = [...new Set(raw.split(',').map(host => host.trim()).filter(Boolean))]
  if (hosts.length === 0) throw new Error('container-web-tls: DSH_WEB_TLS_HOSTS must contain at least one host')
  if (hosts.some(host => isIP(host) === 0 && !isDnsName(host))) {
    throw new Error('container-web-tls: DSH_WEB_TLS_HOSTS accepts host names and IP addresses, not URLs or host:port values')
  }
  return hosts
}

/** Return unique exact browser Origins from a comma-separated environment value. */
export function parseTrustedOrigins(raw = ''): string[] {
  return [...new Set(raw.split(',').map(origin => origin.trim()).filter(Boolean))]
}

/** Build OpenSSL subjectAltName entries for the supplied browser authorities. */
export function buildSubjectAltName(hosts: readonly string[]): string {
  return hosts.map(host => `${isIP(host) === 0 ? 'DNS' : 'IP'}:${host}`).join(',')
}

/** Return the persistent paths used by the development CA and leaf certificate. */
export function developmentTlsPaths(tlsDir: string): DevelopmentTlsPaths {
  return {
    caCertificate: join(tlsDir, 'harniverse-dev-ca.crt'),
    caKey: join(tlsDir, 'harniverse-dev-ca.key'),
    certificate: join(tlsDir, 'harniverse-dev-server.crt'),
    key: join(tlsDir, 'harniverse-dev-server.key'),
    metadata: join(tlsDir, 'harniverse-dev-server.hosts'),
  }
}

async function openssl(args: readonly string[], cwd?: string): Promise<void> {
  try {
    await execFileAsync('openssl', [...args], { cwd })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('container-web-tls: OpenSSL is required to generate the development certificate', { cause: error })
    }
    throw error
  }
}

async function certificateRemainsValid(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  try {
    await openssl(['x509', '-checkend', '2592000', '-noout', '-in', path])
    return true
  } catch {
    return false
  }
}

/** Generate or reuse the persistent development CA and server certificate. */
export async function ensureDevelopmentTls(tlsDir: string, hosts: readonly string[], force = false): Promise<DevelopmentTlsPaths> {
  const paths = developmentTlsPaths(tlsDir)
  const metadata = hosts.join('\n') + '\n'
  await mkdir(tlsDir, { recursive: true, mode: 0o700 })
  const scratch = await mkdtemp(join(tmpdir(), 'harniverse-tls-'))
  try {
    const reuseCa = !force && existsSync(paths.caKey) && await certificateRemainsValid(paths.caCertificate)
    if (!reuseCa) {
      const caKey = join(scratch, 'ca.key')
      const caCertificate = join(scratch, 'ca.crt')
      const caConfig = join(scratch, 'ca.cnf')
      await writeFile(caConfig, '[req]\ndistinguished_name=dn\nx509_extensions=v3_ca\nprompt=no\n[dn]\nCN=Harniverse Development CA\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n')
      await openssl([
        'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '3650',
        '-keyout', caKey, '-out', caCertificate, '-config', caConfig,
      ])
      await Promise.all([
        copyFile(caCertificate, paths.caCertificate),
        copyFile(caKey, paths.caKey),
      ])
      await chmod(paths.caKey, 0o600)
    }

    let metadataMatches = false
    try {
      metadataMatches = await readFile(paths.metadata, 'utf8') === metadata
    } catch {
      // Missing metadata means the leaf must be regenerated.
    }
    if (!force && reuseCa && metadataMatches && existsSync(paths.key) && await certificateRemainsValid(paths.certificate)) return paths

    const serverKey = join(scratch, 'server.key')
    const serverCsr = join(scratch, 'server.csr')
    const serverCertificate = join(scratch, 'server.crt')
    const extensions = join(scratch, 'extensions.cnf')
    await openssl(['req', '-new', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', serverKey, '-out', serverCsr, '-subj', `/CN=${hosts[0]}`])
    await writeFile(extensions, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${buildSubjectAltName(hosts)}\n`)
    await openssl([
      'x509', '-req', '-sha256', '-days', '365', '-in', serverCsr,
      '-CA', paths.caCertificate, '-CAkey', paths.caKey, '-CAserial', join(scratch, 'ca.srl'), '-CAcreateserial',
      '-out', serverCertificate, '-extfile', extensions,
    ])
    await Promise.all([
      copyFile(serverCertificate, paths.certificate),
      copyFile(serverKey, paths.key),
      writeFile(paths.metadata, metadata, { mode: 0o600 }),
    ])
    await Promise.all([paths.caKey, paths.key, paths.metadata].map(path => chmod(path, 0o600)))
    return paths
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

function isContainer(): boolean {
  return process.env.DSH_CONTAINER === '1' || existsSync('/.dockerenv') || existsSync('/run/.containerenv')
}

async function installContainerTrust(caCertificate: string): Promise<void> {
  if (process.env.DSH_WEB_INSTALL_CA === '0') return
  if (!isContainer() && process.env.DSH_WEB_INSTALL_CA !== '1') return
  let update: (() => Promise<void>) | undefined
  if (existsSync('/usr/sbin/update-ca-certificates') || existsSync('/usr/bin/update-ca-certificates')) {
    const target = '/usr/local/share/ca-certificates/harniverse-dev-ca.crt'
    update = async () => { await copyFile(caCertificate, target); await execFileAsync('update-ca-certificates') }
  } else if (existsSync('/usr/sbin/update-ca-trust') || existsSync('/usr/bin/update-ca-trust')) {
    const target = '/etc/pki/ca-trust/source/anchors/harniverse-dev-ca.crt'
    update = async () => { await copyFile(caCertificate, target); await execFileAsync('update-ca-trust') }
  }
  if (update === undefined) {
    console.warn(`container-web-tls: could not find a Linux trust-store updater; CA is at ${caCertificate}`)
    return
  }
  try {
    await update()
    console.log('container-web-tls: installed the development CA in the container trust store')
  } catch (error) {
    console.warn(`container-web-tls: could not install the CA in the container trust store: ${String(error)}`)
    console.warn(`container-web-tls: CA file: ${caCertificate}`)
  }
}

async function runInherited(command: string, args: readonly string[]): Promise<void> {
  const child = spawn(command, [...args], { stdio: 'inherit' })
  const code = await new Promise<number>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code) => { resolveExit(code ?? 1) })
  })
  if (code !== 0) throw new Error(`container-web-tls: ${command} exited with status ${String(code)}`)
}

async function installHostTrust(caCertificate: string): Promise<void> {
  if (process.platform === 'linux') {
    const debianUpdater = ['/usr/sbin/update-ca-certificates', '/usr/bin/update-ca-certificates'].find(existsSync)
    const redHatUpdater = ['/usr/sbin/update-ca-trust', '/usr/bin/update-ca-trust'].find(existsSync)
    const target = debianUpdater === undefined
      ? '/etc/pki/ca-trust/source/anchors/harniverse-dev-ca.crt'
      : '/usr/local/share/ca-certificates/harniverse-dev-ca.crt'
    const updater = debianUpdater ?? redHatUpdater
    if (updater === undefined) throw new Error('container-web-tls: no supported Linux system trust-store updater was found')
    if (process.getuid?.() === 0) {
      await copyFile(caCertificate, target)
      await execFileAsync(updater)
    } else {
      await runInherited('sudo', ['install', '-m', '0644', caCertificate, target])
      await runInherited('sudo', [updater])
    }
  } else if (process.platform === 'darwin') {
    await runInherited('security', [
      'add-trusted-cert', '-r', 'trustRoot', '-k', join(homedir(), 'Library/Keychains/login.keychain-db'), caCertificate,
    ])
  } else if (process.platform === 'win32') {
    await runInherited('certutil', ['-user', '-addstore', 'Root', caCertificate])
  } else {
    throw new Error(`container-web-tls: host trust installation is unsupported on ${process.platform}`)
  }
  console.log(`container-web-tls: trusted the development CA on this ${process.platform} host`)
}

function hasOption(args: readonly string[], option: string): boolean {
  return args.some(arg => arg === option || arg.startsWith(`${option}=`))
}

/** Add safe container defaults without overriding explicit Web flags. */
export function containerWebArgs(
  args: readonly string[],
  paths: DevelopmentTlsPaths,
  hosts: readonly string[],
  trustedOrigins: readonly string[] = [],
): string[] {
  const defaults: string[] = []
  if (!hasOption(args, '--host')) defaults.push('--host', '0.0.0.0')
  if (!hasOption(args, '--port')) defaults.push('--port', process.env.DSH_WEB_PORT ?? '3000')
  if (!hasOption(args, '--tls-cert')) defaults.push('--tls-cert', paths.certificate)
  if (!hasOption(args, '--tls-key')) defaults.push('--tls-key', paths.key)
  if (!hasOption(args, '--trusted-host')) {
    if (hosts.length > 0) defaults.push('--trusted-host', ...hosts)
  }
  if (!hasOption(args, '--trusted-origin') && trustedOrigins.length > 0) {
    defaults.push('--trusted-origin', ...trustedOrigins)
  }
  return [...defaults, ...args]
}

async function run(): Promise<number> {
  const rawArgs = process.argv.slice(2)
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: pnpm run web:container -- [dsh web options]')
    console.log('       pnpm run web:container:trust')
    console.log('Environment: DSH_WEB_TLS_HOSTS, DSH_WEB_TRUSTED_ORIGINS, DSH_WEB_TLS_DIR, DSH_WEB_TLS_FORCE=1, DSH_WEB_PORT, DSH_WEB_INSTALL_CA=0|1')
    return 0
  }
  const trustHost = args[0] === '--trust-host'
  const webArgs = trustHost ? args.slice(1) : args
  if (trustHost && webArgs.length > 0) throw new Error('container-web-tls: --trust-host accepts no Web options')
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const tlsDir = process.env.DSH_WEB_TLS_DIR ?? join(dshHome, 'tls')
  const hosts = parseTlsHosts(process.env.DSH_WEB_TLS_HOSTS)
  const trustedOrigins = parseTrustedOrigins(process.env.DSH_WEB_TRUSTED_ORIGINS)
  const paths = await ensureDevelopmentTls(tlsDir, hosts, process.env.DSH_WEB_TLS_FORCE === '1')
  if (trustHost) {
    await installHostTrust(paths.caCertificate)
    return 0
  }
  await installContainerTrust(paths.caCertificate)
  console.log(`container-web-tls: development CA: ${paths.caCertificate}`)
  const child = spawn(process.execPath, [
    '--import',
    'tsx/esm',
    join(repoRoot, 'apps/cli/src/bin.ts'),
    'web',
    ...containerWebArgs(webArgs, paths, hosts, trustedOrigins),
  ], {
    cwd: repoRoot,
    env: { ...process.env, NODE_EXTRA_CA_CERTS: paths.caCertificate },
    stdio: 'inherit',
  })
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  const forward = new Map(signals.map(signal => [signal, () => { child.kill(signal) }] as const))
  for (const [signal, listener] of forward) process.once(signal, listener)
  return await new Promise((resolveExit) => {
    child.once('error', (error) => { console.error(`container-web-tls: failed to start dsh web: ${String(error)}`); resolveExit(1) })
    child.once('exit', (code, signal) => {
      for (const [name, listener] of forward) process.removeListener(name, listener)
      resolveExit(code ?? (signal === null ? 1 : 128))
    })
  })
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) process.exitCode = await run()

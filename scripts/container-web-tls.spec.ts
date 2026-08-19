import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildSubjectAltName,
  containerWebArgs,
  developmentTlsPaths,
  ensureDevelopmentTls,
  parseTrustedOrigins,
  parseTlsHosts,
} from './container-web-tls.ts'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const hasOpenSsl = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('container Web TLS launcher', () => {
  it('normalizes browser hosts and emits DNS and IP SANs', () => {
    expect(parseTlsHosts(' localhost,192.168.1.20,localhost,host.docker.internal '))
      .toEqual(['localhost', '192.168.1.20', 'host.docker.internal'])
    expect(buildSubjectAltName(['localhost', '192.168.1.20']))
      .toBe('DNS:localhost,IP:192.168.1.20')
    expect(() => parseTlsHosts('https://localhost:3000')).toThrow('host names and IP addresses')
    expect(() => parseTlsHosts('localhost\nsubjectAltName=DNS:example.com')).toThrow('host names and IP addresses')
  })

  it('normalizes optional cross-origin allowlist values without treating them as certificate SANs', () => {
    expect(parseTrustedOrigins(' https://ui.example.test,https://ui.example.test,https://admin.example.test '))
      .toEqual(['https://ui.example.test', 'https://admin.example.test'])
  })

  it('adds authenticated HTTPS container defaults without overriding explicit flags', () => {
    vi.stubEnv('DSH_WEB_PORT', '3000')
    const paths = developmentTlsPaths('/tmp/harniverse-tls')
    expect(containerWebArgs([], paths, ['localhost', '127.0.0.1', 'host.docker.internal'], ['https://ui.example.test']))
      .toEqual([
        '--host', '0.0.0.0',
        '--port', '3000',
        '--tls-cert', paths.certificate,
        '--tls-key', paths.key,
        '--trusted-host', 'localhost', '127.0.0.1', 'host.docker.internal',
        '--trusted-origin', 'https://ui.example.test',
      ])
    expect(containerWebArgs(['--host', '127.0.0.1', '--tls-cert', 'custom.crt', '--tls-key', 'custom.key'], paths, ['localhost']))
      .toEqual(['--port', '3000', '--trusted-host', 'localhost', '--host', '127.0.0.1', '--tls-cert', 'custom.crt', '--tls-key', 'custom.key'])
  })

  it.skipIf(!hasOpenSsl)('generates a reusable CA and server certificate with the requested browser names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harniverse-container-tls-'))
    roots.push(root)
    const paths = await ensureDevelopmentTls(root, ['localhost', '192.168.1.20'])
    const firstMetadata = await readFile(paths.metadata, 'utf8')
    const firstCa = await readFile(paths.caCertificate, 'utf8')
    const certificate = await execFileAsync('openssl', ['x509', '-in', paths.certificate, '-noout', '-ext', 'subjectAltName'])
    expect(certificate.stdout).toContain('DNS:localhost')
    expect(certificate.stdout).toContain('IP Address:192.168.1.20')
    expect(await ensureDevelopmentTls(root, ['localhost', '192.168.1.20'])).toEqual(paths)
    expect(await readFile(paths.metadata, 'utf8')).toBe(firstMetadata)
    await ensureDevelopmentTls(root, ['localhost', 'host.docker.internal'])
    expect(await readFile(paths.caCertificate, 'utf8')).toBe(firstCa)
    expect(await readFile(paths.metadata, 'utf8')).toBe('localhost\nhost.docker.internal\n')
  })
})

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HostRegistry } from '../src/registry.ts'
import { parseHostInput, remoteHostId } from '../src/validation.ts'

const input = { name: 'Build host', host: 'build.example.org', username: 'builder',
  fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', platform: 'linux', architecture: 'x64',
  authentication: { kind: 'password' }, reverseMappings: [] }

it('persists stable nonsecret host records and rejects secret-shaped durable input', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-host-registry-'))
  try {
    const registry = new HostRegistry(home)
    await registry.load()
    const host = parseHostInput(input)
    const id = remoteHostId('84fbdabb-7814-4d13-a19a-5afeb7b1eb50')
    await registry.put({ ...host, id })
    const again = new HostRegistry(home)
    await again.load()
    expect(again.list()).toEqual([{ ...host, id }])
    expect(JSON.parse(await readFile(join(home, 'remote-hosts.json'), 'utf8')) as unknown).toMatchObject({ version: 1 })
    expect(() => parseHostInput({ ...input, password: 'secret' })).toThrow()
    expect(() => parseHostInput({ ...input, fingerprint: '' })).toThrow()
    expect(() => parseHostInput({ ...input, reverseMappings: [{ localHost: 'localhost', localPort: 80 }] })).toThrow()
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('validates explicit origins and Windows absolute home paths without local path semantics', () => {
  expect(parseHostInput({ ...input, platform: 'win32', dshHome: 'C:\\Users\\Runner\\.dsh' }).dshHome)
    .toBe('C:\\Users\\Runner\\.dsh')
  expect(() => parseHostInput({ ...input, dshHome: '~/state' })).toThrow()
  expect(() => parseHostInput({ ...input, dshHome: '/' })).toThrow()
  expect(() => parseHostInput({ ...input, platform: 'win32', dshHome: 'C:\\' })).toThrow()
  expect(() => parseHostInput({ ...input, reverseMappings: [{ localHost: 'localhost', localPort: 80,
    remoteOriginalOrigin: 'http://localhost:80/private' }] })).toThrow()
})

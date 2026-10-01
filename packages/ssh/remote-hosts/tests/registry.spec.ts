import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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
  expect(() => parseHostInput({ ...input, reverseMappings: [{ localHost: 'localhost', localPort: 80,
    remoteOriginalOrigin: 'not-an-origin' }] })).toThrow()
  expect(() => parseHostInput({ ...input, reverseMappings: [
    { localHost: 'localhost', localPort: 80, remoteOriginalOrigin: 'http://one.test' },
    { localHost: 'localhost', localPort: 81, remoteOriginalOrigin: 'http://one.test' },
  ] })).toThrow(/duplicate reverse origin/)
})

it('treats malformed registry documents as public validation failures and serializes removal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-host-registry-invalid-'))
  try {
    const path = join(home, 'remote-hosts.json')
    const record = parseHostInput(input)
    await writeFile(path, JSON.stringify({ version: 2, hosts: [] }))
    await expect(new HostRegistry(home).load()).rejects.toThrow('INVALID_REGISTRY')
    await rm(path)
    await writeFile(path, JSON.stringify({ version: 1, hosts: [{ ...record, id: remoteHostId('84fbdabb-7814-4d13-a19a-5afeb7b1eb50') }, { ...record, id: remoteHostId('84fbdabb-7814-4d13-a19a-5afeb7b1eb50') }] }))
    await expect(new HostRegistry(home).load()).rejects.toThrow('INVALID_REGISTRY')
    await rm(path)
    await writeFile(join(home, 'actual.json'), JSON.stringify({ version: 1, hosts: [] }))
    await symlink(join(home, 'actual.json'), path)
    await expect(new HostRegistry(home).load()).rejects.toThrow('INVALID_REGISTRY')
    await rm(path)
    const registry = new HostRegistry(home)
    await registry.load()
    expect(() => registry.get(remoteHostId('84fbdabb-7814-4d13-a19a-5afeb7b1eb50'))).toThrow('HOST_NOT_FOUND')
    const id = remoteHostId('84fbdabb-7814-4d13-a19a-5afeb7b1eb50')
    await registry.put({ ...record, id })
    await registry.remove(id)
    expect(registry.list()).toEqual([])

    const full = new HostRegistry(home)
    const fullRecords = Array.from({ length: 1024 }, () => ({ ...record, id: remoteHostId(randomUUID()) }))
    ;(full as unknown as { records: typeof fullRecords }).records = fullRecords
    await expect(full.put({ ...record, id: remoteHostId(randomUUID()) })).rejects.toThrow('REGISTRY_FULL')

    const large = new HostRegistry(home)
    const mappings = Array.from({ length: 64 }, (_, index) => ({ localHost: 'a'.repeat(1024), localPort: index + 1,
      remoteOriginalOrigin: `http://mapping-${String(index)}.example.test` }))
    const largeRecord = parseHostInput({ ...input, reverseMappings: mappings })
    const largeRecords = Array.from({ length: 64 }, (_, index) => ({ ...largeRecord, id: remoteHostId(randomUUID()), name: `host-${String(index)}` }))
    ;(large as unknown as { records: typeof largeRecords }).records = largeRecords
    await expect(large.put({ ...record, id: remoteHostId(randomUUID()) })).rejects.toThrow('REGISTRY_FULL')
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('recovers its serialized commit queue after a parent creation failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-host-registry-recover-'))
  const home = join(root, 'blocked-home')
  try {
    await writeFile(home, 'not a directory')
    const registry = new HostRegistry(home)
    const record = parseHostInput(input)
    const id = remoteHostId('84fbdabb-7814-4d13-a19a-5afeb7b1eb50')
    await expect(registry.put({ ...record, id })).rejects.toThrow()
    await rm(home)
    await mkdir(home)
    await registry.put({ ...record, id })
    expect(registry.list()).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { PeerError, ensureInstanceIdentity, instanceIdentityPath, readInstanceIdentity, writeInstanceIdentity } from '../src/index.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'peer-protocol-'))
  directories.push(path)
  return path
}

it('mints one stable identity per home and reuses it on later reads', async () => {
  const root = await home()
  const first = await ensureInstanceIdentity(root)
  expect(first.instanceId).toMatch(/^[0-9a-f-]{36}$/)
  expect(first.platform).toBe(process.platform)
  expect(first.arch).toBe(process.arch)
  const again = await ensureInstanceIdentity(root, { displayName: 'ignored-because-present' })
  expect(again.instanceId).toBe(first.instanceId)
  expect(again.displayName).toBe(first.displayName)
  expect(await readInstanceIdentity(root)).toEqual(first)
})

it('honors a requested display name only for a fresh mint and writes owner-only files', async () => {
  const root = await home()
  const created = await ensureInstanceIdentity(root, { displayName: 'Build workstation' })
  expect(created.displayName).toBe('Build workstation')
  const stat = await import('node:fs/promises').then(fs => fs.stat(instanceIdentityPath(root)))
  expect(stat.mode & 0o777).toBe(0o600)
})

it('rejects unreadable and malformed identity documents', async () => {
  const root = await home()
  await expect(readInstanceIdentity(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
  await writeFile(instanceIdentityPath(root), 'not json')
  await expect(readInstanceIdentity(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
  await writeFile(instanceIdentityPath(root), 'null')
  await expect(readInstanceIdentity(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
  await writeFile(instanceIdentityPath(root), '[]')
  await expect(readInstanceIdentity(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
  await writeFile(instanceIdentityPath(root), JSON.stringify({ version: 2 }))
  await expect(readInstanceIdentity(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
  const valid = await ensureInstanceIdentity(await home())
  await writeFile(instanceIdentityPath(root), JSON.stringify({ ...valid, instanceId: 'nope' }))
  await expect(readInstanceIdentity(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
  await writeFile(instanceIdentityPath(root), JSON.stringify({ ...valid, version: 2 }))
  await expect(readInstanceIdentity(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
  await writeFile(instanceIdentityPath(root), JSON.stringify({ ...valid, displayName: '' }))
  await expect(readInstanceIdentity(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
  await writeFile(instanceIdentityPath(root), JSON.stringify({ ...valid, extra: 1 }))
  await expect(readInstanceIdentity(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
  const { instanceId: _removed, renamed: swapped } = { ...valid, renamed: 1 }
  void _removed
  const { version, displayName, platform, arch, createdAt } = valid
  await writeFile(instanceIdentityPath(root), JSON.stringify({ version, displayName, platform, arch, createdAt, swapped }))
  await expect(readInstanceIdentity(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
})

it('persists an exact identity document ending in one newline', async () => {
  const root = await home()
  const identity = await ensureInstanceIdentity(root)
  const text = await readFile(instanceIdentityPath(root), 'utf8')
  expect(text).toBe(`${JSON.stringify(identity)}\n`)
  const replacement = { ...identity, displayName: 'renamed' }
  await writeInstanceIdentity(root, replacement)
  expect(await readInstanceIdentity(root)).toEqual(replacement)
})

it('rejects an out-of-range display name at mint and maps write failures onto the closed reason', async () => {
  const root = await home()
  await expect(ensureInstanceIdentity(root, { displayName: 'x'.repeat(65) })).rejects.toThrowError(/INVALID_PAYLOAD/)
  const identity = await ensureInstanceIdentity(root)
  const block = join(root, 'block')
  await writeFile(block, 'a plain file blocks recursive directory creation')
  await expect(writeInstanceIdentity(join(block, 'under'), identity)).rejects.toThrowError(PeerError)
})

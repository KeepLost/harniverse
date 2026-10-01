import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    unlink: vi.fn(async (path: string | URL) => {
      if (String(path).endsWith('.tmp')) throw Object.assign(new Error('temporary cleanup failed'), { code: 'EIO' })
      await actual.unlink(path)
    }),
  }
})

import { HostRegistry } from '../src/registry.ts'
import { parseHostInput, remoteHostId } from '../src/validation.ts'

it('reports a post-commit temporary-file cleanup failure without losing the committed record', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-host-registry-cleanup-'))
  try {
    const registry = new HostRegistry(home)
    await registry.load()
    const record = parseHostInput({ name: 'Cleanup', host: 'cleanup.example.org', username: 'runner',
      fingerprint: `SHA256:${'A'.repeat(43)}`, platform: 'linux', architecture: 'x64', authentication: { kind: 'password' } })
    const id = remoteHostId('84fbdabb-7814-4d13-a19a-5afeb7b1eb50')
    await expect(registry.put({ ...record, id })).rejects.toThrow('temporary cleanup failed')
    expect(registry.list()).toEqual([{ ...record, id }])
    expect(JSON.parse(await readFile(join(home, 'remote-hosts.json'), 'utf8'))).toMatchObject({ hosts: [{ id }] })
  } finally { await rm(home, { recursive: true, force: true }) }
})

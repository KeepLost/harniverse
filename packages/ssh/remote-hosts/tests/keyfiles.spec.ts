import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The default start directory reads the operator's home; pin it per test.
const home = { value: '' }
vi.mock('node:os', async importOriginal => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => home.value,
}))

const { listKeyDirectory } = await import('../src/keyfiles.ts')

afterEach(() => { home.value = '' })

describe('listKeyDirectory', () => {
  it('starts at the operator\'s ~/.ssh when present, else the home directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'keyfiles-default-'))
    try {
      home.value = join(root, 'home')
      await mkdir(join(home.value, '.ssh'), { recursive: true })
      await writeFile(join(home.value, '.ssh', 'id_ed25519'), 'key')
      const ssh = await listKeyDirectory()
      expect(ssh.path).toBe(join(home.value, '.ssh'))
      expect(ssh.entries).toEqual([{ name: 'id_ed25519', path: join(home.value, '.ssh', 'id_ed25519'), kind: 'file' }])

      const bare = await mkdtemp(join(tmpdir(), 'keyfiles-bare-'))
      try {
        home.value = bare
        const listing = await listKeyDirectory()
        expect(listing.path).toBe(bare)
        expect(listing.entries).toEqual([])
      } finally { await rm(bare, { recursive: true, force: true }) }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('sorts directories before files, follows links, and skips unusable entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'keyfiles-level-'))
    try {
      await mkdir(join(root, 'beta-dir'))
      await mkdir(join(root, 'alpha-dir'))
      await writeFile(join(root, 'zeta-file'), 'z')
      await writeFile(join(root, 'alpha-file'), 'a')
      await symlink(join(root, 'alpha-dir'), join(root, 'link-to-dir'))
      await symlink(join(root, 'alpha-file'), join(root, 'link-to-file'))
      await symlink(join(root, 'nowhere'), join(root, 'broken-link'))
      // A cycle resolves to no directory at all.
      await symlink(join(root, 'loop-a'), join(root, 'loop-b'))
      await symlink(join(root, 'loop-b'), join(root, 'loop-a'))
      const listing = await listKeyDirectory(root)
      expect(listing.entries.map(entry => [entry.name, entry.kind])).toEqual([
        ['alpha-dir', 'directory'],
        ['beta-dir', 'directory'],
        ['link-to-dir', 'directory'],
        ['alpha-file', 'file'],
        ['link-to-file', 'file'],
        ['zeta-file', 'file'],
      ])
      expect(listing.parent).toBe(dirname(root))
      expect(listing.truncated).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('omits the parent at a filesystem root and names unreadable levels', async () => {
    const root = await listKeyDirectory('/')
    expect(root.parent).toBeUndefined()
    await expect(listKeyDirectory(join(tmpdir(), 'keyfiles-missing-level'))).rejects.toThrow('KEY_DIRECTORY_UNREADABLE')
  })

  it('bounds a huge level and reports the cut', async () => {
    const root = await mkdtemp(join(tmpdir(), 'keyfiles-huge-'))
    try {
      for (let index = 0; index <= 1000; index++) await writeFile(join(root, `file-${String(index).padStart(4, '0')}`), '')
      const listing = await listKeyDirectory(root)
      expect(listing.entries).toHaveLength(1000)
      expect(listing.truncated).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 30_000)
})

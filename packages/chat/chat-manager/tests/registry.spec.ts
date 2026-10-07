import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BotRegistry, MAX_BOTS, type BotRecord } from '../src/registry.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-chat-registry-'))
  roots.push(root)
  return root
}

function record(id: string, overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id,
    platform: 'telegram',
    alias: 'Harni',
    identity: { botId: '777000', displayName: 'Harni' },
    values: { baseUrl: 'https://tg.example/' },
    secretKeys: ['token'],
    enabled: true,
    settings: {},
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('bot registry', () => {
  it('tolerates a missing file and starts empty', async () => {
    const registry = new BotRegistry(await home())
    await registry.load()
    expect(registry.list()).toEqual([])
    expect(registry.get('bot_00000000')).toBeUndefined()
  })

  it('persists records atomically with owner-only permissions and reloads them', async () => {
    const root = await home()
    const registry = new BotRegistry(join(root, 'nested', 'dsh'))
    await registry.load()
    await registry.put(record('bot_aaaaaaaa'))
    await registry.put(record('bot_bbbbbbbb', { alias: 'Second', checkedAt: 5, settings: { workspace: '/srv/w', model: { provider: 'p', model: 'm' }, agentProfile: 'code' } }))
    await registry.put(record('bot_aaaaaaaa', { alias: 'Renamed' }))

    const path = join(root, 'nested', 'dsh', 'chat-bots.json')
    expect(registry.path).toBe(path)
    const document = JSON.parse(await readFile(path, 'utf8')) as { version: number; bots: Array<{ id: string; alias: string }> }
    expect(document.version).toBe(1)
    expect(document.bots.map(bot => [bot.id, bot.alias])).toEqual([['bot_aaaaaaaa', 'Renamed'], ['bot_bbbbbbbb', 'Second']])
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(join(root, 'nested', 'dsh'))).toEqual(['chat-bots.json'])

    const again = new BotRegistry(join(root, 'nested', 'dsh'))
    await again.load()
    expect(again.list()).toEqual(registry.list())
    expect(again.get('bot_bbbbbbbb')?.settings).toEqual({ workspace: '/srv/w', model: { provider: 'p', model: 'm' }, agentProfile: 'code' })
  })

  it('returns detached copies', async () => {
    const registry = new BotRegistry(await home())
    await registry.load()
    await registry.put(record('bot_aaaaaaaa'))
    registry.list()[0]!.alias = 'mutated'
    registry.get('bot_aaaaaaaa')!.values.baseUrl = 'mutated'
    expect(registry.get('bot_aaaaaaaa')).toMatchObject({ alias: 'Harni', values: { baseUrl: 'https://tg.example/' } })
  })

  it('removes a record and keeps the rest', async () => {
    const root = await home()
    const registry = new BotRegistry(root)
    await registry.load()
    await registry.put(record('bot_aaaaaaaa'))
    await registry.put(record('bot_bbbbbbbb'))
    await registry.remove('bot_aaaaaaaa')
    const again = new BotRegistry(root)
    await again.load()
    expect(again.list().map(bot => bot.id)).toEqual(['bot_bbbbbbbb'])
  })

  it('serializes concurrent writes so none is lost', async () => {
    const root = await home()
    const registry = new BotRegistry(root)
    await registry.load()
    const ids = Array.from({ length: 8 }, (_, index) => `bot_0000000${String(index)}`)
    await Promise.all(ids.map(id => registry.put(record(id))))
    const again = new BotRegistry(root)
    await again.load()
    expect(again.list().map(bot => bot.id).sort()).toEqual(ids)
  })

  it('refuses a write past the bot bound and keeps the earlier state', async () => {
    const registry = new BotRegistry(await home())
    await registry.load()
    for (let index = 0; index < MAX_BOTS; index += 1) await registry.put(record(`bot_${index.toString(16).padStart(8, '0')}`))
    await expect(registry.put(record('bot_ffffffff'))).rejects.toThrow('too many bots')
    expect(registry.list()).toHaveLength(MAX_BOTS)
    await registry.put(record('bot_00000000', { alias: 'still writable' }))
    expect(registry.get('bot_00000000')?.alias).toBe('still writable')
  })

  it('does not let a failed write poison later writes', async () => {
    const root = await home()
    const registry = new BotRegistry(root)
    await registry.load()
    await expect(registry.put({ ...record('bot_aaaaaaaa'), id: 'not-an-id' })).rejects.toThrow()
    await registry.put(record('bot_bbbbbbbb'))
    expect(registry.list().map(bot => bot.id)).toEqual(['bot_bbbbbbbb'])
  })

  describe('corrupt files fail early, naming the file and never its content', () => {
    const bad: Array<[string, string]> = [
      ['not JSON', '{ nope'],
      ['wrong version', JSON.stringify({ version: 2, bots: [] })],
      ['unknown top-level key', JSON.stringify({ version: 1, bots: [], extra: true })],
      ['bad id', JSON.stringify({ version: 1, bots: [{ ...record('bot_aaaaaaaa'), id: 'x' }] })],
      ['unknown record key', JSON.stringify({ version: 1, bots: [{ ...record('bot_aaaaaaaa'), token: 'SECRET-TOKEN-VALUE' }] })],
      ['duplicate id', JSON.stringify({ version: 1, bots: [record('bot_aaaaaaaa'), record('bot_aaaaaaaa')] })],
      ['a secret key shadowing a value', JSON.stringify({ version: 1, bots: [record('bot_aaaaaaaa', { values: { token: 'x' } })] })],
    ]
    for (const [label, text] of bad) {
      it(label, async () => {
        const root = await home()
        await writeFile(join(root, 'chat-bots.json'), text)
        const error = await new BotRegistry(root).load().then(() => undefined, (caught: unknown) => caught as Error)
        expect(error?.message).toContain(join(root, 'chat-bots.json'))
        expect(error?.message).not.toContain('SECRET-TOKEN-VALUE')
      })
    }

    it.skipIf(process.platform === 'win32')('a home that is not a directory', async () => {
      const root = await home()
      await writeFile(join(root, 'file'), 'x')
      await expect(new BotRegistry(join(root, 'file')).load()).rejects.toThrow('not a valid chat bot registry')
    })

    it.skipIf(process.platform === 'win32')('a symbolic link', async () => {
      const root = await home()
      await writeFile(join(root, 'real.json'), JSON.stringify({ version: 1, bots: [] }))
      await symlink(join(root, 'real.json'), join(root, 'chat-bots.json'))
      await expect(new BotRegistry(root).load()).rejects.toThrow('not a valid chat bot registry')
    })

    it('a directory or an oversized file', async () => {
      const root = await home()
      await mkdir(join(root, 'chat-bots.json'))
      await expect(new BotRegistry(root).load()).rejects.toThrow('not a valid chat bot registry')
      await rm(join(root, 'chat-bots.json'), { recursive: true })
      await writeFile(join(root, 'chat-bots.json'), ' '.repeat(1024 * 1024 + 1))
      await expect(new BotRegistry(root).load()).rejects.toThrow('not a valid chat bot registry')
    })
  })
})

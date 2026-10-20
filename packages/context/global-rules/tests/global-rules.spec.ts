import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import GlobalRulesService from '@deepseek-ai/dsh-global-rules'
import type { GlobalRules } from '@deepseek-ai/dsh-global-rules'

const scratchRoot = await mkdtemp(join(tmpdir(), 'dsh-global-rules-'))
const previousHomeEnv = process.env.DSH_HOME
const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()?.fiber.dispose()
  if (previousHomeEnv === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHomeEnv
})

afterAll(async () => {
  await rm(scratchRoot, { recursive: true, force: true })
})

async function scratchHome(name: string): Promise<string> {
  const home = join(scratchRoot, name)
  await mkdir(home, { recursive: true })
  return home
}

async function makeService(config: { dshHome?: string; maxSourceBytes?: number } = {}): Promise<GlobalRules> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(GlobalRulesService, config)
  return ctx.globalRules
}

describe('ctx.globalRules provider', () => {
  it('reads a missing file as absent with no version', async () => {
    const service = await makeService({ dshHome: await scratchHome('absent') })
    expect(await service.read()).toEqual({
      exists: false,
      content: '',
      version: undefined,
      displayPath: '$DSH_HOME/AGENTS.md',
      maxBytes: 1_048_576,
    })
  })

  it('writes, reads back, and reports content-derived versions', async () => {
    const home = await scratchHome('roundtrip')
    const service = await makeService({ dshHome: home })
    const written = await service.write('# 全局规则\n')
    const view = await service.read()
    expect(written).toEqual({ ok: true, version: view.version })
    expect(view.exists).toBe(true)
    expect(view.content).toBe('# 全局规则\n')
    expect(view.version).toMatch(/^[0-9a-f]{32}$/)
    expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe('# 全局规则\n')
  })

  it('creates the harness home when it does not exist yet', async () => {
    const home = join(scratchRoot, 'nested', 'created')
    const service = await makeService({ dshHome: home })
    const outcome = await service.write('created\n')
    expect(outcome.ok).toBe(true)
    expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe('created\n')
  })

  it('accepts a write whose expected version matches the file content', async () => {
    const service = await makeService({ dshHome: await scratchHome('match') })
    const first = await service.write('one')
    const second = await service.write('two', first.ok ? first.version : undefined)
    expect(second).toEqual({ ok: true, version: (await service.read()).version })
    expect((await service.read()).content).toBe('two')
  })

  it('refuses a write whose expected version went stale and keeps the file', async () => {
    const service = await makeService({ dshHome: await scratchHome('stale') })
    const first = await service.write('mine')
    await service.write('external')
    const stale = await service.write('clobber', first.ok ? first.version : undefined)
    expect(stale).toEqual({ ok: false, reason: 'conflict', version: (await service.read()).version })
    expect((await service.read()).content).toBe('external')
  })

  it('refuses a version-echo write after the file disappeared', async () => {
    const home = await scratchHome('deleted')
    const service = await makeService({ dshHome: home })
    const first = await service.write('soon deleted')
    await rm(join(home, 'AGENTS.md'))
    const stale = await service.write('clobber', first.ok ? first.version : undefined)
    expect(stale).toEqual({ ok: false, reason: 'conflict', version: undefined })
    expect((await service.read()).exists).toBe(false)
  })

  it('refuses oversized writes by UTF-8 byte count and leaves the file untouched', async () => {
    const home = await scratchHome('cap')
    const service = await makeService({ dshHome: home, maxSourceBytes: 9 })
    await service.write('123456789')
    // 九个汉字是 27 UTF-8 bytes although its length is 9 code units.
    const refused = await service.write('一二三四五六七八九')
    expect(refused).toEqual({ ok: false, reason: 'too-large' })
    expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe('123456789')
  })

  it('resolves the configured home over $DSH_HOME and the default home', async () => {
    const configured = await scratchHome('configured')
    const fromEnv = await scratchHome('from-env')
    process.env.DSH_HOME = fromEnv

    const overriding = await makeService({ dshHome: configured })
    expect(overriding.displayPath).toBe('$DSH_HOME/AGENTS.md')
    await overriding.write('configured wins')
    expect(await readFile(join(configured, 'AGENTS.md'), 'utf8')).toBe('configured wins')

    const envOnly = await makeService()
    expect(envOnly.displayPath).toBe('$DSH_HOME/AGENTS.md')
    await envOnly.write('env wins')
    expect(await readFile(join(fromEnv, 'AGENTS.md'), 'utf8')).toBe('env wins')

    delete process.env.DSH_HOME
    expect((await makeService()).displayPath).toBe('~/.dsh/AGENTS.md')
  })

  it('propagates filesystem failures other than absence', async () => {
    const home = await scratchHome('broken')
    await mkdir(join(home, 'AGENTS.md'))
    const service = await makeService({ dshHome: home })
    await expect(service.read()).rejects.toThrow()
    await expect(service.write('nope')).rejects.toThrow()
    // A version-checked write hits the same failure through its pre-write read.
    await expect(service.write('nope', '0'.repeat(32))).rejects.toThrow()
  })

  it('defaults the write cap when constructed directly without one', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const direct = new GlobalRulesService(ctx, {})
    expect(direct.maxBytes).toBe(1_048_576)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath, toHeaderLine } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const script = vi.hoisted(() => ({
  unlinkFault: undefined as undefined | NodeJS.ErrnoException,
  decompressAbort: undefined as undefined | { atCall: number; reason: unknown },
  decompressCalls: 0,
  abortController: undefined as undefined | AbortController,
  dirSyncPath: undefined as undefined | string,
  dirSyncs: [] as string[],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    unlink: (async (...args: Parameters<typeof actual.unlink>) => {
      if (script.unlinkFault !== undefined) throw script.unlinkFault
      return actual.unlink(...args)
    }),
    // Directory fsync handles are stubbed per path: win32 cannot really open a
    // directory, so the POSIX durability call is observed instead of executed.
    open: (async (...args: Parameters<typeof actual.open>) => {
      if (script.dirSyncPath !== undefined && String(args[0]) === script.dirSyncPath && args[1] === 'r') {
        script.dirSyncs.push(String(args[0]))
        return { sync: async () => {}, close: async () => {} } as unknown as Awaited<ReturnType<typeof actual.open>>
      }
      return actual.open(...args)
    }),
  }
})

vi.mock('../src/zstd.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/zstd.ts')>()
  return {
    ...actual,
    decompressZstdFrame: (async (buffer: Buffer) => {
      script.decompressCalls += 1
      const abort = script.decompressAbort
      if (abort !== undefined && script.decompressCalls === abort.atCall) {
        script.abortController?.abort(abort.reason)
        throw new Error('scripted frame decode failure')
      }
      return actual.decompressZstdFrame(buffer)
    }),
  }
})

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

function mockPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

function restorePlatform(): void {
  if (platformDescriptor !== undefined) {
    Object.defineProperty(process, 'platform', platformDescriptor)
  }
}

const roots: string[] = []
const contexts: Context[] = []

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-pages-'))
  roots.push(dir)
  return dir
}

async function mount(root: string, compression: 'none' | 'zstd'): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  return ctx
}

async function craftLog(root: string, id: string, contents: string): Promise<string> {
  const path = logPath(root, '/work', SessionId(id), 'none')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
  return path
}

function userMessage(id: string, text: string) {
  return freezeMessage({
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

afterEach(async () => {
  script.unlinkFault = undefined
  script.decompressAbort = undefined
  script.decompressCalls = 0
  script.abortController = undefined
  script.dirSyncPath = undefined
  script.dirSyncs.length = 0
  restorePlatform()
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('JsonlSessionPersistence: bounded page reads on plain logs', () => {
  it('pages committed records while ignoring a torn final line', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const m = meta('torn-tail', '/work')
    const persistence = ctx.sessionPersistence
    await persistence.create(m)
    await persistence.append(m.id, oneTurnLog())
    await appendFile(logPath(root, '/work', m.id, 'none'), '{"type":"assistant/chunk","seq":6,"ti')

    const page = await persistence.readHistoryPage(m.id, { maxMessages: 5 })
    expect(page.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(page.hasMore).toBe(false)

    const raw = await persistence.readRawEventPage(m.id, { maxEvents: 100 })
    expect(raw.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(raw.hasMore).toBe(false)
  })

  it('treats a body without any newline as an empty page', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const id = SessionId('bodyless')
    await craftLog(root, 'bodyless', `${JSON.stringify(toHeaderLine(meta('bodyless', '/work')))}\nmissing-newline`)

    const page = await ctx.sessionPersistence.readHistoryPage(id, { maxMessages: 5 })
    expect(page.meta.id).toBe(id)
    expect(page.events).toEqual([])
    expect(page.hasMore).toBe(false)

    const raw = await ctx.sessionPersistence.readRawEventPage(id, { maxEvents: 5 })
    expect(raw.events).toEqual([])
    expect(raw.hasMore).toBe(false)
  })

  it('skips blank body lines between records', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const body = events.map(event => JSON.stringify(event)).join('\n\n') + '\n'
    await craftLog(root, 'blank-line', `${JSON.stringify(toHeaderLine(meta('blank-line', '/work')))}\n${body}`)

    const page = await ctx.sessionPersistence.readHistoryPage(SessionId('blank-line'), { maxMessages: 1 })
    expect(page.events.map(event => event.seq)).toEqual([0, 1])
    expect(page.hasMore).toBe(false)

    const raw = await ctx.sessionPersistence.readRawEventPage(SessionId('blank-line'), { maxEvents: 10 })
    expect(raw.events.map(event => event.seq)).toEqual([0, 1])
  })

  it('does not count a replacement surface message toward the page quota', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const m = meta('replacement-newest', '/work')
    const persistence = ctx.sessionPersistence
    await persistence.create(m)
    await persistence.append(m.id, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: userMessage('replacement-original', 'first'), surfaceOp: 'append' },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 3, time: 4, data: { turn: 2 } },
      {
        type: 'user/message',
        seq: 4,
        time: 5,
        data: freezeMessage({
          id: MessageId('replacement-edit'),
          role: 'user',
          content: [{ type: 'text', text: 'edited' }],
          source: { kind: 'user' },
        }),
        surfaceOp: { op: 'replace', start: 1, end: 1 },
        sourceEventSeqs: [4, 1],
      },
      { type: 'turn/end', seq: 5, time: 6, data: { turn: 2, reason: { kind: 'completed' } } },
    ])

    const page = await persistence.readHistoryPage(m.id, { maxMessages: 1 })
    expect(page.events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5])
    expect(page.hasMore).toBe(true)
  })

  it('keeps scanning records below a checkpoint until its transaction start', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const m = meta('checkpoint-continue', '/work')
    const persistence = ctx.sessionPersistence
    await persistence.create(m)
    await persistence.append(m.id, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: userMessage('ck-original', 'superseded'), surfaceOp: 'append' },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 3, time: 4, data: { turn: 2 } },
      { type: 'user/message', seq: 4, time: 5, data: userMessage('ck-middle', 'middle'), surfaceOp: 'append' },
      {
        type: 'user/message',
        seq: 5,
        time: 6,
        data: freezeMessage({
          id: MessageId('ck-checkpoint'),
          role: 'user',
          content: [{ type: 'text', text: 'condensed' }],
          source: { kind: 'plugin', plugin: 'compact' },
        }),
        surfaceOp: { op: 'replace', start: 1, end: 4 },
        sourceEventSeqs: [3, 4],
      },
      { type: 'user/message', seq: 6, time: 7, data: userMessage('ck-recent', 'recent'), surfaceOp: 'append' },
    ])

    const page = await persistence.readHistoryPage(m.id, { maxMessages: 1, preferLatestCheckpoint: true })
    expect(page.events.map(event => event.seq)).toEqual([3, 4, 5, 6])
    expect(page.hasMore).toBe(true)
  })

  it('reports an absent session as not found for both page readers', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    await expect(ctx.sessionPersistence.readHistoryPage(SessionId('ghost'), { maxMessages: 1 }))
      .rejects.toThrow('not found')
    await expect(ctx.sessionPersistence.readRawEventPage(SessionId('ghost'), { maxEvents: 1 }))
      .rejects.toThrow('not found')
  })

  it('rejects an empty log file as empty or header-less', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    await craftLog(root, 'empty-file', '')
    await expect(ctx.sessionPersistence.readHistoryPage(SessionId('empty-file'), { maxMessages: 1 }))
      .rejects.toThrow(/empty or header-less session log/)
    await expect(ctx.sessionPersistence.readRawEventPage(SessionId('empty-file'), { maxEvents: 1 }))
      .rejects.toThrow(/empty or header-less session log/)
  })

  it('rejects a first line that is not a session header', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    await craftLog(
      root,
      'not-a-header',
      `{"nope":1}\n${JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })}\n`,
    )
    await expect(ctx.sessionPersistence.readHistoryPage(SessionId('not-a-header'), { maxMessages: 1 }))
      .rejects.toThrow(/first line is not a session header/)
    await expect(ctx.sessionPersistence.readRawEventPage(SessionId('not-a-header'), { maxEvents: 1 }))
      .rejects.toThrow(/first line is not a session header/)
  })

  it('rejects a stored header that identifies a different session', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const other = toHeaderLine(meta('other-tenant', '/work'))
    await craftLog(
      root,
      'tenant-a',
      `${JSON.stringify(other)}\n${JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })}\n`,
    )
    await expect(ctx.sessionPersistence.readHistoryPage(SessionId('tenant-a'), { maxMessages: 1 }))
      .rejects.toThrow(/does not match header id/)
    await expect(ctx.sessionPersistence.readRawEventPage(SessionId('tenant-a'), { maxEvents: 1 }))
      .rejects.toThrow(/does not match header id/)
  })

  it('falls back to the full-prefix reader when a complete corrupt record defeats the bounded reader', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const m = meta('corrupt-complete-line', '/work')
    const persistence = ctx.sessionPersistence
    await persistence.create(m)
    await persistence.append(m.id, oneTurnLog())
    await appendFile(logPath(root, '/work', m.id, 'none'), '{not json\n')

    const page = await persistence.readHistoryPage(m.id, { maxMessages: 5 })
    expect(page.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(page.hasMore).toBe(false)

    const raw = await persistence.readRawEventPage(m.id, { maxEvents: 100 })
    expect(raw.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(raw.hasMore).toBe(false)
  })

  it('round-trips subagent lineage header fields through the durable header line', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const persistence = ctx.sessionPersistence
    const m = {
      ...meta('lineage-child', '/work'),
      parentSession: SessionId('lineage-parent'),
      seedLength: 4,
      origin: 'subagent' as const,
      delegationDepth: 2,
      agentProfile: 'standard',
    }
    await persistence.create(m)
    await persistence.append(m.id, oneTurnLog())

    const loaded = await persistence.load(m.id)
    expect(loaded.meta).toMatchObject({
      id: m.id,
      parentSession: SessionId('lineage-parent'),
      seedLength: 4,
      origin: 'subagent',
      delegationDepth: 2,
      agentProfile: 'standard',
    })
    const listed = (await persistence.list()).find(header => header.id === m.id)
    expect(listed).toMatchObject({ origin: 'subagent', agentProfile: 'standard' })
  })
})

describe('JsonlSessionPersistence: bounded page reads on Zstandard logs', () => {
  async function craftZstd(root: string, id: string, contents: Buffer): Promise<void> {
    const path = logPath(root, '/work', SessionId(id), 'zstd')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  }

  it('rejects an empty Zstandard log as empty or header-less', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'zstd')
    await craftZstd(root, 'zstd-empty', Buffer.alloc(0))
    await expect(ctx.sessionPersistence.readHistoryPage(SessionId('zstd-empty'), { maxMessages: 1 }))
      .rejects.toThrow(/empty or header-less Zstandard session log/)
    await expect(ctx.sessionPersistence.readRawEventPage(SessionId('zstd-empty'), { maxEvents: 1 }))
      .rejects.toThrow(/empty or header-less Zstandard session log/)
  })

  it('rejects a header frame whose line is not valid JSON', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'zstd')
    await craftZstd(root, 'zstd-garbage', await compressZstdFrame('garbage\n'))
    await expect(ctx.sessionPersistence.readHistoryPage(SessionId('zstd-garbage'), { maxMessages: 1 }))
      .rejects.toThrow(/header line is not valid JSON/)
    await expect(ctx.sessionPersistence.readRawEventPage(SessionId('zstd-garbage'), { maxEvents: 1 }))
      .rejects.toThrow(/header line is not valid JSON/)
  })

  it('rethrows the abort reason when cancellation lands during bounded frame decode', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'zstd')
    const m = meta('abort-mid-frame', '/work')
    const persistence = ctx.sessionPersistence
    await persistence.create(m)
    await persistence.append(m.id, oneTurnLog())

    const reason = new Error('cancelled mid-decode')
    const controller = new AbortController()
    script.abortController = controller
    script.decompressAbort = { atCall: 2, reason }
    await expect(persistence.readHistoryPage(m.id, { maxMessages: 1 }, controller.signal))
      .rejects.toBe(reason)

    script.decompressCalls = 0
    const second = new AbortController()
    script.abortController = second
    await expect(persistence.readRawEventPage(m.id, { maxEvents: 1 }, second.signal))
      .rejects.toBe(reason)
  })
})

describe('JsonlSessionPersistence: delete faults', () => {
  it('reports false when the log vanishes between validation and unlink', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const m = meta('delete-race', '/work')
    const persistence = ctx.sessionPersistence
    await persistence.create(m)
    await persistence.append(m.id, oneTurnLog())
    script.unlinkFault = Object.assign(new Error('ENOENT: unlink race'), { code: 'ENOENT' })
    await expect(persistence.delete(m.id)).resolves.toBe(false)
  })

  it('surfaces non-ENOENT unlink failures', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const m = meta('delete-fault', '/work')
    const persistence = ctx.sessionPersistence
    await persistence.create(m)
    await persistence.append(m.id, oneTurnLog())
    script.unlinkFault = Object.assign(new Error('EACCES: unlink denied'), { code: 'EACCES' })
    await expect(persistence.delete(m.id)).rejects.toThrow(/EACCES/)
  })

  it('skips the POSIX directory fsync after unlink on win32', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const m = meta('delete-win32', '/work')
    const persistence = ctx.sessionPersistence
    await persistence.create(m)
    await persistence.append(m.id, oneTurnLog())
    mockPlatform('win32')
    await expect(persistence.delete(m.id)).resolves.toBe(true)
  })

  it('fsyncs the log directory after unlink off win32', async () => {
    const root = await freshRoot()
    const ctx = await mount(root, 'none')
    const m = meta('delete-posix', '/work')
    const persistence = ctx.sessionPersistence
    await persistence.create(m)
    await persistence.append(m.id, oneTurnLog())
    const dir = dirname(logPath(root, '/work', m.id, 'none'))
    mockPlatform('linux')
    script.dirSyncPath = dir
    await expect(persistence.delete(m.id)).resolves.toBe(true)
    expect(script.dirSyncs).toEqual([dir])
  })
})

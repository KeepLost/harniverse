/** Pure modules: text splitting, the editable stream, pairing codes, configuration, the command table, the queue, and pending state. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatAdapterError } from '@deepseek-ai/dsh-chat-adapter'
import type { QuestionItem } from '@deepseek-ai/dsh-chat-harniverse-client'
import { approvalBody, parseAnswers, PendingTable, questionBody, type PendingApproval } from '../src/approvals.ts'
import { authorize, COMMAND_TABLE, helpText, parseInput, type CommandName } from '../src/commands.ts'
import { GRANTABLE_COMMANDS, Config, identityKey, memberActor, ownerActor, validateConfig } from '../src/members.ts'
import { timerSleep } from '../src/messenger.ts'
import { assertNever } from '../src/never.ts'
import { generateCode, hashCode, issueCode, normalizeCode, redeemCode } from '../src/pairing.ts'
import { EditableStream, splitMessageText, truncate, withSenderPrefix } from '../src/render.ts'
import { conversationKey, KeyedQueue } from '../src/router.ts'
import type { CodeRecord } from '../src/state.ts'

afterEach(() => { vi.useRealTimers() })

describe('splitMessageText', () => {
  it('drops blank input and keeps short text whole', () => {
    expect(splitMessageText('  \n ', 10)).toEqual([])
    expect(splitMessageText(' hello ', 10)).toEqual(['hello'])
    expect(splitMessageText('abcdefghij', 10)).toEqual(['abcdefghij'])
  })

  it('prefers line breaks, then spaces, then a hard cut', () => {
    expect(splitMessageText('aaaa bbbb\ncccc dddd', 10)).toEqual(['aaaa bbbb', 'cccc dddd'])
    expect(splitMessageText('aaaa bbbb cccc', 10)).toEqual(['aaaa bbbb', 'cccc'])
    expect(splitMessageText('abcdefghijklmnopqrstuvwxyz', 10)).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxyz'])
    expect(splitMessageText('a\nbbbbbbbbbbbbbbbb', 10)).toEqual(['a\nbbbbbbbb', 'bbbbbbbb'])
  })
})

describe('text helpers', () => {
  it('truncates with an ellipsis', () => {
    expect(truncate('short', 10)).toBe('short')
    expect(truncate('abcdefghij', 5)).toBe('abcd…')
    expect(truncate('abc', 0)).toBe('abc'.slice(0, 0) + '…')
  })

  it('prefixes a sanitized sender name and never leaves it empty', () => {
    expect(withSenderPrefix('tg', 'A [b]\nc', 'hi')).toBe('[tg·A b c] hi')
    expect(withSenderPrefix('tg', ' [] ', 'hi')).toBe('[tg·unknown] hi')
    expect(withSenderPrefix('tg', 'x'.repeat(100), 'hi')).toBe(`[tg·${'x'.repeat(40)}] hi`)
  })
})

describe('EditableStream', () => {
  function stream(
    options: { limit?: number; intervalMs?: number } = {},
  ): { s: EditableStream; log: string[]; fail: { edit?: Error | undefined } } {
    const log: string[] = []
    const fail: { edit?: Error | undefined } = {}
    const s = new EditableStream({
      create: (text) => { log.push(`create:${text}`); return Promise.resolve() },
      edit: (text) => {
        log.push(`edit:${text}`)
        const error = fail.edit
        fail.edit = undefined
        return error === undefined ? Promise.resolve() : Promise.reject(error)
      },
      sendRemainder: (text) => { log.push(`more:${text}`); return Promise.resolve() },
      warn: (message) => { log.push(`warn:${message}`) },
    }, { initialText: '...', limit: options.limit ?? 100, intervalMs: options.intervalMs ?? 100 })
    return { s, log, fail }
  }

  it('coalesces updates into one edit per interval', async () => {
    vi.useFakeTimers()
    const { s, log } = stream()
    await s.start()
    s.update('a')
    s.update('ab')
    s.update('abc')
    s.update('   ')
    expect(log).toEqual(['create:...'])
    await vi.advanceTimersByTimeAsync(100)
    expect(log).toEqual(['create:...', 'edit:abc'])
    s.update('abc')
    await vi.advanceTimersByTimeAsync(100)
    expect(log).toHaveLength(2)
  })

  it('finishes with the first chunk edited and the rest as new messages', async () => {
    const { s, log } = stream({ limit: 10 })
    await s.start()
    await s.finish('aaaa bbbb cccc')
    expect(log).toEqual(['create:...', 'edit:aaaa bbbb', 'more:cccc'])
    s.update('ignored')
    await s.finish('again')
    expect(log.at(-1)).toBe('edit:again')
  })

  it('skips the final edit when the text already shown is final, and tolerates empty output', async () => {
    vi.useFakeTimers()
    const { s, log } = stream()
    await s.start()
    s.update('same')
    await vi.advanceTimersByTimeAsync(100)
    await s.finish('same')
    expect(log).toEqual(['create:...', 'edit:same'])
    const empty = stream()
    await empty.s.start()
    await empty.s.finish('  ')
    expect(empty.log).toEqual(['create:...'])
  })

  it('waits for an in-flight edit before finishing and reschedules queued text afterwards', async () => {
    vi.useFakeTimers()
    const log: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const s = new EditableStream({
      create: () => Promise.resolve(),
      edit: async (text) => { log.push(`edit:${text}`); if (text === 'one') await gate },
      sendRemainder: () => Promise.resolve(),
      warn: () => undefined,
    }, { initialText: '...', limit: 100, intervalMs: 10 })
    await s.start()
    s.update('one')
    await vi.advanceTimersByTimeAsync(10)
    s.update('two')
    await vi.advanceTimersByTimeAsync(50)
    expect(log).toEqual(['edit:one'])
    release()
    await vi.advanceTimersByTimeAsync(10)
    expect(log).toEqual(['edit:one', 'edit:two'])
    s.update('three')
    const done = s.finish('four')
    await done
    expect(log.at(-1)).toBe('edit:four')
  })

  it('backs off after a rate limit, keeps the text, and warns for other failures', async () => {
    vi.useFakeTimers()
    const { s, log, fail } = stream({ intervalMs: 10 })
    await s.start()
    fail.edit = new ChatAdapterError('rate-limited', 'fake', 'slow', { retryAfterMs: 500 })
    s.update('text')
    await vi.advanceTimersByTimeAsync(10)
    expect(log).toEqual(['create:...', 'edit:text'])
    await vi.advanceTimersByTimeAsync(400)
    expect(log).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(log).toEqual(['create:...', 'edit:text', 'edit:text'])
    fail.edit = new Error('boom')
    s.update('next')
    await vi.advanceTimersByTimeAsync(10)
    expect(log.at(-1)).toBe('warn:streamed message update failed')
  })

  it('cancels pending edits', async () => {
    vi.useFakeTimers()
    const { s, log } = stream()
    await s.start()
    s.update('x')
    s.cancel()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(log).toEqual(['create:...'])
  })
})

describe('pairing codes', () => {
  it('normalizes spellings and hashes the canonical form', () => {
    expect(normalizeCode('ab-cd ef')).toBe('ABCDEF')
    expect(normalizeCode('o1Il')).toBe('0111')
    expect(hashCode('abcde-fghjk')).toBe(hashCode('ABCDEFGHJK'))
    expect(hashCode('ABCDEFGHJK')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates ten-character Crockford codes', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateCode()))
    expect(codes.size).toBe(50)
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/)
  })

  it('stores only the hash and redeems exactly once before expiry', async () => {
    const store = new Map<string, CodeRecord>()
    const table = {
      get: (key: string) => store.get(key),
      put: (key: string, value: CodeRecord) => { store.set(key, value); return Promise.resolve() },
      delete: (key: string) => Promise.resolve(store.delete(key)),
    } as never
    const record: CodeRecord = { kind: 'owner', expiresAt: 1_000 }
    const code = await issueCode(table, record)
    expect([...store.keys()]).toEqual([hashCode(code)])
    expect(await redeemCode(table, 'nope', 0)).toBeUndefined()
    expect(await redeemCode(table, code, 0)).toEqual(record)
    expect(await redeemCode(table, code, 0)).toBeUndefined()
    const late = await issueCode(table, record)
    expect(await redeemCode(table, late, 1_000)).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it('loses a redemption race to the first deleter', async () => {
    const table = { get: () => ({ kind: 'owner', expiresAt: 10 }), delete: () => Promise.resolve(false) } as never
    expect(await redeemCode(table, 'ABCDE-FGHJK', 0)).toBeUndefined()
  })
})

describe('configuration', () => {
  const base = { workspaceAliases: { proj: '/srv/proj' } }

  it('fills documented defaults', () => {
    const config = Config({})
    expect(config).toMatchObject({
      owners: [], members: [], imRoot: '~/HarniverseIM', approvalTimeoutMs: 600_000, questionTimeoutMs: 1_800_000,
      pairing: { memberCodeTtlMs: 86_400_000, ownerCodeTtlMs: 900_000 },
      inbound: { maxFiles: 5, maxFileBytes: 20 * 1024 * 1024, maxInlineImageBytes: 4 * 1024 * 1024 },
      outbound: { maxFileBytes: 20 * 1024 * 1024 }, streamIntervalMs: 800, seenLimit: 2_000, embedded: false,
    })
  })

  it('accepts a full whitelist entry and defaults answerOwnApprovals to off', () => {
    const config = Config({
      ...base,
      owners: [{ platform: 'telegram', userId: '1' }],
      members: [{ id: 'alice', platform: 'telegram', userId: '2', commands: ['new', 'ask'], workspaces: ['proj'] }],
    })
    validateConfig(config)
    expect(config.members[0]).toMatchObject({ answerOwnApprovals: false, commands: ['new', 'ask'] })
    expect(ownerActor(config.owners[0]!)).toMatchObject({ role: 'owner', key: 'telegram:1' })
    expect(ownerActor(config.owners[0]!).commands.size).toBe(GRANTABLE_COMMANDS.length)
    expect(memberActor(config.members[0]!, 'telegram', '2')).toMatchObject({ role: 'member', memberId: 'alice', workspaces: ['proj'] })
    expect(identityKey('a', 'b')).toBe('a:b')
  })

  it('rejects a command outside the grantable set and a malformed member id', () => {
    expect(() => Config({ members: [{ id: 'alice', platform: 'x', commands: ['permission' as never] }] })).toThrow()
    expect(() => Config({ members: [{ id: 'Alice!', platform: 'x' }] })).toThrow()
  })

  it.each([
    [{ workspaceAliases: { a: 'relative' } }, 'absolute path'],
    [{ owners: [{ platform: 'x', userId: '1' }, { platform: 'x', userId: '1' }] }, 'more than once'],
    [{ owners: [{ platform: 'x', userId: '1', workspaces: ['ghost'] }] }, 'unknown workspace alias'],
    [{ members: [{ id: 'a', platform: 'x' }, { id: 'a', platform: 'x' }] }, 'member id a is configured more than once'],
    [{ members: [{ id: 'a', platform: 'x', userId: '1' }], owners: [{ platform: 'x', userId: '1' }] }, 'identity x:1'],
    [{ members: [{ id: 'a', platform: 'x', workspaces: ['ghost'] }] }, 'unknown workspace alias'],
    [{ members: [{ id: 'a', platform: 'x', dshRemoteHost: 'not-a-uuid' }] }, 'lowercase v4 UUID'],
  ])('refuses invalid configuration %j', (input, message) => {
    expect(() => { validateConfig(Config(input)) }).toThrow(message)
  })
})

describe('command table', () => {
  it('parses commands by their first token and treats every slash-led body as a command', () => {
    expect(parseInput('hello')).toEqual({ kind: 'text', text: 'hello' })
    expect(parseInput('  hello  ')).toEqual({ kind: 'text', text: 'hello' })
    expect(parseInput('/HELP')).toEqual({ kind: 'command', name: 'help', args: '' })
    expect(parseInput('/ask   two\nlines ')).toEqual({ kind: 'command', name: 'ask', args: 'two\nlines' })
    expect(parseInput('/pair-group')).toEqual({ kind: 'command', name: 'pair-group', args: '' })
    expect(parseInput('/etc/passwd please')).toEqual({ kind: 'unknown', name: 'etc/passwd' })
    expect(parseInput('/')).toEqual({ kind: 'unknown', name: '' })
    expect(parseInput('/toString')).toEqual({ kind: 'unknown', name: 'tostring' })
    expect(parseInput('/permission danger-full-access')).toEqual({ kind: 'unknown', name: 'permission' })
  })

  it('keeps the grantable rows and the configuration vocabulary identical', () => {
    const grantable = (Object.keys(COMMAND_TABLE) as CommandName[]).filter(name => COMMAND_TABLE[name].scope === 'grantable')
    expect(grantable.sort()).toEqual([...GRANTABLE_COMMANDS].sort())
    for (const forbidden of ['permission', 'context', 'export', 'supervision', 'reset', 'goal']) expect(Object.keys(COMMAND_TABLE)).not.toContain(forbidden)
  })

  it('authorizes by scope', () => {
    const owner = ownerActor({ platform: 'x', userId: '1', workspaces: [] })
    const grant = memberActor({ id: 'a', platform: 'x', commands: ['ask'], workspaces: [], answerOwnApprovals: false }, 'x', '2')
    expect(authorize(owner, 'invite')).toBeUndefined()
    expect(authorize(grant, 'invite')).toBe('owner-only')
    expect(authorize(grant, 'ask')).toBeUndefined()
    expect(authorize(grant, 'new')).toBe('not-granted')
    expect(authorize(grant, 'help')).toBeUndefined()
    expect(authorize(grant, 'approve')).toBeUndefined()
    expect(authorize(owner, 'pair')).toBe('already-paired')
    expect(helpText(owner)).toContain('/revoke <member>')
    expect(helpText(grant)).not.toContain('/revoke')
  })
})

describe('KeyedQueue', () => {
  it('serializes a key, overlaps different keys, survives failures, and reports phases', async () => {
    const phases: string[] = []
    const queue = new KeyedQueue({ start: key => phases.push(`+${key}`), end: key => phases.push(`-${key}`) })
    let running = 0
    let peak = 0
    const task = (label: string) => async (): Promise<string> => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 5))
      running -= 1
      return label
    }
    const same = await Promise.all([queue.run('a', task('1')), queue.run('a', task('2')), queue.run('a', task('3'))])
    expect(same).toEqual(['1', '2', '3'])
    expect(peak).toBe(1)
    await Promise.all([queue.run('a', task('x')), queue.run('b', task('y'))])
    expect(peak).toBe(2)
    await expect(queue.run('c', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(queue.run('c', () => Promise.resolve('fine'))).resolves.toBe('fine')
    expect(phases.filter(phase => phase.endsWith('c'))).toEqual(['+c', '-c', '+c', '-c'])
  })

  it('keys conversations by bot, kind, chat, and thread', () => {
    expect(conversationKey('b', { kind: 'direct', chatId: '1' })).toBe('b:direct:1')
    expect(conversationKey('b', { kind: 'group', chatId: '2', threadId: '3' })).toBe('b:group:2:3')
  })
})

describe('pending state', () => {
  const base: Omit<PendingApproval, 'id' | 'timer'> = { kind: 'approval', rpcId: 'r', approvalId: 'a', sessionId: 's', remoteHost: undefined, answerers: new Set<string>(), cards: [] }

  it('issues unique ids, times out, and removes entries', () => {
    vi.useFakeTimers()
    const table = new PendingTable()
    const expired: string[] = []
    const first = table.add<PendingApproval>({ ...base }, 100, entry => expired.push(entry.id))
    const second = table.add<PendingApproval>({ ...base }, 300, entry => expired.push(entry.id))
    expect(first.id).not.toBe(second.id)
    expect(table.get(first.id)).toBe(first)
    expect(table.filter(entry => entry.kind === 'approval')).toHaveLength(2)
    vi.advanceTimersByTime(100)
    expect(expired).toEqual([first.id])
    expect(table.take(second.id)).toBe(second)
    expect(table.take(second.id)).toBeUndefined()
    vi.advanceTimersByTime(1_000)
    expect(expired).toEqual([first.id])
    table.add<PendingApproval>({ ...base }, 100, entry => expired.push(entry.id))
    expect(table.clear()).toHaveLength(2)
    vi.advanceTimersByTime(1_000)
    expect(expired).toHaveLength(1)
  })

  const questions: QuestionItem[] = [
    { id: 'a', question: 'Pick', header: 'Color', detail: 'any', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }] },
    { id: 'b', question: 'Free text' },
  ]

  it('renders approval and question bodies with and without buttons', () => {
    const full = approvalBody('k1', { toolName: 'bash', argumentsJson: 'x'.repeat(400), reason: 'why', requester: 'alice', sessionLabel: 'abcd1234' }, false)
    expect(full).toContain('Approval needed for bash (session abcd1234, requested by alice).')
    expect(full).toContain(`Arguments: ${'x'.repeat(299)}…`)
    expect(full).toContain('Reply /approve k1 or /reject k1.')
    expect(approvalBody('k1', { toolName: 'bash', requester: 'a', sessionLabel: 's' }, true)).toBe('Approval needed for bash (session s, requested by a).')
    expect(questionBody('k2', questions, false)).toBe([
      'Q1. Color: Pick', 'any', '  1) Red - warm', '  2) Blue', 'Q2. Free text', 'Reply /answer k2 <answer 1> ; <answer 2>',
    ].join('\n'))
    expect(questionBody('k2', [{ id: 'q', question: 'Plain' }], true)).toBe('Q1. Plain')
  })

  it('parses one answer per question', () => {
    expect(parseAnswers(questions, '2 ; because')).toEqual({ answers: [{ id: 'a', selected: ['Blue'] }, { id: 'b', selected: [], custom: 'because' }] })
    expect(parseAnswers(questions, 'maybe ; ok')).toEqual({ answers: [{ id: 'a', selected: [], custom: 'maybe' }, { id: 'b', selected: [], custom: 'ok' }] })
    expect(parseAnswers(questions, '1')).toMatch(/Expected 2/)
    expect(parseAnswers(questions, '1 ;')).toMatch(/Expected 2/)
    expect(parseAnswers(questions, '0 ; x')).toMatch(/does not exist/)
  })
})

describe('helpers', () => {
  it('throws on an unreachable variant', () => {
    expect(() => assertNever('boom' as never)).toThrow('unreachable variant "boom"')
  })

  it('ends a timer sleep early when aborted', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const sleeping = timerSleep(60_000, controller.signal)
    controller.abort()
    await sleeping
    const plain = timerSleep(10)
    await vi.advanceTimersByTimeAsync(10)
    await plain
  })
})

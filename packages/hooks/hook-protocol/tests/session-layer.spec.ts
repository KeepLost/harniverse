import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  claudeCodeSessionGroups,
  foldSessionHooks,
  homeHookAdapterPath,
  inlineAdapterCommand,
  quoteHookCommandArgument,
  type SessionHookSpec,
} from '@deepseek-ai/dsh-hook-protocol'

const dirs: string[] = []
const priorHome = process.env.DSH_HOME
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (priorHome === undefined) Reflect.deleteProperty(process.env, 'DSH_HOME')
  else process.env.DSH_HOME = priorHome
})

const SPEC: SessionHookSpec = { name: 'ask-bash', event: 'pre_tool', matcher: '^bash', command: 'ask-human', timeoutSec: 30 }

describe('foldSessionHooks', () => {
  it('returns an empty set before any install', () => {
    const session = Session.create(SessionId('s'))
    session.append('turn/start', { turn: 1 })
    expect(foldSessionHooks(session.events)).toEqual([])
  })

  it('takes the last snapshot and returns a fresh array', () => {
    const session = Session.create(SessionId('s'))
    session.append('turn/start', { turn: 1 })
    session.append('hook/config', { hooks: [SPEC] })
    session.append('hook/config', { hooks: [] })
    expect(foldSessionHooks(session.events)).toEqual([])
    const session2 = Session.create(SessionId('s2'))
    session2.append('turn/start', { turn: 1 })
    session2.append('hook/config', { hooks: [SPEC], source: 'delegation' })
    const folded = foldSessionHooks(session2.events)
    expect(folded).toEqual([SPEC])
    const last = session2.events.at(-1)
    expect(last?.type).toBe('hook/config')
    if (last?.type === 'hook/config') expect(folded).not.toBe(last.data.hooks)
  })
})

describe('claudeCodeSessionGroups', () => {
  it('projects specs onto per-point matcher groups with adapter commands', () => {
    const groups = claudeCodeSessionGroups([
      SPEC,
      { name: 'log', event: 'prompt_submit', matcher: 'discarded', command: 'logger' },
      { name: 'slow', event: 'stop', command: 'halt', timeoutSec: 5 },
    ], '/home/adapter.mjs')
    expect(Object.keys(groups)).toEqual(['PreToolUse', 'UserPromptSubmit', 'Stop'])
    expect(groups.PreToolUse).toEqual([{ matcher: '^bash', hooks: [{ command: inlineAdapterCommand('/home/adapter.mjs', 'ask-human'), timeoutSec: 30 }] }])
    expect(groups.UserPromptSubmit).toEqual([{ hooks: [{ command: inlineAdapterCommand('/home/adapter.mjs', 'logger') }] }])
    expect(groups.Stop).toEqual([{ hooks: [{ command: inlineAdapterCommand('/home/adapter.mjs', 'halt'), timeoutSec: 5 }] }])
  })

  it('keeps install order within one point', () => {
    const groups = claudeCodeSessionGroups([
      { name: 'a', event: 'pre_tool', command: 'first' },
      { name: 'b', event: 'pre_tool', command: 'second' },
    ], '/a.mjs')
    expect((groups.PreToolUse ?? []).map(group => group.hooks[0]?.command)).toEqual([
      inlineAdapterCommand('/a.mjs', 'first'),
      inlineAdapterCommand('/a.mjs', 'second'),
    ])
  })
})

describe('adapter command helpers', () => {
  it('quotes arguments with embedded double quotes and backslashes', () => {
    expect(quoteHookCommandArgument('plain')).toBe('"plain"')
    expect(quoteHookCommandArgument('say "hi"')).toBe('"say \\"hi\\""')
    const backslashed = String.raw`printf "%s" "{\"x\":1}"`
    expect(quoteHookCommandArgument(backslashed)).toBe(String.raw`"printf \"%s\" \"{\\\"x\\\":1}\""`)
    expect(inlineAdapterCommand('/opt/a m.mjs', 'echo "x"'))
      .toBe('node "/opt/a m.mjs" --run "echo \\"x\\""')
  })

  it('resolves the home adapter under $DSH_HOME', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-session-layer-'))
    dirs.push(dir)
    process.env.DSH_HOME = dir
    expect(homeHookAdapterPath()).toBe(join(dir, 'hooks', 'tool-hooks-adapter.mjs'))
  })
})
